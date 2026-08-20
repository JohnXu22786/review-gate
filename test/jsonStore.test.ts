import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileStore } from '../src/store/json.js'
import type { ReviewSession, AuditEvent } from '../src/types.js'

function s(id: string, round = 1): ReviewSession {
  return {
    id,
    repoPath: 'C:\\r',
    repoId: 'repo-id',
    scope: { kind: 'working', base: 'HEAD' },
    round,
    fingerprint: 'fp',
    rulesVersion: 'v',
    findings: [],
    acknowledgements: [],
    votes: [],
    status: 'open',
    updatedAt: 1,
    createdAt: 1,
  }
}

function ev(id: string, n: number): AuditEvent {
  return { type: 'run', sessionId: id, ts: n, actor: 'tester', data: { n } }
}

describe('JsonFileStore', () => {
  let dir = ''
  let store: JsonFileStore

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'review-gate-test-'))
    store = new JsonFileStore({ root: dir, useFileLock: true, lockTimeoutMs: 10000 })
  })

  after(async () => {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips sessions through a temp+rename write', async () => {
    await store.updateSession('s1', () => s('s1'))
    const read = await store.readSession('s1')
    assert.ok(read)
    assert.equal(read!.id, 's1')
    assert.equal(read!.round, 1)
  })

  it('delete-on-undefined removes the document', async () => {
    await store.updateSession('s1', () => undefined)
    assert.equal(await store.readSession('s1'), undefined)
  })

  it('serializes concurrent updates to the same session (no lost writes)', async () => {
    const tasks = []
    for (let i = 0; i < 25; i += 1) {
      tasks.push(
        store.updateSession('s-race', (doc) => {
          const base = doc ?? s('s-race', 0)
          return { ...base, votes: [...base.votes, { reviewer: `r${i}`, decision: 'approve' as const, round: 1, createdAt: i }] }
        }),
      )
    }
    await Promise.all(tasks)
    const final = await store.readSession('s-race')
    assert.equal(final!.votes.length, 25, 'all 25 concurrent approvals must be present')
  })

  it('keeps the audit trail append-only and ordered', async () => {
    await store.appendAudit(ev('a', 1))
    await store.appendAudit(ev('a', 2))
    await store.appendAudit(ev('b', 3))
    const all = await store.readAudit()
    assert.equal(all.length, 3)
    assert.deepEqual(all.map((e) => (e.data as { n: number }).n), [1, 2, 3])
    const onlyA = await store.readAudit('a')
    assert.deepEqual(onlyA.map((e) => (e.data as { n: number }).n), [1, 2])
  })

  it('survives concurrent audit appends without interleaving lines', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.appendAudit(ev('bulk', i))))
    const bulk = await store.readAudit('bulk')
    assert.equal(bulk.length, 20)
    assert.deepEqual(
      bulk.map((e) => (e.data as { n: number }).n).sort((a, b) => a - b),
      Array.from({ length: 20 }, (_, i) => i),
    )
  })
})

describe('cross-process lock file', () => {
  it('throws when a lock cannot be acquired within the timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-gate-lock-'))
    const store = new JsonFileStore({ root: dir, useFileLock: true, lockTimeoutMs: 300 })
    // Simulate a foreign process holding the lock for session 'x'.
    await import('node:fs/promises').then((fs) => fs.writeFile(join(dir, '.lock-x'), 'locked', 'utf8'))
    await assert.rejects(store.updateSession('x', (d) => s('x')), /could not acquire review-gate lock/)
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('a stale lock is broken and the update still succeeds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-gate-stale-'))
    const fs = await import('node:fs/promises')
    // Write a lock then backdate its mtime beyond the stale window.
    const lockPath = join(dir, '.lock-y')
    await fs.writeFile(lockPath, 'stale', 'utf8')
    const old = new Date(Date.now() - 120_000)
    await fs.utimes(lockPath, old, old)
    const store = new JsonFileStore({ root: dir, useFileLock: true, lockTimeoutMs: 1000 })
    await store.updateSession('y', () => s('y'))
    assert.ok(await store.readSession('y'))
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })
})
