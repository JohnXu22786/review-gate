import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, DIFF_DEBUGGER, DIFF_CLEAN } from './helpers.js'
import { buildTools, parseScope, reviewer, requireString } from '../src/dsh/tools.js'
import type { DiffScope } from '../src/types.js'

type ToolResult = Record<string, unknown>

async function exec(tool: ReturnType<typeof buildTools>[number], args: Record<string, unknown> = {}): Promise<ToolResult> {
  return (await tool.execute(args, {})) as ToolResult
}

describe('dsh tool registry', () => {
  it('registers the full expected roster', () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_CLEAN } })
    assert.deepEqual(
      buildTools(gate).map((t) => t.name),
      [
        'review_run',
        'review_status',
        'review_approve',
        'review_request_changes',
        'review_reject',
        'review_acknowledge',
        'gate_check',
        'review_export',
      ],
    )
  })

  it('every tool declares an output schema and render that returns text blocks', () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_CLEAN } })
    for (const tool of buildTools(gate)) {
      assert.ok(tool.output?.schema, `${tool.name} needs an output schema`)
      const blocks = tool.output.render({}, { ok: true })
      assert.ok(Array.isArray(blocks) && blocks.length === 1 && blocks[0]!.type === 'text')
    }
  })

  it('exercises the review/approve/ack/gate pipeline through the tools', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_DEBUGGER } })
    const tools = new Map(buildTools(gate).map((t) => [t.name, t]))

    const run = await exec(tools.get('review_run')!)
    assert.equal(run.ok, true)
    assert.equal(run.status, 'blocked')

    const findings = run.findings as Array<{ id: string; severity: string }>
    const severe = findings.find((f) => f.severity === 'severe')!
    assert.ok(findings.length >= 1)

    // reviewers cannot bypass a failed auto-gate
    let v = await exec(tools.get('review_approve')!, { reviewer: 'alice' })
    assert.equal(v.status, 'blocked')

    // acknowledge + approve unlock the merge gate
    const ack = await exec(tools.get('review_acknowledge')!, {
      findingId: severe.id,
      reviewer: 'alice',
      reason: 'tested manually',
    })
    assert.equal(ack.ok, true)
    // alice had already approved; acknowledging clears the auto-gate -> approved
    assert.equal(ack.status, 'approved')

    v = await exec(tools.get('review_approve')!, { reviewer: 'alice' })
    assert.equal(v.status, 'approved')

    let gateCheck = await exec(tools.get('gate_check')!, { mode: 'merge' })
    assert.equal(gateCheck.passed, true)
    assert.equal(gateCheck.status, 'approved')

    // request_changes re-blocks
    v = await exec(tools.get('review_request_changes')!, { reviewer: 'bob', comment: 'nope' })
    assert.equal(v.status, 'blocked')
    assert.deepEqual((v.approvals as { blockers: string[] }).blockers, ['bob'])

    gateCheck = await exec(tools.get('gate_check')!, { mode: 'gate' })
    assert.equal(gateCheck.passed, false)

    // request_changes retract -> approved again
    v = await exec(tools.get('review_approve')!, { reviewer: 'bob' })
    assert.equal(v.status, 'approved')
  })

  it('validate required string parameters', async () => {
    assert.throws(() => requireString(undefined, 'findingId'), /findingId/)
    assert.throws(() => requireString('', 'reason'), /reason/)
    assert.equal(requireString('  ok ', 'x'), 'ok')
  })

  it('reviewer identity resolution falls back to agent id then anonymous', () => {
    assert.equal(reviewer(undefined, { agent: { id: 'a1' } }), 'agent:a1')
    assert.equal(reviewer('bob', {}), 'bob')
    assert.equal(reviewer(undefined, {}), 'anonymous')
  })

  it('parseScope handles all forms and defaults', () => {
    assert.deepEqual(parseScope(undefined) as DiffScope, { kind: 'working', base: 'HEAD' })
    assert.deepEqual(parseScope({ kind: 'staged' }), { kind: 'staged' })
    assert.deepEqual(parseScope({ kind: 'commit', ref: 'abc' }), { kind: 'commit', ref: 'abc' })
    assert.deepEqual(parseScope({ kind: 'range' }), { kind: 'range', base: 'HEAD~1', head: 'HEAD' })
    assert.throws(() => parseScope({ kind: 'nope' }), /scope\.kind/)
  })
})
