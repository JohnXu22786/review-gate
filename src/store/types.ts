import type { AuditEvent, ReviewSession } from '../types.js'

/**
 * Persistence contract. The durable implementation (JSON files) guarantees
 * atomic read-modify-write per session and an append-only audit; the in-memory
 * implementation exists for tests and single-shot CLI runs.
 */
export interface Store {
  readSession(id: string): Promise<ReviewSession | undefined>

  /**
   * Atomically read-modify-write a session under (at least) an in-process
   * mutex so concurrent updates can never lose writes. `update` may return
   * `undefined` to delete the session; returning a session persists it.
   * Returns the persisted session (or `undefined` when deleted / absent).
   */
  updateSession(
    id: string,
    update: (current: ReviewSession | undefined) => ReviewSession | undefined,
  ): Promise<ReviewSession | undefined>

  /** Append one immutable audit event (append-only, ordering guaranteed). */
  appendAudit(event: AuditEvent): Promise<void>

  /** Read back audit events, optionally filtered to one session. */
  readAudit(sessionId?: string): Promise<AuditEvent[]>

  /** Release any held resources. */
  close(): Promise<void>
}
