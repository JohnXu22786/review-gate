import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyVote, approvalSummary } from '../src/approval/flow.js'
import { resolveConfig } from '../src/config.js'
import type { ReviewSession } from '../src/types.js'

function baseSession(round = 1, votes: ReviewSession['votes'] = []): ReviewSession {
  return {
    id: 's',
    repoPath: 'C:\\r',
    repoId: 'repo-id',
    scope: { kind: 'working', base: 'HEAD' },
    round,
    fingerprint: 'fp',
    rulesVersion: 'v',
    findings: [],
    acknowledgements: [],
    votes,
    status: 'open',
    updatedAt: 1,
    createdAt: 1,
  }
}

const config = resolveConfig({ cwd: 'C:\\r', approvals: { required: 2 } })

describe('applyVote', () => {
  it('appends a vote to the current round and records the round', () => {
    const s = applyVote(baseSession(3), { reviewer: 'alice', decision: 'approve', now: 5 })
    assert.equal(s.votes.length, 1)
    assert.equal(s.votes[0]!.round, 3)
    assert.equal(s.votes[0]!.createdAt, 5)
  })

  it('is last-writer-wins per reviewer within a round', () => {
    let s = baseSession()
    s = applyVote(s, { reviewer: 'alice', decision: 'approve', now: 1 })
    assert.equal(s.votes.length, 1)
    s = applyVote(s, { reviewer: 'alice', decision: 'reject', now: 2 })
    assert.equal(s.votes.length, 1, 'alice\'s second vote replaces the first')
    assert.equal(s.votes[0]!.decision, 'reject')
    assert.equal(approvalSummary(s, config).blocked, true)
    // back to approve
    s = applyVote(s, { reviewer: 'alice', decision: 'approve', comment: 'fixed', now: 3 })
    assert.equal(approvalSummary(s, config).current, 1)
  })

  it('treats an identical repeat vote as an idempotent no-op', () => {
    let s = baseSession()
    s = applyVote(s, { reviewer: 'alice', decision: 'approve', comment: 'ok', now: 1 })
    const s2 = applyVote(s, { reviewer: 'alice', decision: 'approve', comment: 'ok', now: 2 })
    assert.equal(s2.votes, s.votes, 'identical vote must return the same object')
  })

  it('rejects votes on a session that has never been reviewed', () => {
    assert.throws(() => applyVote(baseSession(0), { reviewer: 'alice', decision: 'approve', now: 1 }), /not been reviewed/)
  })

  it('rejects an empty reviewer', () => {
    assert.throws(() => applyVote(baseSession(), { reviewer: '   ', decision: 'approve', now: 1 }), /reviewer must not be empty/)
  })
})

describe('approvalSummary', () => {
  it('counts distinct approvers and surfaces blockers on the current round only', () => {
    const votes: ReviewSession['votes'] = [
      { reviewer: 'alice', decision: 'approve', round: 1, createdAt: 1 },
      { reviewer: 'bob', decision: 'approve', round: 1, createdAt: 2 },
      { reviewer: 'carol', decision: 'reject', round: 1, createdAt: 3 },
      // stale: applies to a previous round, must not count
      { reviewer: 'dave', decision: 'approve', round: 0, createdAt: 0 },
    ]
    const s = baseSession(1, votes)
    const sum = approvalSummary(s, config)
    assert.equal(sum.current, 2)
    assert.deepEqual(sum.approvers, ['alice', 'bob'])
    assert.deepEqual(sum.blockers, ['carol'])
    assert.equal(sum.blocked, true)
  })
})
