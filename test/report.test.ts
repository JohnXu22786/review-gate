import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../src/audit/report.js'
import { makeHarness, DIFF_DEBUGGER } from './helpers.js'

describe('renderReport', () => {
  it('includes time, person, conclusion and rules version (compliance fields)', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_DEBUGGER }, config: { approvals: { required: 1 } } })
    const out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return

    await gate.vote({ reviewer: 'alice.smith@example.com', decision: 'approve', comment: 'LGTM after ack', actor: 'alice.smith@example.com' })
    const acked = out.session.findings.find((f) => f.severity === 'severe')!
    await gate.acknowledge({ findingId: acked.id, reviewer: 'alice.smith@example.com', reason: 'charted in CR-77' })

    const report = await gate.exportReport({ actor: 'ci' })
    assert.equal(report.ok, true)
    if (!report.ok || !report.report) return

    const doc = report.report.document as {
      schema: string
      generatedAt: string
      session: { status: string; rulesVersion: string }
      findings: Array<{ acknowledged: boolean }>
      votes: Array<{ reviewer: string; decision: string }>
      audit: Array<{ type: string; actor: string }>
    }

    assert.equal(doc.schema, 'review-gate/report@1')
    assert.ok(new Date(doc.generatedAt).getTime() > 0, 'generatedAt is an ISO timestamp')
    assert.equal(doc.session.status, 'approved')
    assert.ok(doc.session.rulesVersion.length >= 8)
    assert.ok(doc.findings.some((f) => f.acknowledged))
    assert.ok(doc.votes.some((v) => v.reviewer === 'alice.smith@example.com' && v.decision === 'approve'))
    assert.ok(doc.audit.some((e) => e.type === 'vote' && e.actor === 'alice.smith@example.com'))
    assert.ok(doc.audit.some((e) => e.type === 'export' && e.actor === 'ci'))

    const md = report.report.markdown
    assert.ok(md.includes('# Code Review Gate Report'))
    assert.ok(md.includes('- **Status**: `approved` (auto pass)'), 'markdown must render the real status, not undefined')
    assert.ok(md.includes('Rules version'))
    assert.ok(md.includes('Audit trail'))
  })

  it('renders valid JSON that machines can consume directly', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_DEBUGGER } })
    await gate.run()
    const r1 = await gate.exportReport({ actor: 't' })
    assert.equal(r1.ok, true)
    if (!r1.ok || !r1.report) return
    const parsed = JSON.parse(r1.report.json) as {
      schema: string
      session: { id: string; round: number; status: string }
      findings: unknown[]
      audit: unknown[]
    }
    assert.equal(parsed.schema, 'review-gate/report@1')
    assert.ok(parsed.session.id.length > 0)
    assert.ok(Array.isArray(parsed.findings))
    assert.ok(Array.isArray(parsed.audit))
  })
})
