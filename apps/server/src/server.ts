import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  ApprovalBridge,
  ClaudeCodeSessions,
  ToolGate,
  loadProfileSync,
  probeStaticCapabilitiesSync,
  readRuntimeFile,
  type Profile,
  type RuntimeFileReader,
} from "@mia/agent-adapter";
import { errorMessage } from "@mia/protocol";
import { Catalog, RecordWriter, newId, type NewId } from "@mia/records";
import { collectArtifact, type ArtifactCollector } from "./artifact-collector.ts";
import { collectBuildInfoSync } from "./build-info.ts";
import { Engine, type SessionRunner } from "./engine.ts";
import { startGateway, type GatewayHandle } from "./gateway.ts";
import type { ServerIdentity } from "./provenance.ts";

export interface MiaServer {
  profile: Profile;
  gateway: GatewayHandle;
  /** D1's engine, or D2's when the profile defines a worker agent. */
  engine: Engine;
  catalog: Catalog;
  bridge: ApprovalBridge;
  /**
   * Shut down: stop accepting commands, interrupt the active turn and wait for it until `turnWait` aborts,
   * close the gateway (waiting, until `turnWait` aborts, for commands still storing their replies) and the bridge,
   * then close the catalog. Every step runs even when an earlier one fails,
   * and the returned promise rejects with all their errors only after the last. Memoised: a second call (a
   * SIGTERM after a SIGINT) awaits the first run and sees its outcome; its own `turnWait` is not used.
   */
  close(turnWait: AbortSignal): Promise<void>;
}

/**
 * The turn wait an entry point should give `close`: longer than the adapter takes to kill a runtime and
 * observe its exit, so a killed turn is normally recorded before the catalog closes.
 */
export const SHUTDOWN_TURN_WAIT_MS = 10_000;

/**
 * The evidence read deadline an entry point should give `startServer`: how long a finished turn's evidence reads may
 * take before the turn is recorded without that evidence, and how long a conversation start's reads and stores may
 * take before the start is refused. A transcript on a healthy disk reads in milliseconds; only a read that never
 * returns (a regular file on a stale mount; a FIFO is refused without being read) reaches this. Until it does, a
 * turn-end read refuses every submission as busy, and a start's read refuses every other start as busy.
 */
export const EVIDENCE_READ_TIMEOUT_MS = 10_000;

/**
 * The stop deadline an entry point should give `startServer`: how long a killed session may take to be seen exiting
 * before its cancellation is recorded unknown and the session is given up on.
 */
export const STOP_WAIT_MS = 5_000;

/**
 * The attribution deadline an entry point should give `startServer`: how long a worker agent's call may wait for the
 * runtime's report of that worker agent's start, which can trail the call by the time stdout takes to be read.
 */
export const ATTRIBUTION_WAIT_MS = 5_000;

export const SOURCE_ROOT = resolve(import.meta.dirname, "..", "..", "..");

const resolveProfileSync = (input: {
  profilePath?: string;
  profile?: Profile;
  env: NodeJS.ProcessEnv;
}): Profile => {
  if (input.profile) return input.profile;
  if (input.profilePath !== undefined) return loadProfileSync(input.profilePath, input.env);
  throw new Error("startServer needs a profile or a profilePath");
};

export const startServer = async (input: {
  profilePath?: string;
  profile?: Profile;
  /** Runs the manager agent's sessions; defaults to `ClaudeCodeSessions`. A test injects a scripted runtime. */
  sessions?: SessionRunner;
  log?: (message: string) => void;
  /**
   * Fresh deadlines, built by the entry point (a test passes signals it aborts itself): for each batch of evidence
   * reads and stores (`EVIDENCE_READ_TIMEOUT_MS`), for observing a killed session exit (`STOP_WAIT_MS`), and for a
   * worker agent's call waiting for its start's report (`ATTRIBUTION_WAIT_MS`).
   */
  evidenceReadDeadline: () => AbortSignal;
  stopDeadline: () => AbortSignal;
  attributionDeadline: () => AbortSignal;
  /**
   * Reads a session's evidence and a starting conversation's prompts and architecture document; defaults to
   * `readRuntimeFile`. A test injects one that holds a read.
   */
  readEvidence?: RuntimeFileReader;
  /** Captures a declared tool output; defaults to `collectArtifact`. A test injects one that holds a capture. */
  collectArtifact?: ArtifactCollector;
  /** The clock the engine stamps its records and events with, and acks read; defaults to the system clock. */
  now?: () => Date;
  /** Names what the engine records (see `EngineDeps.newId`); defaults to `newId`. A test injects one that checks when it is called. */
  newId?: NewId;
  /** The UUID each message is sent to the runtime under; defaults to `randomUUID`. */
  newRuntimeMessageId?: () => string;
  /** Debug mode (see `EngineDeps.debugMode`); off unless the entry point was asked for it. */
  debugMode?: boolean;
  /**
   * The server process's environment: fills a profile's `${ENV}` placeholders, is what the runtime
   * inherits and is probed with at startup, and names the bridge's request log (`MIA_MCP_HTTP_LOG`).
   * The entry point passes its own.
   */
  env: NodeJS.ProcessEnv;
}): Promise<MiaServer> => {
  // eslint-disable-next-line no-restricted-syntax -- runs before serving
  const profile = resolveProfileSync(input);
  const log = input.log ?? ((message: string) => process.stderr.write(`[mia-server] ${message}\n`));
  const identity: ServerIdentity = {
    // eslint-disable-next-line no-restricted-syntax -- runs before serving
    runtime: probeStaticCapabilitiesSync(profile.runtime, input.env),
    // eslint-disable-next-line no-restricted-syntax -- runs before serving
    build: collectBuildInfoSync("mia-server", SOURCE_ROOT),
  };
  // eslint-disable-next-line no-restricted-syntax -- runs before serving
  mkdirSync(profile.stateDirectory, { recursive: true, mode: 0o700 });
  // Acquire in order; on any throw release what is already held, in reverse, before rethrowing.
  // eslint-disable-next-line no-restricted-syntax -- runs before serving
  const catalog = Catalog.openSync(profile.stateDirectory);
  try {
    const writer = new RecordWriter(catalog);
    const now = input.now ?? (() => new Date());
    const bridge = new ApprovalBridge({ logFile: input.env.MIA_MCP_HTTP_LOG });
    await bridge.start();
    const gate = new ToolGate();
    try {
      await gate.start();
      const engine = new Engine({
        profile,
        catalog,
        writer,
        identity,
        sessions:
          input.sessions ?? new ClaudeCodeSessions(profile.runtime, { gate, bridge }, input.env),
        evidenceReadDeadline: input.evidenceReadDeadline,
        stopDeadline: input.stopDeadline,
        attributionDeadline: input.attributionDeadline,
        readEvidence: input.readEvidence ?? readRuntimeFile,
        collectArtifact: input.collectArtifact ?? collectArtifact,
        newId: input.newId ?? newId,
        newRuntimeMessageId: input.newRuntimeMessageId ?? randomUUID,
        now,
        debugMode: input.debugMode ?? false,
        log,
      });
      const gateway = await startGateway({
        host: profile.server.host,
        port: profile.server.port,
        secretFile: profile.server.secretFile,
        engine,
        writer,
        now,
        log,
      });
      log(
        `listening on ${gateway.url} (profile ${profile.profile}, model ${profile.runtime.model}, effort ${profile.runtime.effort})`,
      );
      let shutdownStarted: Promise<void> | null = null;
      const shutdown = async (turnWait: AbortSignal) => {
        const errors: unknown[] = [];
        const step = async (release: () => Promise<void> | void) => {
          try {
            await release();
          } catch (error) {
            errors.push(error);
          }
        };
        // In this order: the turn must finish before the catalog that records it closes, and the gateway
        // closes after the turn so the interruption still reaches the client.
        await step(() => engine.shutdown(turnWait));
        await step(() => gateway.close(turnWait));
        await step(() => gate.close());
        await step(() => bridge.close());
        await step(() => catalog.close());
        if (errors.length > 0)
          throw new AggregateError(
            errors,
            `shutdown failed: ${errors.map((error) => errorMessage(error)).join("; ")}`,
          );
      };
      return {
        profile,
        gateway,
        engine,
        catalog,
        bridge,
        // Memoised: SIGINT then SIGTERM must await the one shutdown, not release these resources twice.
        close: (turnWait) => (shutdownStarted ??= shutdown(turnWait)),
      };
    } catch (error) {
      await gate.close();
      await bridge.close();
      throw error;
    }
  } catch (error) {
    catalog.close();
    throw error;
  }
};
