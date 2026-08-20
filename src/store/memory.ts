import type { AuditEvent, ReviewSession } from '../types.js'
import type { Store } from './types.js'

/** Ephemeral store used by tests and in-memory tooling. */
export class MemoryStore implements Store {
  private readonly sessions = new Map<string, ReviewSession>()
  private readonly audit: AuditEvent[] = []
  private closed = false

  private assertOpen(): void {
    if (this.closed) throw new Error('store is closed')
  }

  async readSession(id: string): Promise<ReviewSession | undefined> {
    this.assertOpen()
    const s = this.sessions.get(id)
    return s ? structuredClone(s) : undefined
  }

  async updateSession(
    id: string,
    update: (current: ReviewSession | undefined) => ReviewSession | undefined,
  ): Promise<ReviewSession | undefined> {
    this.assertOpen()
    const current = this.sessions.get(id)
    const next = update(current ? structuredClone(current) : undefined)
    if (next === undefined) {
      this.sessions.delete(id)
      return undefined
    }
    const copy = structuredClone(next)
    this.sessions.set(id, copy)
    return structuredClone(copy)
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    this.assertOpen()
    this.audit.push(structuredClone(event))
  }

  async readAudit(sessionId?: string): Promise<AuditEvent[]> {
    this.assertOpen()
    const rows = sessionId ? this.audit.filter((e) => e.sessionId === sessionId) : [...this.audit]
    return rows.map((e) => structuredClone(e))
  }

  async close(): Promise<void> {
    this.closed = true
  }
}
