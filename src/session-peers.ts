/**
 * Discovery and forking for session peers: read-only clarification jobs forked from a
 * saved Pi session's active branch. Harness-agnostic; the extension layer supplies a
 * `SessionPeerSource` backed by Pi's own SessionManager so this module never touches
 * the filesystem directly and stays fully testable with fakes.
 */

export interface PeerSessionInfo {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  firstMessage: string;
}

export interface PeerSessionSummary {
  sessionId: string;
  name?: string;
  cwd: string;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  preview: string;
}

export interface ForkedPeerSession {
  sessionFile: string;
  sessionId: string;
}

export interface SessionPeerSource {
  /** Enumerate every known saved session across projects (or one directory when `sessionDir` is given). */
  listAll(sessionDir?: string): Promise<PeerSessionInfo[]>;
  /** Copy `sourcePath`'s full history into a brand-new session file under `targetCwd`, leaving the source untouched. */
  fork(sourcePath: string, targetCwd: string, sessionDir?: string): ForkedPeerSession;
}

export const MAX_PEER_LIST_LIMIT = 20;
export const DEFAULT_PEER_LIST_LIMIT = 10;
const PREVIEW_LIMIT = 200;

export interface ListPeerSessionsOptions {
  query?: string;
  limit?: number;
  /** Never offer the caller's own active session as a fork candidate. */
  excludeSessionId?: string;
  sessionDir?: string;
}

export async function listPeerSessions(
  source: Pick<SessionPeerSource, "listAll">,
  options: ListPeerSessionsOptions = {},
): Promise<PeerSessionSummary[]> {
  const limit = Math.max(1, Math.min(MAX_PEER_LIST_LIMIT, options.limit ?? DEFAULT_PEER_LIST_LIMIT));
  const query = options.query?.trim().toLowerCase();
  const sessions = await source.listAll(options.sessionDir);
  return sessions
    .filter((session) => session.id !== options.excludeSessionId)
    .filter((session) => !query || matchesQuery(session, query))
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, limit)
    .map(toSummary);
}

function matchesQuery(session: PeerSessionInfo, query: string): boolean {
  return (session.name?.toLowerCase().includes(query) ?? false)
    || session.firstMessage.toLowerCase().includes(query)
    || session.cwd.toLowerCase().includes(query);
}

function toSummary(session: PeerSessionInfo): PeerSessionSummary {
  return {
    sessionId: session.id,
    name: session.name,
    cwd: session.cwd,
    createdAt: session.createdAt,
    modifiedAt: session.modifiedAt,
    messageCount: session.messageCount,
    preview: session.firstMessage.slice(0, PREVIEW_LIMIT),
  };
}

export interface ForkPeerSessionOptions {
  /** Stable session id, as returned by listPeerSessions(); never a raw filesystem path. */
  sessionId: string;
  targetCwd: string;
  /** Rejects forking the caller's own active session even if it were somehow still offered. */
  currentSessionId?: string;
  /** Directory searched for the id-to-path lookup; omit to search every project. */
  sessionDir?: string;
  /** Directory the fork is written into; omit to use the default session directory for `targetCwd`. */
  forkSessionDir?: string;
}

export interface ResolvedPeerSession {
  sessionFile: string;
  sessionId: string;
  source: PeerSessionInfo;
}

/**
 * Re-resolves `sessionId` against a fresh listAll() snapshot before forking, so a caller can
 * only ever fork a session that a trusted list actually reports today; it can never hand in a
 * path directly.
 */
export async function forkPeerSession(source: SessionPeerSource, options: ForkPeerSessionOptions): Promise<ResolvedPeerSession> {
  const sessionId = options.sessionId.trim();
  if (!sessionId) throw new Error("sessionId must not be empty");
  if (options.currentSessionId && sessionId === options.currentSessionId) {
    throw new Error("Cannot fork the current session; choose a different saved session from session_peer_list");
  }
  const sessions = await source.listAll(options.sessionDir);
  const matches = sessions.filter((session) => session.id === sessionId);
  if (matches.length === 0) throw new Error(`Unknown session peer: ${sessionId}. Call session_peer_list first.`);
  if (matches.length > 1) throw new Error(`Ambiguous session peer id: ${sessionId}`);
  const match = matches[0]!;
  const forked = source.fork(match.path, options.targetCwd, options.forkSessionDir);
  return { sessionFile: forked.sessionFile, sessionId: forked.sessionId, source: match };
}
