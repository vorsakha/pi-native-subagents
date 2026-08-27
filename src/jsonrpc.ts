import type { ManagedProcess } from "./process-tree.ts";
import { JsonlFramer, parseJsonRecord } from "./framing.ts";

type JsonRpcId = string | number;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class JsonRpcPeer {
  readonly #process: ManagedProcess;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #onNotification: (method: string, params: Record<string, unknown>) => void;
  readonly #onActivity: () => void;
  readonly #onRequest: (id: JsonRpcId, method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  readonly #requestId: () => JsonRpcId;
  readonly #onProtocolError: (error: Error) => void;
  readonly #records: string[] = [];
  #nextId = 1;
  #closed = false;
  #receiving = false;

  constructor(options: {
    process: ManagedProcess;
    onNotification?: (method: string, params: Record<string, unknown>) => void;
    onActivity?: () => void;
    onRequest?: (id: JsonRpcId, method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
    requestId?: () => JsonRpcId;
    maxFrameBytes?: number;
    onProtocolError?: (error: Error) => void;
  }) {
    this.#process = options.process;
    this.#onNotification = options.onNotification ?? (() => undefined);
    this.#onActivity = options.onActivity ?? (() => undefined);
    this.#onRequest = options.onRequest ?? (() => ({ decision: "decline" }));
    this.#requestId = options.requestId ?? (() => this.#nextId++);
    this.#onProtocolError = options.onProtocolError ?? (() => undefined);
    const framer = new JsonlFramer(options.maxFrameBytes);
    this.#process.child.stdout.on("data", (chunk: Buffer) => {
      try { this.#enqueue(framer.push(chunk)); } catch (error) { this.#protocolFailure(error); }
    });
    this.#process.child.stdout.on("end", () => {
      try { this.#enqueue(framer.end()); } catch (error) { this.#protocolFailure(error); }
    });
    // Provider stderr has no safe schema and may contain credentials. Drain it
    // so a noisy child cannot block, but never retain it in transport errors.
    this.#process.child.stderr.resume();
    this.#process.child.stdin.on("error", (error) => {
      this.#closed = true;
      this.#failPending(new Error(`JSON-RPC stdin failed: ${error.message}`));
      void this.#process.terminate();
    });
    this.#process.child.on("error", (error) => {
      this.#closed = true;
      this.#failPending(new Error(`JSON-RPC process failed: ${error.message}`));
    });
    this.#process.child.on("close", (code, signal) => {
      this.#closed = true;
      const error = new Error(`JSON-RPC process exited (${code ?? signal ?? "signal"})`);
      this.#failPending(error);
    });
  }

  request(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("JSON-RPC process is closed"));
    const id = this.#requestId();
    if (typeof id !== "number" && typeof id !== "string") return Promise.reject(new Error("JSON-RPC request id must be a string or number"));
    if (this.#pending.has(id)) return Promise.reject(new Error(`Duplicate JSON-RPC request id: ${String(id)}`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    if (!this.#closed) this.#write({ method, params });
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#failPending(new Error("JSON-RPC peer closed"));
    }
    await this.#process.terminate();
  }

  #write(value: unknown): void {
    if (this.#closed || this.#process.child.stdin.destroyed || !this.#process.child.stdin.writable) {
      throw new Error("JSON-RPC process is closed");
    }
    this.#process.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  /**
   * Process one framed record per microtask. A response settles its request
   * promise before the next wire-ordered notification runs, even when the OS
   * delivered both records in one stdout chunk.
   */
  #enqueue(records: string[]): void {
    this.#records.push(...records);
    if (this.#receiving || this.#records.length === 0) return;
    this.#receiving = true;
    this.#receiveNext();
  }

  #receiveNext(): void {
    const record = this.#records.shift();
    if (record === undefined || this.#closed) {
      this.#records.length = 0;
      this.#receiving = false;
      return;
    }
    this.#receive(record);
    if (this.#records.length === 0) {
      this.#receiving = false;
      return;
    }
    queueMicrotask(() => this.#receiveNext());
  }

  #receive(record: string): void {
    const message = parseJsonRecord(record);
    if (!message) {
      if (record.trim()) this.#protocolFailure(new Error("invalid JSON object"));
      return;
    }
    try { this.#onActivity(); } catch { /* activity observers cannot break protocol handling */ }
    if ((typeof message.id === "number" || typeof message.id === "string") && !("method" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(jsonRpcError(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = object(message.params);
    if (typeof message.id === "number" || typeof message.id === "string") {
      const id = message.id;
      void Promise.resolve()
        .then(() => this.#onRequest(id, message.method as string, params))
        .then(
          (result) => { if (!this.#closed) this.#write({ id, result }); },
          (error) => { if (!this.#closed) this.#write({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }); },
        )
        .catch((error) => this.#protocolFailure(error));
      return;
    }
    this.#onNotification(message.method, params);
  }

  #protocolFailure(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    const failure = new Error(`JSON-RPC framing failed: ${error instanceof Error ? error.message : String(error)}`);
    this.#failPending(failure);
    try { this.#onProtocolError(failure); } catch { /* observers cannot break teardown */ }
    void this.#process.terminate();
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonRpcError(value: unknown): string {
  const error = object(value);
  return typeof error.message === "string" ? error.message : JSON.stringify(value);
}

export function asObject(value: unknown): Record<string, unknown> {
  return object(value);
}
