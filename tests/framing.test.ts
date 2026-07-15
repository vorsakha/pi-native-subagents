import test from "node:test";
import assert from "node:assert/strict";
import { JsonlFramer, parseJsonRecord } from "../src/framing.ts";

test("JSONL framer accepts split UTF-8 and CRLF but only LF delimits records", () => {
  const framer = new JsonlFramer();
  const text = '{"text":"a\u2028b 😀"}\r\n{"n":2}\n';
  const bytes = Buffer.from(text);
  const records = [
    ...framer.push(bytes.subarray(0, 13)),
    ...framer.push(bytes.subarray(13, bytes.length - 2)),
    ...framer.push(bytes.subarray(bytes.length - 2)),
    ...framer.end(),
  ];
  assert.deepEqual(records, ['{"text":"a b 😀"}', '{"n":2}']);
  assert.equal(parseJsonRecord(records[0]!)?.text, "a b 😀");
});

test("JSONL framer flushes a final unterminated record and parser rejects invalid records", () => {
  const framer = new JsonlFramer();
  assert.deepEqual(framer.push('{"ok":'), []);
  assert.deepEqual(framer.end("true}"), ['{"ok":true}']);
  assert.equal(parseJsonRecord("nope"), undefined);
  assert.equal(parseJsonRecord("[]"), undefined);
  assert.equal(parseJsonRecord(""), undefined);
});

test("JSONL framer rejects oversized complete and unterminated frames", () => {
  assert.throws(() => new JsonlFramer(8).push("123456789"), /exceeds 8 bytes/);
  assert.throws(() => new JsonlFramer(8).push("123456789\n"), /exceeds 8 bytes/);
  assert.throws(() => new JsonlFramer(8).end("123456789"), /exceeds 8 bytes/);
});
