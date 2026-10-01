import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ToolGate,
  untilAborted,
  LiveCallBudget,
  validateRuntimeConfig,
  type GateDecision,
  type GateRequest,
  type RuntimeConfig,
} from "@mia/agent-adapter";
import { ApprovalBridge, ClaudeCodeSessions } from "@mia/claude-code-adapter";
import { FixtureHarness, startFixture } from "@mia/controlled-mcp";
import { redactValue } from "@mia/protocol";
import type { ProbeDeadlines, ProbeOptions, SessionRecord, SessionSpec } from "./record.ts";

export const log = (...args: unknown[]) => console.log(`[probe]`, ...args);

/** How many events, and how many gate requests, one session's record keeps; past it they are only counted. */
const MAX_RECORDED = 10_000;

/**
 * Owns one probe run's evidence directory, fixture, tool gate, approval bridge and live-call budget, and the records
 * of every session run so far. `close` releases the fixture, gate and bridge.
 */
export class ProbeContext {
  readonly sessions: SessionRecord[] = [];
  /** Woken after each event or gate request the running session records; see `waitUntil`. */
  private readonly eventWaiters = new Set<() => void>();

  private constructor(
    readonly options: ProbeOptions,
    readonly dirs: { out: string; fixture: string },
    private readonly services: {
      budget: LiveCallBudget;
      fixture: Awaited<ReturnType<typeof startFixture>>;
      harness: FixtureHarness;
      bridge: ApprovalBridge;
      gate: ToolGate;
      deadlines: ProbeDeadlines;
      env: NodeJS.ProcessEnv;
    },
  ) {}

  static async start(
    options: ProbeOptions,
    env: NodeJS.ProcessEnv,
    deadlines: ProbeDeadlines,
  ): Promise<ProbeContext> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = resolve(options.out, stamp);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    const budget = LiveCallBudget.fromEnv(env, resolve(".mia-state/live-calls.jsonl"));
    const fixtureDir = join(out, "fixture");
    const fixture = await startFixture({ dir: fixtureDir, mcpLogFile: env.MIA_MCP_HTTP_LOG });
    const harness = new FixtureHarness(fixture.harnessUrl);
    const bridge = new ApprovalBridge({ logFile: env.MIA_MCP_HTTP_LOG });
    const gate = new ToolGate();
    try {
      await bridge.start();
      await gate.start();
    } catch (error) {
      await gate.close();
      await bridge.close();
      await fixture.close();
      throw error;
    }
    return new ProbeContext(
      options,
      { out, fixture: fixtureDir },
      { budget, fixture, harness, bridge, gate, deadlines, env },
    );
  }

  get harness(): FixtureHarness {
    return this.services.harness;
  }

  get deadlines(): ProbeDeadlines {
    return this.services.deadlines;
  }

  /** The probe process's environment, which every runtime it launches inherits. */
  get env(): NodeJS.ProcessEnv {
    return this.services.env;
  }

  /** Counts one live runtime call against the shared budget and logs it; throws once the cap is reached. */
  takeLiveCall(label: string, model: string): void {
    const { budget } = this.services;
    const callNumber = budget.takeSync(`probe:${label}`, model);
    log(`step ${label} (live call ${callNumber}/${budget.cap})`);
  }

  liveCallsUsed(): number {
    return this.services.budget.usedSync();
  }

  /** Closes the gate, the bridge and the fixture, the fixture even when closing the others fails. */
  async close(): Promise<void> {
    try {
      await this.services.gate.close();
      await this.services.bridge.close();
    } finally {
      await this.services.fixture.close();
    }
  }

  /**
   * Resolves true once `test` holds, or false once `signal` aborts first. It is checked again after every event or
   * gate request the running session records.
   */
  async waitUntil(test: () => boolean, signal: AbortSignal): Promise<boolean> {
    while (!test()) {
      if (signal.aborted) return false;
      const next = Promise.withResolvers<undefined>();
      const wake = () => next.resolve(undefined);
      this.eventWaiters.add(wake);
      signal.addEventListener("abort", wake, { once: true });
      try {
        await next.promise;
      } finally {
        this.eventWaiters.delete(wake);
        signal.removeEventListener("abort", wake);
      }
    }
    return true;
  }

  private wakeWaiters(): void {
    for (const wake of [...this.eventWaiters]) wake();
  }

  wants(name: string): boolean {
    return !this.options.only || this.options.only.split(",").includes(name);
  }

  baseConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
    return {
      kind: "claude-code",
      executable: "claude",
      model: this.options.model,
      effort: "medium",
      workingDirectory: join(this.dirs.out, "work"),
      mcpServers: { fixture: { type: "http", url: this.services.fixture.mcpUrl } },
      toolPolicy: {
        mcp__fixture__read: "allow",
        mcp__fixture__change: "ask",
        mcp__fixture__slow: "ask",
        mcp__fixture__artifact: "ask",
        mcp__fixture__forbidden: "deny",
      },
      agentPromptFile: resolve("prompts/manager-v2.md"),
      workerAgent: {
        description:
          "Runs one task that needs tools, calling exactly the tools the task names. Use it for every tool call.",
        promptFile: resolve("prompts/worker-v1.md"),
      },
      exclusiveTools: [],
      outputDirectories: [join(this.dirs.fixture, "artifacts")],
      env: {},
      extraSettings: {},
      ...overrides,
    };
  }

  save(name: string, data: unknown): void {
    writeFileSync(join(this.dirs.out, `${name}.json`), JSON.stringify(redactValue(data), null, 2), {
      mode: 0o600,
    });
  }

  /**
   * One manager agent's session against the real runtime, counted as one live call however many turns it runs:
   * every tool call is decided through the gate by `spec.decide`, and `spec.drive` runs the session.
   */
  async runSession(spec: SessionSpec): Promise<SessionRecord> {
    validateRuntimeConfig(spec.config);
    const sessionId = randomUUID();
    const session: SessionRecord = {
      name: spec.name,
      session_id: sessionId,
      events: [],
      gate_requests: [],
      dropped: 0,
      bridge_requests: 0,
      result: null,
      ledger_after: null,
      notes: [],
      checks: {},
    };
    const { bridge, gate, harness } = this.services;
    this.takeLiveCall(spec.name, spec.config.model);
    const workerPrompt = await readFile(spec.config.workerAgent.promptFile, "utf8");
    bridge.setHandler(async () => {
      session.bridge_requests += 1;
      return { behavior: "deny", message: "Mia decides every call through its gate." };
    });
    // A killed session's held calls are answered only once the gate sees their hooks go away, after the session
    // has ended; the record is saved once every decision is in.
    const deciding = new Set<Promise<unknown>>();
    const decide = async (request: GateRequest): Promise<GateDecision> => {
      const eventIndex = session.events.length;
      session.notes.push(`gate asked: ${request.toolName} by ${request.agentId ?? "manager"}`);
      this.wakeWaiters();
      const decision = await spec.decide(request, session);
      const { abandoned, ...seen } = request;
      if (session.gate_requests.length >= MAX_RECORDED) {
        session.dropped += 1;
        return decision;
      }
      session.gate_requests.push({
        request: seen,
        decision,
        abandoned: abandoned.aborted,
        event_index: eventIndex,
      });
      log("gate", request.toolName, request.agentId ?? "manager", "->", decision.behavior);
      return decision;
    };
    try {
      const handle = new ClaudeCodeSessions(spec.config, { gate, bridge }, this.services.env).open({
        runtimeConversationId: sessionId,
        resume: false,
        runtimeDir: join(this.dirs.out, "runtime", sessionId),
        sessionIndex: 1,
        managerPromptFile: spec.config.agentPromptFile,
        workerPrompt,
        decide: (request) => {
          const decided = decide(request);
          deciding.add(decided);
          void decided.finally(() => deciding.delete(decided)).catch(() => undefined);
          return decided;
        },
        onEvent: async (event) => {
          if (session.events.length < MAX_RECORDED) session.events.push(event);
          else session.dropped += 1;
          this.wakeWaiters();
          if (event.type === "text_delta" && event.parentCallId === null)
            process.stdout.write(event.text);
          else if (event.type !== "assistant_message" && event.type !== "text_delta")
            log(event.type, "runtimeTaskId" in event ? event.runtimeTaskId : "");
        },
      });
      try {
        await spec.drive({ handle, send: (text) => handle.send(text, randomUUID()) }, session);
      } finally {
        handle.close();
      }
      session.result = await handle.result;
      await untilAborted(
        () => Promise.allSettled([...deciding]),
        this.services.deadlines.ledgerSettled(),
        () => [],
      );
    } finally {
      bridge.setHandler(null);
    }
    process.stdout.write("\n");
    session.ledger_after = await harness.state();
    this.sessions.push(session);
    this.save(`session-${spec.name}`, session);
    return session;
  }
}
