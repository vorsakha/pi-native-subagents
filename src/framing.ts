import { StringDecoder } from "node:string_decoder";

export const MAX_JSONL_FRAME_BYTES = 16 * 1024 * 1024;

export class JsonlFramer {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxFrameBytes: number;
  #buffer = "";

  constructor(maxFrameBytes = MAX_JSONL_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new Error("JSONL frame limit must be a positive safe integer");
    this.#maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    const records: string[] = [];
    for (;;) {
      const index = this.#buffer.indexOf("\n");
      if (index < 0) break;
      let record = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (record.endsWith("\r")) record = record.slice(0, -1);
      this.#assertBounded(record);
      records.push(record);
    }
    this.#assertBounded(this.#buffer);
    return records;
  }

  end(chunk?: Buffer | string): string[] {
    if (chunk !== undefined) this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(chunk);
    this.#buffer += this.#decoder.end();
    if (!this.#buffer) return [];
    let final = this.#buffer;
    this.#buffer = "";
    if (final.endsWith("\r")) final = final.slice(0, -1);
    this.#assertBounded(final);
    return [final];
  }

  #assertBounded(value: string): void {
    const bytes = Buffer.byteLength(value);
    if (bytes > this.#maxFrameBytes) {
      this.#buffer = "";
      throw new Error(`JSONL frame exceeds ${this.#maxFrameBytes} bytes`);
    }
  }
}

export function parseJsonRecord(record: string): Record<string, unknown> | undefined {
  if (!record.trim()) return undefined;
  try {
    const value: unknown = JSON.parse(record);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
