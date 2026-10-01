import { errorMessage } from "@mia/protocol";

/** How many of Mia's requests may await their answer at once; Mia makes a few at a time, so more is a fault. */
const MAX_PENDING_REQUESTS = 64;

export class RpcError extends Error {
  override readonly name = "RpcError";
}

/**
 * Mia's side of one `codex app-server` JSON-RPC connection: it numbers Mia's requests, settles each from the
 * server's response, and writes answers to the server's own requests. It owns the requests in flight; the session
 * owns the process and hands it every response it reads.
 */
export class CodexConnection {
  #nextId = 0;
  readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
  #closed: string | null = null;

  /** `write` writes one line to the server's stdin, returning false once it no longer can. */
  constructor(private readonly write: (line: string) => boolean) {}

  /** Resolves to the request's result, or rejects with the server's error, or once the connection closes. */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed !== null) return Promise.reject(new RpcError(`${method}: ${this.#closed}`));
    if (this.#pending.size >= MAX_PENDING_REQUESTS)
      return Promise.reject(new RpcError(`${method}: too many requests in flight`));
    this.#nextId += 1;
    const id = this.#nextId;
    const answer = Promise.withResolvers<unknown>();
    this.#pending.set(id, answer);
    if (!this.write(JSON.stringify({ id, method, params }))) {
      this.#pending.delete(id);
      return Promise.reject(new RpcError(`${method}: the server no longer reads input`));
    }
    return answer.promise.catch((error: unknown) => {
      throw new RpcError(`${method}: ${errorMessage(error)}`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  /** Answers one of the server's own requests. */
  respond(id: string | number, result: unknown): void {
    this.write(JSON.stringify({ id, result }));
  }

  /** Refuses one of the server's own requests that Mia does not serve. */
  refuse(id: string | number, message: string): void {
    this.write(JSON.stringify({ id, error: { code: -32601, message } }));
  }

  /** Settles the request a response answers; a response to no pending request is ignored. */
  settle(response: { id: string | number; result: unknown; error: string | null }): void {
    if (typeof response.id !== "number") return;
    const answer = this.#pending.get(response.id);
    if (!answer) return;
    this.#pending.delete(response.id);
    if (response.error === null) answer.resolve(response.result);
    else answer.reject(new Error(response.error));
  }

  /** Fails every request in flight, and every later one, with `reason`: the server is gone. */
  close(reason: string): void {
    this.#closed ??= reason;
    for (const answer of this.#pending.values()) answer.reject(new Error(reason));
    this.#pending.clear();
  }
}
