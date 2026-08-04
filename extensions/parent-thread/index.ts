import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PI_CHILD_MARKER } from "../../src/backends/pi-rpc.ts";
import {
  PARENT_THREAD_TOOL_DESCRIPTION,
  PARENT_THREAD_TOOL_NAME,
  PI_PARENT_THREAD_FILE,
  renderParentThreadContext,
  type ParentThreadSnapshot,
} from "../../src/parent-thread-context.ts";

/** Explicitly loaded only for Pi children that receive a parent-thread snapshot. */
export default function parentThreadChildExtension(pi: ExtensionAPI): void {
  registerParentThreadChildTool(pi);
}

export function registerParentThreadChildTool(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  if (env[PI_CHILD_MARKER] !== "1") return;
  const snapshotPath = env[PI_PARENT_THREAD_FILE];
  if (!snapshotPath) return;
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as ParentThreadSnapshot;
  if (!Array.isArray(snapshot.messages) || typeof snapshot.capturedAt !== "number" || typeof snapshot.totalMessages !== "number") {
    throw new Error("Invalid parent-thread snapshot");
  }
  pi.registerTool({
    name: PARENT_THREAD_TOOL_NAME,
    label: "Parent Thread Context",
    description: PARENT_THREAD_TOOL_DESCRIPTION,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 500 })),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(_id, params) {
      return {
        content: [{ type: "text" as const, text: renderParentThreadContext(snapshot, params) }],
        details: { capturedAt: snapshot.capturedAt, retainedMessages: snapshot.messages.length, totalMessages: snapshot.totalMessages },
      };
    },
  });
}
