import { randomBytes, timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlFramer, parseJsonRecord } from "./framing.ts";
import {
  InteractionError,
  normalizeContext,
  normalizeQuestion,
  normalizeTarget,
  type InteractionHandler,
} from "./interactions.ts";

/**
 * Live, authenticated request/response bridge for Pi children.
 *
 * A Pi child runs in its own process, so unlike the Claude and Codex adapters
 * it cannot call the host callback directly. A static snapshot file (the
 * `parent_thread` pattern) is wrong here because an interaction is a live
 * exchange, not spawn-time data. This is a per-job loopback socket bound to a
 * private directory, gated by a single-use-per-job random token, and it exposes
 * exactly one operation.
 */
const MAX_BRIDGE_FRAME_BYTES = 64 * 1024;
const BRIDGE_TOKEN_BYTES = 32;

export interface InteractionBridge {
  address: string;
  token: string;
  close(): Promise<void>;
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== "string") return false;
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function socketPath(dir: string, jobId: string): string {
  const name = `ask-${jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12) || "job"}.sock`;
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-native-subagents-${jobId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24)}-${randomBytes(6).toString("hex")}`
    : join(dir, name);
}

/**
 * Opens the bridge for one authorized job. The returned address/token pair is
 * handed to that child only; every other connection or frame is refused.
 */
export async function openInteractionBridge(
  jobId: string,
  handler: InteractionHandler,
): Promise<InteractionBridge> {
  const dir = process.platform === "win32" ? "" : await mkdtemp(join(tmpdir(), "pi-subagent-ask-"));
  const address = socketPath(dir, jobId);
  const token = randomBytes(BRIDGE_TOKEN_BYTES).toString("hex");
  const sockets = new Set<Socket>();

  const handleFrame = async (socket: Socket, record: string): Promise<void> => {
    const message = parseJsonRecord(record);
    // An unauthenticated or malformed frame gets no protocol detail back: it is
    // not a caller this bridge has any reason to help.
    if (!message || !tokenMatches(token, message.token)) {
      socket.destroy();
      return;
    }
    const id = typeof message.id === "string" ? message.id : "";
    const reply = (payload: Record<string, unknown>) => {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify({ id, ...payload })}\n`);
    };
    if (message.type !== "ask") {
      reply({ ok: false, error: `Unsupported interaction bridge operation: ${String(message.type ?? "unknown")}` });
      return;
    }
    try {
      const result = await handler.ask({
        question: normalizeQuestion(message.question),
        context: normalizeContext(message.context),
        target: normalizeTarget(message.target),
      });
      reply({ ok: true, answer: result.answer, requestId: result.requestId, route: result.route, answeredBy: result.answeredBy });
    } catch (error) {
      reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    const framer = new JsonlFramer(MAX_BRIDGE_FRAME_BYTES);
    socket.on("data", (chunk: Buffer) => {
      let records: string[];
      try { records = framer.push(chunk); }
      catch { socket.destroy(); return; }
      for (const record of records) void handleFrame(socket, record);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    address,
    token,
    async close() {
      for (const socket of [...sockets]) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface InteractionBridgeAnswer {
  answer: string;
  requestId?: string;
  answeredBy?: string;
}

/**
 * Child-side single-shot call. Each question opens its own connection so a
 * stalled or half-closed socket can never leak across turns.
 */
export function askThroughInteractionBridge(
  options: { address: string; token: string; question: string; context?: string; target: unknown },
): Promise<InteractionBridgeAnswer> {
  return new Promise<InteractionBridgeAnswer>((resolve, reject) => {
    const framer = new JsonlFramer(MAX_BRIDGE_FRAME_BYTES);
    let settled = false;
    const socket = createConnection(options.address);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };
    socket.on("error", (error: Error) => finish(() => reject(new InteractionError(`Interaction bridge is unavailable: ${error.message}`))));
    socket.on("close", () => finish(() => reject(new InteractionError("Interaction bridge closed before answering"))));
    socket.on("data", (chunk: Buffer) => {
      let records: string[];
      try { records = framer.push(chunk); }
      catch (error) { finish(() => reject(error instanceof Error ? error : new Error(String(error)))); return; }
      for (const record of records) {
        const message = parseJsonRecord(record);
        if (!message) continue;
        if (message.ok === true && typeof message.answer === "string") {
          finish(() => resolve({
            answer: message.answer as string,
            requestId: typeof message.requestId === "string" ? message.requestId : undefined,
            answeredBy: typeof message.answeredBy === "string" ? message.answeredBy : undefined,
          }));
          return;
        }
        finish(() => reject(new InteractionError(String(message.error ?? "The host rejected this question"))));
        return;
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({
        token: options.token,
        id: "ask",
        type: "ask",
        question: options.question,
        context: options.context,
        target: options.target,
      })}\n`);
    });
  });
}
