import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAutoGate } from '../src/gate/engine.js'
import { evaluateSession } from '../src/service/evaluate.js'
import { resolveConfig } from '../src/config.js'
import type { ReviewSession, ReviewFinding } from '../src/types.js'

let counter = 0
function finding(severity: ReviewFinding['severity'], id = `f${counter++}`): ReviewFinding {
  return { id, severity, rule: 'test', file: 'a.ts', lines: [1], message: 'm', source: 'static', createdAt: 1 }
}

function session(findings: ReviewFinding[], acked: string[] = [], required: string[] = []): {
  session: ReviewSession
  config: ReturnType<typeof resolveConfig>
} {
  const config = resolveConfig({
    cwd: 'C:\\r',
    gate: { severe: 0, warning: 0, suggestion: -1, requiredAcknowledge: required },
    approvals: { required: 2 },
  })
  const s: ReviewSession = {
    id: 's',
    repoPath: 'C:\\r',
    repoId: 'repo-id',
    scope: { kind: 'working', base: 'HEAD' },
    round: 1,
    fingerprint: 'fp',
    rulesVersion: 'v',
    findings,
    acknowledgements: acked.map((id) => ({ findingId: id, reviewer: 'r', reason: 'ok', round: 1, createdAt: 1 })),
    votes: [],
    status: 'open',
    updatedAt: 1,
    createdAt: 1,
  }
  return { session: s, config }
}

describe('evaluateAutoGate', () => {
  it('passes clean sessions and fails when caps are exceeded', () => {
    const clean = session([])
    assert.equal(evaluateAutoGate(clean.session, clean.config).autoPass, true)

    const { session: s2, config: c2 } = session([finding('severe', 's1')])
    assert.equal(evaluateAutoGate(s2, c2).autoPass, false)

    // warning cap 0
    const { session: s3, config: c3 } = session([finding('warning', 'w1')])
    assert.equal(evaluateAutoGate(s3, c3).autoPass, false)

    // suggestion unlimited by default
    const { session: s4, config: c4 } = session([finding('suggestion', 'g1')])
    assert.equal(evaluateAutoGate(s4, c4).autoPass, true)
  })

  it('acknowledged findings are exempt from the caps', () => {
    const { session: s, config: c } = session([finding('severe', 'severe-1')], ['severe-1'])
    assert.equal(evaluateAutoGate(s, c).autoPass, true)
    assert.equal(evaluateAutoGate(s, c).activeCounts.severe, 0)
    assert.equal(evaluateAutoGate(s, c).totalCounts.severe, 1)
  })

  it('enforces requiredAcknowledge: severe token and concrete ids', () => {
    // 'severe' token: every severe must be acknowledged
    const s1 = session([finding('severe', 'a'), finding('severe', 'b')], [], ['severe'])
    assert.equal(evaluateAutoGate(s1.session, s1.config).autoPass, false)
    const s1b = session([finding('severe', 'a'), finding('severe', 'b')], ['a', 'b'], ['severe'])
    assert.equal(evaluateAutoGate(s1b.session, s1b.config).autoPass, true)

    // concrete id
    const s2 = session([finding('severe', 'x')], [], ['x'])
    assert.equal(evaluateAutoGate(s2.session, s2.config).autoPass, false)
    const s2b = session([finding('severe', 'x')], ['x'], ['x'])
    assert.equal(evaluateAutoGate(s2b.session, s2b.config).autoPass, true)

    // a required id no longer present is satisfied automatically
    const s3 = session([], [], ['x'])
    assert.equal(evaluateAutoGate(s3.session, s3.config).autoPass, true)
  })
})

describe('evaluateSession (gate + approvals)', () => {
  it('returns open before any review round and blocked when auto fails', () => {
    const { session: s, config } = session([])
    s.round = 0
    const v = evaluateSession(s, config)
    assert.equal(v.status, 'open')

    const { session: s2, config: c2 } = session([finding('severe', 'z')])
    assert.equal(evaluateSession(s2, c2).status, 'blocked')
  })

  it('passed until approval quorum, approved when met', () => {
    const { session: s, config } = session([])
    const passed = evaluateSession(s, config)
    assert.equal(passed.status, 'passed')
    assert.equal(passed.approvals.required, 2)

    s.votes = [
      { reviewer: 'alice', decision: 'approve', round: 1, createdAt: 1 },
      { reviewer: 'bob', decision: 'approve', round: 1, createdAt: 2 },
    ]
    const approved = evaluateSession(s, config)
    assert.equal(approved.status, 'approved')
    assert.equal(approved.approvals.current, 2)
    assert.deepEqual(approved.approvals.approvers, ['alice', 'bob'])
  })

  it('blocked when a negative vote is active even if the quorum is otherwise met', () => {
    const { session: s, config } = session([])
    s.votes = [
      { reviewer: 'alice', decision: 'approve', round: 1, createdAt: 1 },
      { reviewer: 'bob', decision: 'reject', round: 1, createdAt: 2 },
    ]
    const v = evaluateSession(s, config)
    assert.equal(v.status, 'blocked')
    assert.deepEqual(v.approvals.blockers, ['bob'])
  })
})
