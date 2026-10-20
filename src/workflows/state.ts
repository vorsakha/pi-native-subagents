import type { Context, JsonValue } from "@earendil-works/chord";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, defineDoc, ROOT_CONVERSATION_ID, type Session, type TaskRecord, type TaskId, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { withWorkflowRetentionLock } from "./retention.ts";

/** Application inspection and replay proofs outlive Durable's task-scoped execution journal. */
export const WorkflowHistoryDoc = defineDoc<{
  snapshot?: string;
  transcripts?: string;
  history: string[];
}>({
  kind: "native.workflow.history",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ history: [] }),
});

export class WorkflowDatabaseBusyError extends Error {
  constructor() { super("Workflow database already has a live owner"); }
}

interface Owner {
  harness: Pick<Session, "snapshot" | "commit"> & {
    getTask(id: TaskId, context: Context): Promise<Pick<TaskRecord<JsonValue, JsonValue, unknown>, "state"> | undefined>;
  };
  conversationId: ConversationId;
}

const owners = new Map<string, Promise<Owner>>();
const mutations = new Map<string, Promise<void>>();

export function reserveWorkflowState(database: string) {
  if (owners.has(database)) throw new WorkflowDatabaseBusyError();
  let resolve!: (owner: Owner) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Owner>((accept, fail) => { resolve = accept; reject = fail; });
  owners.set(database, promise);
  void promise.catch(() => undefined);
  return {
    attach(owner: Owner) { resolve(owner); },
    release() {
      reject(new Error("Workflow database owner closed before opening"));
      owners.delete(database);
    },
  };
}

export async function readWorkflowState(database: string) {
  return withState(database, true, ({ harness, conversationId }) =>
    harness.snapshot(WorkflowHistoryDoc, conversationId, BACKGROUND_CONTEXT));
}

export async function updateWorkflowState(
  database: string,
  update: (state: { snapshot?: string; transcripts?: string; history: string[] }) => void,
): Promise<void> {
  const previous = mutations.get(database) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => withState(database, false, ({ harness, conversationId }) => harness.commit(async (tx) => {
    update(await tx.doc(WorkflowHistoryDoc, conversationId));
  }, BACKGROUND_CONTEXT)));
  mutations.set(database, next);
  try { await next; }
  finally { if (mutations.get(database) === next) mutations.delete(database); }
}

export async function withWorkflowStateReader<T>(database: string, action: (owner: Owner) => Promise<T>): Promise<T> {
  return withState(database, true, action);
}

async function withState<T>(database: string, readOnly: boolean, action: (owner: Owner) => Promise<T>): Promise<T> {
  const owner = owners.get(database);
  if (owner) return action(await owner);
  // Passive readers never resume the scheduler. Only one writer may open this run's database.
  const release = readOnly ? async () => {} : await claimWorkflowDatabase(database);
  let session: Session | undefined;
  try {
    await requireDatabase(database, readOnly);
    const storage = await openNodeSqliteStorage(database);
    session = createSession(storage);
    if (!readOnly && !await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT)) {
      // New artifacts need the reserved root; only the exclusive owner may bootstrap it.
      await session.close(BACKGROUND_CONTEXT);
      session = undefined;
      const { Harness, createRegistry } = await import("@earendil-works/pi-durable");
      const { createModels } = await import("workflow-pi-ai/models");
      const harness = await Harness.open(await openNodeSqliteStorage(database), {
        models: createModels(), registry: createRegistry(),
      }, BACKGROUND_CONTEXT);
      session = harness;
      const root = await harness.root(BACKGROUND_CONTEXT);
      return await action({ harness, conversationId: root.id });
    }
    return await action({
      harness: {
        snapshot: session.snapshot.bind(session),
        commit: session.commit.bind(session),
        getTask: storage.task.bind(storage),
      },
      conversationId: ROOT_CONVERSATION_ID,
    });
  } finally {
    await session?.close(BACKGROUND_CONTEXT);
    if (!readOnly) await chmod(database, 0o600).catch(() => undefined);
    await release();
  }
}

async function requireDatabase(database: string, mustExist: boolean): Promise<void> {
  try {
    const info = await lstat(database);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Workflow database must be a regular file");
  } catch (error) {
    if (mustExist || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** SQLite transaction locks do not prevent two schedulers from executing the same native task. */
export async function claimWorkflowDatabase(database: string): Promise<() => Promise<void>> {
  const lock = join(dirname(database), "runtime.owner");
  const lockRoot = join(dirname(database), ".ownership");
  await withWorkflowRetentionLock(lockRoot, async () => {
    try {
      let owner: unknown;
      try { owner = JSON.parse(await readFile(lock, "utf8")); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await rm(lock);
      }
      if (!owner || typeof owner !== "object" || !("pid" in owner) || typeof owner.pid !== "number"
          || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
        if (owner !== undefined) await rm(lock);
      } else {
        try {
          process.kill(owner.pid, 0);
          throw new WorkflowDatabaseBusyError();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await rm(lock);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await requireDatabase(database, false);
    try {
      const created = await open(database, "wx", 0o600);
      await created.close();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // The retention lock excludes every publisher. Remove interrupted staging files here.
    const temporary = `${lock}.pending`;
    await rm(temporary, { force: true });
    const owner = await open(temporary, "wx", 0o600);
    try {
      await owner.writeFile(JSON.stringify({ pid: process.pid }));
      await owner.sync();
      await owner.close();
      await rename(temporary, lock);
    } catch (error) {
      await owner.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  });
  return () => withWorkflowRetentionLock(lockRoot, () => rm(lock, { force: true }));
}
