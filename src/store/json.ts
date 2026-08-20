import { appendFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { AuditEvent, ReviewSession } from '../types.js'
import type { Store } from './types.js'
import { FileLock } from './lock.js'

export interface JsonStoreOptions {
  root: string
  /** Enable the cross-process lock file around session updates (default true). */
  useFileLock?: boolean
  lockTimeoutMs?: number
}

/**
 * Durable JSON-file store.
 *
 * Concurrency & durability model:
 * - an in-process mutex per session serializes read-modify-write,
 * - an optional cross-process lock file guards CLI processes from each other,
 * - every session write goes through write-temp + fsync + rename, so a crash
 *   cannot leave a half-written document,
 * - the audit trail is append-only JSONL and is never rewritten.
 */
export class JsonFileStore implements Store {
  private readonly root: string
  private readonly sessionsDir: string
  private readonly auditPath: string
  private readonly useFileLock: boolean
  private readonly lockOpts: { timeoutMs: number; staleMs: number; retryMs: number }
  private readonly sessionMutexes = new Map<string, Promise<unknown>>()
  private auditMutex = Promise.resolve()
  private closed = false

  constructor(opts: JsonStoreOptions) {
    this.root = opts.root
    this.sessionsDir = join(this.root, 'sessions')
    this.auditPath = join(this.root, 'audit.jsonl')
    this.useFileLock = opts.useFileLock !== false
    this.lockOpts = {
      timeoutMs: opts.lockTimeoutMs ?? 10000,
      staleMs: 30000,
      retryMs: 50,
    }
  }

  get storeRoot(): string {
    return this.root
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('store is closed')
  }

  async readSession(id: string): Promise<ReviewSession | undefined> {
    this.assertOpen()
    try {
      const raw = await readFile(this.sessionPath(id), 'utf8')
      return JSON.parse(raw) as ReviewSession
    } catch (err) {
      if (isEnoent(err)) return undefined
      throw err
    }
  }

  async updateSession(
    id: string,
    update: (current: ReviewSession | undefined) => ReviewSession | undefined,
  ): Promise<ReviewSession | undefined> {
    this.assertOpen()
    await mkdir(this.sessionsDir, { recursive: true })
    const run = async (): Promise<ReviewSession | undefined> => {
      const current = await this.readSession(id)
      const next = update(current)
      if (next === undefined) {
        try {
          await unlink(this.sessionPath(id))
        } catch (err) {
          if (!isEnoent(err)) throw err
        }
        return undefined
      }
      await this.writeSession(id, next)
      return next
    }

    if (this.useFileLock) {
      const lock = new FileLock(join(this.root, '.lock-' + sanitize(id)), this.lockOpts)
      return lock.withLock(() => this.mutexed(id, run))
    }
    return this.mutexed(id, run)
  }

  /** Serialize updates to the same session within this process. */
  private mutexed<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutexes.get(id) ?? Promise.resolve()
    const current = previous.then(fn, fn)
    // Keep the chain alive but drop it once settled to avoid unbounded growth.
    this.sessionMutexes.set(
      id,
      current.catch(() => undefined),
    )
    return current
  }

  private async writeSession(id: string, session: ReviewSession): Promise<void> {
    const target = this.sessionPath(id)
    const tmp = `${target}.tmp-${randomBytes(4).toString('hex')}`
    const data = JSON.stringify(session, null, 2)
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(data, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, target)
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.assertOpen()
    await mkdir(this.root, { recursive: true })
    const line = JSON.stringify(event) + '\n'
    const write = async (): Promise<void> => {
      await appendFile(this.auditPath, line, 'utf8')
    }
    // Serialize appends across processes via a lock file when it is available.
    // A single-line append is atomic at the OS level, so if the lock cannot be
    // acquired we degrade to an unlocked append rather than fail the review.
    const guarded = this.useFileLock
      ? new FileLock(join(this.root, '.lock-audit'), this.lockOpts).withLock(write).catch(write)
      : write()
    const append = this.auditMutex.then(() => guarded)
    this.auditMutex = append.catch(() => undefined)
    await append
  }

  async readAudit(sessionId?: string): Promise<AuditEvent[]> {
    this.assertOpen()
    let raw: string
    try {
      raw = await readFile(this.auditPath, 'utf8')
    } catch (err) {
      if (isEnoent(err)) return []
      throw err
    }
    const events: AuditEvent[] = []
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const e = JSON.parse(line) as AuditEvent
        if (!sessionId || e.sessionId === sessionId) events.push(e)
      } catch {
        // A corrupt audit line must not take down the trail; skip it.
        continue
      }
    }
    return events
  }

  async close(): Promise<void> {
    this.closed = true
  }

  private sessionPath(id: string): string {
    return join(this.sessionsDir, sanitize(id) + '.json')
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_')
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}
