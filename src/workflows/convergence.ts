import type { WorkflowConvergence, WorkflowConvergenceRound } from "./types.ts";

export const MAX_CONVERGENCE_ROUNDS = 16;

const STATES = new Set(["running", "approved", "blocked", "limit-reached", "stalled", "failed"]);
const VERDICTS = new Set(["approve", "request_changes", "blocked"]);

function boundedString(value: unknown, max: number, required = false): boolean {
  return value === undefined
    ? !required
    : typeof value === "string" && value.length <= max && (!required || value.length > 0);
}

function validRound(value: unknown, expectedRound: number, maxRounds: number): value is WorkflowConvergenceRound {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const round = value as Record<string, unknown>;
  if (round.round !== expectedRound || expectedRound > maxRounds) return false;
  if (typeof round.verdict !== "string" || !VERDICTS.has(round.verdict)) return false;
  if (!Number.isSafeInteger(round.actionableCount) || (round.actionableCount as number) < 0) return false;
  if (!boundedString(round.fingerprint, 64, true)) return false;
  if (round.verdict === "approve" && round.actionableCount !== 0) return false;
  if (round.verdict === "request_changes" && round.actionableCount === 0) return false;
  return true;
}

/** Validates untrusted or restored convergence state as one coherent bounded record. */
export function isWorkflowConvergence(value: unknown): value is WorkflowConvergence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.maxRounds)
    || (candidate.maxRounds as number) < 1
    || (candidate.maxRounds as number) > MAX_CONVERGENCE_ROUNDS) return false;
  const maxRounds = candidate.maxRounds as number;
  if (!Number.isSafeInteger(candidate.round)
    || (candidate.round as number) < 0
    || (candidate.round as number) > maxRounds) return false;
  const round = candidate.round as number;
  if (typeof candidate.state !== "string" || !STATES.has(candidate.state)) return false;
  if (!Array.isArray(candidate.rounds) || candidate.rounds.length > maxRounds) return false;
  if (!candidate.rounds.every((entry, index) => validRound(entry, index + 1, maxRounds))) return false;
  if (!boundedString(candidate.name, 200)
    || !boundedString(candidate.stoppingReason, 2_000)
    || !boundedString(candidate.implementerJobId, 200)
    || !boundedString(candidate.reviewerJobId, 200)) return false;

  const latest = candidate.rounds.at(-1) as WorkflowConvergenceRound | undefined;
  const hasLatestFields = candidate.verdict !== undefined
    || candidate.actionableCount !== undefined
    || candidate.fingerprint !== undefined;
  if (!latest) {
    if (hasLatestFields || round > 1) return false;
  } else if (candidate.verdict !== latest.verdict
    || candidate.actionableCount !== latest.actionableCount
    || candidate.fingerprint !== latest.fingerprint
    || round < latest.round
    || round - latest.round > 1) return false;

  const terminal = candidate.state !== "running";
  if (terminal && !boundedString(candidate.stoppingReason, 2_000, true)) return false;
  if (!terminal && candidate.stoppingReason !== undefined) return false;
  switch (candidate.state) {
    case "running":
      return true;
    case "approved":
      return latest?.round === round && latest.verdict === "approve" && latest.actionableCount === 0;
    case "blocked":
      return latest?.round === round && latest.verdict === "blocked";
    case "stalled":
      return latest?.round === round && latest.verdict === "request_changes" && latest.actionableCount > 0;
    case "limit-reached":
    case "failed":
      return latest === undefined || latest.verdict === "request_changes";
    default:
      return false;
  }
}
