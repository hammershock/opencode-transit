export * as SessionTaskOwner from "./task-owner"

import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { and, eq, inArray, ne, asc } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionTask } from "./task"
import { SessionTable, SessionTaskTable } from "./sql"
import { SessionSchema } from "./schema"

type DB = Database.Interface["db"]

export class OwnerUnavailable extends Error {
  readonly code = "task_owner_unavailable"
  constructor(readonly detail: string) {
    super(`task_owner_unavailable: ${detail}`)
  }
}

export class LeaseLost extends Error {
  readonly code = "task_owner_lease_lost"
  constructor() {
    super("task_owner_lease_lost: the local execution lease holder exited")
  }
}

type Lease = {
  readonly holderPID: number
  readonly holderStart: string
  readonly generation: string
  readonly exited: Promise<number>
  readonly close: () => Promise<void>
}

const active = new Map<string, Lease>()
const listeners = new Map<string, Set<() => void>>()

/** One-shot local owner transition signal; callers subscribe before reading the owner snapshot. */
export function watch(filename: string, childSessionID: string) {
  const key = lockPath(filename, childSessionID)
  const callbacks = listeners.get(key) ?? new Set<() => void>()
  listeners.set(key, callbacks)
  let wake!: () => void
  const changed = new Promise<void>((resolve) => {
    wake = resolve
  })
  callbacks.add(wake)
  return {
    changed,
    close: () => {
      callbacks.delete(wake)
      if (!callbacks.size) listeners.delete(key)
    },
  }
}

/** Test/diagnostic observation; this counts listeners, never owner state. */
export function watcherCount(filename: string, childSessionID: string) {
  return listeners.get(lockPath(filename, childSessionID))?.size ?? 0
}

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener()
}

export async function observe(filename: string, childSessionID: string) {
  const lease = active.get(lockPath(filename, childSessionID))
  if (!lease) return undefined
  if ((await processIdentity(lease.holderPID)) !== lease.holderStart) return undefined
  return {
    source: "execution_owner" as const,
    owner_generation: lease.generation,
    observed_at: Date.now(),
    holder_pid: lease.holderPID,
  }
}

/** Process identity is deliberately conservative: ambiguity denies takeover. */
export async function processIdentity(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined),
      readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => undefined),
    ])
    if (!stat || !boot) return undefined
    const end = stat.lastIndexOf(")")
    const startTicks = stat.slice(end + 2).split(" ")[19]
    return startTicks ? `${boot.trim()}:${startTicks}` : undefined
  }
  if (process.platform === "darwin") {
    const boot = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"])
    const started = Bun.spawnSync(["/bin/ps", "-p", String(pid), "-o", "lstart="])
    if (boot.exitCode !== 0 || started.exitCode !== 0) return undefined
    const time = started.stdout.toString().trim()
    // ps has second resolution. An ambiguous PID reuse in that second is
    // rejected as still live; no takeover relies on this value alone.
    return time ? `${boot.stdout.toString().trim()}:${time}` : undefined
  }
  return undefined
}

export async function priorProcessExited(pid: number, expectedStart: string): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return true
    return false
  }
  const current = await processIdentity(pid)
  return current !== undefined && current !== expectedStart
}

export function lockPath(filename: string, childSessionID: string) {
  if (filename === ":memory:") throw new OwnerUnavailable("memory database has no shared execution lease")
  const database = createHash("sha256").update(path.resolve(filename)).digest("hex")
  return path.join(os.tmpdir(), "opencode-task-owners", database, `${childSessionID}.lock`)
}

export async function acquireLocalLease(filename: string, childSessionID: string): Promise<Lease> {
  const file = lockPath(filename, childSessionID)
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const command =
    process.platform === "darwin"
      ? ["/usr/bin/lockf", "-t", "0", file, "/bin/cat"]
      : process.platform === "linux"
        ? [existsSync("/usr/bin/flock") ? "/usr/bin/flock" : "/bin/flock", "-n", file, "/bin/cat"]
        : undefined
  if (!command || !existsSync(command[0]!)) throw new OwnerUnavailable("no supported local lease command")
  const holder = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const challenge = `${randomUUID()}\n`
  const reader = holder.stdout.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    holder.stdin.write(challenge)
    await holder.stdin.flush()
    const response = await Promise.race([
      (async () => {
        let text = ""
        while (text.length < challenge.length) {
          const chunk = await reader.read()
          if (chunk.done) break
          text += new TextDecoder().decode(chunk.value)
        }
        return text
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OwnerUnavailable("lease handshake timed out")), 2_000)
      }),
    ])
    if (response !== challenge) throw new OwnerUnavailable("lease already held or holder exited before handshake")
    const holderStart = await processIdentity(holder.pid)
    if (!holderStart) throw new OwnerUnavailable("lease holder process identity is unavailable")
    reader.releaseLock()
    return {
      holderPID: holder.pid,
      holderStart,
      generation: randomUUID(),
      exited: holder.exited,
      close: async () => {
        holder.stdin.end()
        const exit = await waitForExit(holder.exited)
        if (exit === undefined) {
          holder.kill()
          await waitForExit(holder.exited)
          throw new OwnerUnavailable("lease holder did not exit after its input closed")
        }
        if (exit !== 0) throw new LeaseLost()
      },
    }
  } catch (error) {
    holder.stdin.end()
    holder.kill()
    await waitForExit(holder.exited)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function waitForExit(exited: Promise<number>): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 2_000)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * The lease is local to this controller's DB path and child, and stays open
 * over provider/tool work. The short child gate and root DB transaction are
 * acquired only after this nonblocking OS lease, then released before work.
 */
export const withLease = <A, E, R>(
  database: Database.Interface,
  input: { readonly childSessionID: string; readonly inputID: string; readonly onLost?: () => void },
  work: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        database.filename
          ? acquireLocalLease(database.filename, input.childSessionID)
          : Promise.reject(new OwnerUnavailable("database path is unavailable")),
      catch: (error) => (error instanceof OwnerUnavailable ? error : new OwnerUnavailable(String(error))),
    }),
    (lease) =>
      Effect.gen(function* () {
        const identity = yield* Effect.promise(() => processIdentity(process.pid))
        if (!identity) return yield* Effect.fail(new OwnerUnavailable("controller process identity is unavailable"))
        // Collect OS evidence before entering the short child/SQLite boundary.
        const oldSnapshot = yield* unresolved(database.db, input)
        if (oldSnapshot.some((item) => !item.abandoned_unknown))
          return yield* Effect.fail(new OwnerUnavailable("an earlier invocation is still unresolved"))
        for (const item of oldSnapshot) {
          const pid = item.owner_pid
          const start = item.owner_start
          if (!pid || !start) return yield* Effect.fail(new OwnerUnavailable("old owner identity is incomplete"))
          if (!(yield* Effect.promise(() => priorProcessExited(pid, start))))
            return yield* Effect.fail(new OwnerUnavailable("old owner process has not been proved exited"))
        }
        yield* SessionTask.withOwner(input.childSessionID)(
          database.db.transaction(
            () =>
              Effect.gen(function* () {
                const current = yield* database.db
                  .select()
                  .from(SessionTaskTable)
                  .where(eq(SessionTaskTable.input_id, input.inputID))
                  .get()
                  .pipe(Effect.orDie)
                if (!current || current.child_session_id !== input.childSessionID || current.state === "settled")
                  return yield* Effect.die(new OwnerUnavailable("invocation is no longer eligible"))
                if (current.backend === "v2" && (current.state === "active" || current.eligibility !== "eligible"))
                  return yield* Effect.die(
                    new OwnerUnavailable("V2 invocation cannot be adopted from an active or frozen state"),
                  )
                if (current.backend === "v2") {
                  const child = yield* database.db
                    .select({ revision: SessionTable.location_revision })
                    .from(SessionTable)
                    .where(eq(SessionTable.id, SessionSchema.ID.make(input.childSessionID)))
                    .get()
                    .pipe(Effect.orDie)
                  if (!child || child.revision !== current.location_revision)
                    return yield* Effect.die(new OwnerUnavailable("Task Location revision changed before execution"))
                }
                if (current.owner_pid !== null)
                  return yield* Effect.die(new OwnerUnavailable("invocation already has an owner generation"))
                const currentOld = yield* unresolved(database.db, input)
                if (JSON.stringify(currentOld) !== JSON.stringify(oldSnapshot))
                  return yield* Effect.die(new OwnerUnavailable("old owner facts changed during verification"))
                yield* database.db
                  .update(SessionTaskTable)
                  .set({
                    owner_pid: process.pid,
                    owner_start: identity,
                    owner_generation: lease.generation,
                    owner_observed_at: Date.now(),
                  })
                  .where(eq(SessionTaskTable.input_id, input.inputID))
                  .run()
                  .pipe(Effect.orDie)
              }),
            { behavior: "immediate" },
          ),
        )
        const key = lockPath(database.filename!, input.childSessionID)
        active.set(key, lease)
        notify(key)
        void lease.exited.then(() => notify(key))
        const lost = Effect.callback<never, LeaseLost>((resume) => {
          let listening = true
          void lease.exited.then(() => {
            if (!listening) return
            input.onLost?.()
            resume(Effect.fail(new LeaseLost()))
          })
          return Effect.sync(() => {
            listening = false
          })
        })
        return yield* Effect.raceFirst(work, lost)
      }),
    (lease) =>
      Effect.tryPromise({
        try: async () => {
          if (database.filename) {
            const key = lockPath(database.filename, input.childSessionID)
            active.delete(key)
            notify(key)
          }
          await lease.close()
        },
        catch: (error) => (error instanceof LeaseLost ? error : new LeaseLost()),
      }).pipe(Effect.orDie),
  )

function unresolved(db: DB, input: { readonly childSessionID: string; readonly inputID: string }) {
  return db
    .select()
    .from(SessionTaskTable)
    .where(
      and(
        eq(SessionTaskTable.child_session_id, input.childSessionID),
        ne(SessionTaskTable.input_id, input.inputID),
        inArray(SessionTaskTable.state, ["admitted", "active"]),
      ),
    )
    .orderBy(asc(SessionTaskTable.input_id))
    .all()
    .pipe(Effect.orDie)
}
