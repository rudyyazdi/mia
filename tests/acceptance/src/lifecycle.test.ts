import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startServer } from "@mia/server";
import type { TaskStatus } from "@mia/protocol";
import { Catalog } from "@mia/records";
import { ackError, ackResult, startTestServer, testProfile } from "./harness.ts";
import { ScriptedSessions, type ScriptedSession } from "./scripted-session.ts";

/** Listening TCP servers this process owns: a socket nobody closed is still counted here. */
const listeningServers = (): number =>
  process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;

const listenOnFreePort = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("blocking server did not bind a TCP port");
  return { server, port: address.port };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolveClosed) => server.close(() => resolveClosed()));

/** A turn wait that never aborts: the test itself decides when the turn ends. */
const unbounded = (): AbortSignal => new AbortController().signal;

describe("server lifecycle", () => {
  it("releases the catalog and the approval bridge when the gateway cannot bind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-lifecycle-"));
    const blocker = await listenOnFreePort();
    const profile = testProfile(
      dir,
      {},
      {
        server: {
          host: "127.0.0.1",
          port: blocker.port,
          secretFile: join(dir, "state", "client-secret"),
        },
      },
    );
    try {
      const before = listeningServers();
      expect(before).toBeGreaterThan(0); // the blocker itself, so the count below means something

      await expect(
        startServer({
          profile,
          sessions: new ScriptedSessions(),
          log: () => undefined,
          evidenceReadDeadline: unbounded,
          stopDeadline: unbounded,
          attributionDeadline: unbounded,
          env: {},
        }),
      ).rejects.toThrow();

      // The catalog is usable again right away: nothing holds the database open.
      const catalog = Catalog.openSync(profile.stateDirectory);
      expect(catalog.nextSequence("conversation-that-does-not-exist")).toBe(1);
      catalog.close();

      // No extra listener survived the failed start, so the bridge is not still bound.
      await expect.poll(listeningServers, { timeout: 5_000 }).toBe(before);
    } finally {
      await closeServer(blocker.server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs approval bridge requests to the MIA_MCP_HTTP_LOG of the environment it is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-lifecycle-"));
    const logFile = join(dir, "bridge-requests.jsonl");
    try {
      const server = await startServer({
        profile: testProfile(dir),
        sessions: new ScriptedSessions(),
        log: () => undefined,
        evidenceReadDeadline: unbounded,
        stopDeadline: unbounded,
        attributionDeadline: unbounded,
        env: { MIA_MCP_HTTP_LOG: logFile },
      });
      try {
        // The bridge refuses a GET, and logs the refusal.
        const response = await fetch(server.bridge.url, { signal: AbortSignal.timeout(5_000) });
        expect(response.status).toBe(405);
      } finally {
        await server.close(unbounded());
      }
      // The log is written in the background; closing the server writes out what is queued.
      const entries: unknown[] = readFileSync(logFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(entries).toEqual([expect.objectContaining({ ev: "request", http: "GET" })]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves close() on every call, not only the first", async () => {
    const testServer = await startTestServer(new ScriptedSessions());
    try {
      await expect(testServer.server.close(unbounded())).resolves.toBeUndefined();
      await expect(testServer.server.close(unbounded())).resolves.toBeUndefined();
    } finally {
      await testServer.close();
    }
  });

  it("closes the bridge and the catalog when closing the gateway fails, and every caller sees that failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mia-lifecycle-"));
    try {
      const server = await startServer({
        profile: testProfile(dir),
        sessions: new ScriptedSessions(),
        log: () => undefined,
        evidenceReadDeadline: unbounded,
        stopDeadline: unbounded,
        attributionDeadline: unbounded,
        env: {},
      });
      const bridgeUrl = server.bridge.url;
      const closeGateway = server.gateway.close;
      let gatewayCloses = 0;
      const gatewayFailure = new Error("simulated gateway close failure");
      server.gateway.close = async (commandWait) => {
        gatewayCloses += 1;
        await closeGateway(commandWait); // release the port for real, so the failure is all this test adds
        throw gatewayFailure;
      };

      // SIGINT, then SIGTERM before the first shutdown has finished.
      const first = server.close(unbounded());
      const second = server.close(unbounded());

      const failure: unknown = await first.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ errors: [gatewayFailure] });
      await expect(second).rejects.toBe(failure);
      expect(gatewayCloses).toBe(1);
      expect(server.catalog.db.isOpen).toBe(false);
      await expect(fetch(bridgeUrl, { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shutdown with work running", () => {
  it("stops every task, refuses commands while the session dies, and closes only once its end is recorded", async () => {
    const sessions = new ScriptedSessions();
    const testServer = await startTestServer(sessions);
    let session: ScriptedSession | null = null;
    try {
      const client = await testServer.connect("client-A");
      await client.startConversation();
      ackResult(await client.submitText("hello"));
      session = await sessions.session();
      await session.beginTurn(0);
      await session.delegate("a1");
      session.exitsOnStop = false; // the session dies only when the test lets it

      let closed = false;
      const closing = testServer.server.close(unbounded()).then(() => {
        closed = true;
      });
      const requested = await client.waitFor("interruption_requested");
      expect(session.stopped).toBe(true);
      expect(ackError(await client.submitText("another"))).toMatchObject({
        code: "invalid_state",
        message: "the server is shutting down",
      });
      expect(closed).toBe(false);

      session.exitAfterStop();
      await closing;
      const catalog = testServer.catalog();
      try {
        expect(
          catalog.get<{ status: TaskStatus }>(
            "SELECT status FROM tasks WHERE id = ?",
            requested.payload.task_id,
          ),
        ).toEqual({ status: "interrupted" });
      } finally {
        catalog.close();
      }
    } finally {
      session?.exitAfterStop(); // a failed assertion must not leave the shutdown waiting forever
      await testServer.close();
    }
  });
});
