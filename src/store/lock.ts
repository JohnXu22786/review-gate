import { open, stat, unlink, readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

export interface FileLockOptions {
  /** How long to keep trying to acquire before throwing (ms). */
  timeoutMs: number
  /** Lock files older than this are considered stale and broken (ms). */
  staleMs: number
  /** Retry interval while waiting (ms). */
  retryMs: number
}

const DEFAULT_OPTS: FileLockOptions = { timeoutMs: 10000, staleMs: 30000, retryMs: 10 }

/** Error codes treated as "the lock exists / is transiently contended". */
const CONTENTION_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY'])

/**
 * Minimal cross-process advisory lock implemented with an exclusive-create
 * lock file. Guards CLI / concurrent harness processes from stepping on each
 * other during a session read-modify-write.
 *
 * Robustness notes (Windows-aware):
 * - rapid create→unlink→recreate of the same path can surface `EPERM`
 *   (delete-pending / AV contention), so EPERM/EBUSY are retried like EEXIST,
 *   and a freed lock is retried immediately without sleeping;
 * - the holder writes a random owner token into the lock file and only removes
 *   it on release, so `release` can never delete a lock it does not own; a
 *   stale lock (older than `staleMs`) is broken by a contender. Keep critical
 *   sections short: a holder occupying the lock longer than `staleMs`
 *   knowingly risks a stale-break.
 */
export class FileLock {
  private ownerToken: string | null = null

  constructor(
    private readonly path: string,
    private readonly opts: FileLockOptions = DEFAULT_OPTS,
  ) {}

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      await this.release()
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + this.opts.timeoutMs
    const token = randomBytes(8).toString('hex')
    for (;;) {
      try {
        const handle = await open(this.path, 'wx')
        try {
          await handle.writeFile(token, 'utf8')
        } finally {
          await handle.close()
        }
        this.ownerToken = token
        return
      } catch (err) {
        if (!isContention(err)) throw err
        // Lock file exists (or is transiently busy); check staleness.
        let exists = true
        let stale = false
        try {
          const st = await stat(this.path)
          stale = Date.now() - st.mtimeMs > this.opts.staleMs
        } catch {
          // The previous holder just released the lock and it is now free;
          // retry immediately instead of sleeping.
          exists = false
        }
        if (stale) {
          try {
            const holder = await readFile(this.path, 'utf8')
            // Only break a lock we can prove is stale AND not our own.
            if (holder.trim() !== this.ownerToken) await unlink(this.path)
          } catch {
            /* lost the race; fall through to retry */
          }
          continue
        }
        if (Date.now() >= deadline) {
          throw new Error(`could not acquire review-gate lock '${this.path}' within ${this.opts.timeoutMs}ms`)
        }
        if (exists) await sleep(this.opts.retryMs)
      }
    }
  }

  private async release(): Promise<void> {
    if (this.ownerToken === null) return
    try {
      const holder = await readFile(this.path, 'utf8')
      if (holder.trim() === this.ownerToken) {
        await unlink(this.path)
      }
    } catch {
      /* already gone or owned by someone else */
    } finally {
      this.ownerToken = null
    }
  }
}

function isContention(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: string }).code
  return code !== undefined && CONTENTION_CODES.has(code)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
