import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PI_CHILD_MARKER } from "../../src/backends/pi-rpc.ts";
import { askThroughInteractionBridge } from "../../src/interaction-bridge.ts";
import {
  MAX_CONTEXT_CHARS,
  MAX_QUESTION_CHARS,
  MAX_TARGET_ID_CHARS,
  PI_INTERACTION_ADDRESS,
  PI_INTERACTION_TARGETS,
  PI_INTERACTION_TOKEN,
  SUBAGENT_ASK_TOOL_DESCRIPTION,
  SUBAGENT_ASK_TOOL_NAME,
} from "../../src/interactions.ts";

/**
 * Explicitly loaded only for Pi children the host authorized for routed
 * questions. Unlike the parent-thread snapshot this is a live exchange, so the
 * child talks to an authenticated per-job IPC bridge rather than reading a
 * static file.
 */
export default function interactionChildExtension(pi: ExtensionAPI): void {
  registerInteractionChildTool(pi);
}

export function registerInteractionChildTool(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
  if (env[PI_CHILD_MARKER] !== "1") return;
  const address = env[PI_INTERACTION_ADDRESS];
  const token = env[PI_INTERACTION_TOKEN];
  if (!address || !token) return;
  const targets = (env[PI_INTERACTION_TARGETS] ?? "orchestrator").split(",").map((value) => value.trim()).filter(Boolean);
  pi.registerTool({
    name: SUBAGENT_ASK_TOOL_NAME,
    label: "Ask Orchestrator or Peer",
    description: `${SUBAGENT_ASK_TOOL_DESCRIPTION} Authorized targets: ${targets.join(", ")}.`,
    parameters: Type.Object({
      target: Type.Optional(Type.Object({
        type: Type.Union([Type.Literal("orchestrator"), Type.Literal("agent")]),
        jobId: Type.Optional(Type.String({ maxLength: MAX_TARGET_ID_CHARS })),
      })),
      question: Type.String({ minLength: 1, maxLength: MAX_QUESTION_CHARS }),
      context: Type.Optional(Type.String({ maxLength: MAX_CONTEXT_CHARS })),
    }),
    async execute(_id, params) {
      const answer = await askThroughInteractionBridge({
        address,
        token,
        question: params.question,
        context: params.context,
        target: params.target,
      });
      return {
        content: [{ type: "text" as const, text: answer.answer }],
        details: { requestId: answer.requestId, answeredBy: answer.answeredBy },
      };
    },
  });
}
