import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeHarness, FakeGit, DIFF_TODO, DIFF_DEBUGGER, DIFF_CLEAN, EMPTY_DIFF } from './helpers.js'
import { MemoryStore } from '../src/store/memory.js'
import { GitRunner } from '../src/git/runner.js'
import { ReviewGate } from '../src/service/reviewGate.js'
import { resolveConfig } from '../src/config.js'
import type { LlmGateway, LlmReviewRequest } from '../src/analyzers/llm.js'

class StubLlm implements LlmGateway {
  label = 'stub'
  calls: LlmReviewRequest[] = []
  constructor(private drafts: Array<{ file: string; severity: 'severe' | 'warning' | 'suggestion'; message: string }> = []) {}
  async generate(request: LlmReviewRequest) {
    this.calls.push(request)
    return this.drafts.map((d) => ({ ...d }))
  }
}

describe('ReviewGate.run', () => {
  it('produces deterministic findings and a blocked verdict for a TODO diff', async () => {
    const { gate, config } = makeHarness({ diffs: { '*': DIFF_TODO } })
    const out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.newSession, true)
    assert.equal(out.hasDiff, true)
    const todo = out.session.findings.find((f) => f.rule === 'todo')
    assert.ok(todo)
    assert.equal(out.verdict.status, 'blocked')
    assert.equal(out.verdict.reasons.some((r) => r.includes('warning')), true)
    assert.equal(config.rulesVersion.length > 0, true)

    // One audit 'run' event recorded.
    const audit = await gate.audit()
    const runs = audit.filter((e) => e.type === 'run')
    assert.equal(runs.length, 1)
  })

  it('falls back gracefully when the LLM gateway throws (gate stays deterministic)', async () => {
    const boom = { label: 'boom', generate: async () => { throw new Error('provider offline') } }
    const { gate } = makeHarness({
      diffs: { '*': DIFF_CLEAN },
      config: { llm: { enabled: true, temperature: 0.2, maxFindingsPerFile: 10, maxFilesPerRun: 10 } },
      llm: boom as LlmGateway,
    })
    const out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.verdict.autoPass, true, 'a clean diff must pass even when the model is down')
    const warns = await gate.audit()
    assert.ok(warns.some((e) => e.type === 'llm.warn'), 'the outage is recorded, but never blocks')
  })

  it('merges LLM drafts into findings without breaking the gate', async () => {
    const llm = new StubLlm([{ file: 'README.md', severity: 'warning', message: 'typo strength' }])
    const { gate } = makeHarness({
      diffs: { '*': DIFF_CLEAN },
      config: { llm: { enabled: true, temperature: 0.2, maxFindingsPerFile: 10, maxFilesPerRun: 10 } },
      llm,
    })
    const out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    const llmFinding = out.session.findings.find((f) => f.source === 'llm')
    assert.ok(llmFinding)
    assert.equal(llmFinding!.rule, 'llm')
    assert.equal(llm.calls.length, 1)
    // warning cap defaults to 0, so the llm warning now blocks the gate
    assert.equal(out.verdict.status, 'blocked')
  })
})

describe('approval + gate flow (end to end)', () => {
  it('severe finding -> acknowledge -> approvals -> approved', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_DEBUGGER }, config: { approvals: { required: 2 } } })
    const out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.verdict.status, 'blocked')

    // approvals cannot pass a failed auto-gate even once the quorum is met
    let v = await gate.vote({ reviewer: 'alice', decision: 'approve' })
    assert.equal(v.verdict!.status, 'blocked', 'auto-gate still fails')
    v = await gate.vote({ reviewer: 'bob', decision: 'approve' })
    assert.equal(v.verdict!.status, 'blocked', '2 approvals cannot override a failed auto-gate')

    // a human acknowledges the severe finding -> auto-gate clears, quorum met
    const severe = out.session.findings.find((f) => f.severity === 'severe')!
    const ack = await gate.acknowledge({ findingId: severe.id, reviewer: 'audit-owner', reason: 'temporary, tracked in JIRA-42' })
    assert.equal(ack.verdict!.status, 'approved', 'acknowledged severe + quorum already met -> approved')
    assert.equal(ack.verdict!.approvals.current, 2)

    const check = await gate.gateCheck({ mode: 'merge' })
    assert.equal(check.passed, true)
  })

  it('request_changes and reject block, and new content invalidates stale approvals', async () => {
    const { gate, git } = makeHarness({ diffs: { '*': DIFF_CLEAN } })
    let out = await gate.run()
    assert.equal(out.ok && out.verdict.status === 'passed', true)

    // quorum reached -> approved
    await gate.vote({ reviewer: 'alice', decision: 'approve' })
    out = await gate.run() // idempotent re-run
    assert.equal(out.ok && out.verdict.status === 'approved', true)

    // someone requests changes -> blocked again
    let v = await gate.vote({ reviewer: 'bob', decision: 'request_changes', comment: 'see comment' })
    assert.equal(v.verdict!.status, 'blocked')
    assert.deepEqual(v.verdict!.approvals.blockers, ['bob'])

    // bob retracts by approving -> approved again (last-writer-wins)
    v = await gate.vote({ reviewer: 'bob', decision: 'approve' })
    assert.equal(v.verdict!.status, 'approved')

    // content changes -> brand new round -> approvals are stale
    git.diffs['*'] = DIFF_TODO
    out = await gate.run({ force: true })
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.session.round, 2)
    assert.equal(out.verdict.status, 'blocked', 'new round resets stale approvals and re-gates')

    // alice approves the new round -> still blocked until bobs counter... quorum 1
    v = await gate.vote({ reviewer: 'alice', decision: 'approve' })
    assert.equal(out.session.round, 2)
    // with the todo warning present the auto-gate still fails
    assert.equal(v.verdict!.status, 'blocked')
  })

  it('empty diff with policy fail requires an explicit acknowledgement', async () => {
    const { gate } = makeHarness({ diffs: { '*': EMPTY_DIFF }, config: { onEmptyDiff: 'fail' } })
    const out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    assert.equal(out.hasDiff, false)
    assert.equal(out.verdict.status, 'blocked')
    const empty = out.session.findings.find((f) => f.rule === 'empty-diff')
    assert.ok(empty)

    const ack = await gate.acknowledge({ findingId: 'empty-diff', reviewer: 'owner', reason: 'explicitly accepted' })
    assert.equal(ack.verdict!.status, 'passed')
    const v = await gate.vote({ reviewer: 'owner', decision: 'approve' })
    assert.equal(v.verdict!.status, 'approved')
  })
})

describe('idempotency', () => {
  it('re-running the same diff reuses the round without new state', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_DEBUGGER } })
    const first = await gate.run()
    const second = await gate.run()
    assert.equal(first.ok && second.ok && second.reusedRound, true)
    if (!first.ok || !second.ok) return
    assert.equal(second.session.round, first.session.round)
    assert.equal(second.session.fingerprint, first.session.fingerprint)
    const runs = (await gate.audit()).filter((e) => e.type === 'run')
    assert.equal(runs.length, 1, 're-running must not append a duplicate audit run')
  })

  it('--force creates a fresh round even when content is unchanged', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_CLEAN } })
    const first = await gate.run()
    const forced = await gate.run({ force: true })
    assert.equal(first.ok && forced.ok, true)
    if (!first.ok || !forced.ok) return
    assert.equal(forced.session.round, first.session.round + 1, 'force must bump the round')
    assert.equal(forced.reusedRound, false)
    const runs = (await gate.audit()).filter((e) => e.type === 'run')
    assert.equal(runs.length, 2, 'each forced round is recorded in the audit trail')
  })

  it('an identical vote is a no-op and appends no audit entry', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_CLEAN } })
    await gate.run()
    const v1 = await gate.vote({ reviewer: 'alice', decision: 'approve', comment: 'looks good' })
    const v2 = await gate.vote({ reviewer: 'alice', decision: 'approve', comment: 'looks good' })
    assert.equal(v1.changed, true)
    assert.equal(v2.changed, false)
    const votes = (await gate.audit()).filter((e) => e.type === 'vote')
    assert.equal(votes.length, 1)
  })

  it('gateCheck is pure: repeated checks never mutate state', async () => {
    const { gate } = makeHarness({ diffs: { '*': DIFF_CLEAN } })
    await gate.run()
    const before = (await gate.audit()).length
    const c1 = await gate.gateCheck()
    const c2 = await gate.gateCheck()
    assert.equal(c1.found && c2.found, true)
    assert.equal(c1.passed, c2.passed)
    assert.equal((await gate.audit()).length, before, 'gateCheck must not write anything')
  })
})

describe('round scoping & identity', () => {
  it('acknowledgements are invalidated when a new round is produced', async () => {
    const { gate, git } = makeHarness({ diffs: { '*': DIFF_DEBUGGER } })
    let out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    const severe = out.session.findings.find((f) => f.severity === 'severe')!
    let ack = await gate.acknowledge({ findingId: severe.id, reviewer: 'r1', reason: 'ok now' })
    assert.equal(ack.verdict!.status, 'passed', 'ack clears the auto-gate (quorum pending)')

    // Content changes -> new round -> the ack (round 1) must no longer count.
    git.diffs['*'] = DIFF_DEBUGGER + '\n+extra line\n'
    out = await gate.run()
    assert.equal(out.ok && out.session.round, 2)
    if (!out.ok) return
    assert.equal(out.verdict.status, 'blocked', 'stale acknowledgement must not carry into the new round')
    assert.equal(out.session.acknowledgements.length, 1, 'the old ack is kept for the trail but ignored')
  })

  it('onEmptyDiff policy changes are part of the fingerprint and re-gate', async () => {
    // Shared store + same identity so the fingerprint-reuse path is exercised.
    const repo = 'C:\\repo\\policy'
    const store = new MemoryStore()
    const mk = (onEmptyDiff: 'pass' | 'fail') => {
      const fake = new FakeGit(repo, { diffs: { '*': EMPTY_DIFF } })
      return new ReviewGate({
        config: resolveConfig({ cwd: repo, onEmptyDiff }),
        store,
        git: new GitRunner({ cwd: repo, exec: fake.exec }),
      })
    }
    const gateFail = mk('fail')
    let out = await gateFail.run()
    assert.equal(out.ok && out.verdict.status, 'blocked')

    // Same store, same content, policy flipped to 'pass': the fingerprint must
    // change so a fresh round replaces the injected severe finding.
    out = await mk('pass').run()
    assert.equal(out.ok && out.session.round, 2, 'policy change must produce a new round')
    if (!out.ok) return
    assert.equal(out.verdict.status, 'passed', 'policy change must re-gate')
    assert.ok(!out.session.findings.some((f) => f.rule === 'empty-diff'))
  })

  it('re-acknowledging a finding in a later round records a fresh acknowledgement', async () => {
    const { gate, git } = makeHarness({ diffs: { '*': DIFF_DEBUGGER } })
    let out = await gate.run()
    assert.equal(out.ok, true)
    if (!out.ok) return
    const severeId = out.session.findings.find((f) => f.severity === 'severe')!.id

    await gate.acknowledge({ findingId: severeId, reviewer: 'r1', reason: 'round 1' })
    // Content changes elsewhere; the same finding is still present.
    git.diffs['*'] = DIFF_DEBUGGER + '\n+churn\n'
    out = await gate.run()
    assert.equal(out.ok && out.session.round, 2)
    if (!out.ok) return
    assert.equal(out.verdict.status, 'blocked', 'stale ack from round 1 must not apply')

    // Re-acknowledge in round 2: must be recorded (not swallowed as a no-op).
    const actor = await gate.acknowledge({ findingId: severeId, reviewer: 'r1', reason: 'round 2 re-ack' })
    assert.equal(actor.changed, true, 're-acknowledgement in a new round must change state')
    assert.equal(actor.verdict!.status, 'passed')
    assert.equal(
      (await gate.audit()).filter((e) => e.type === 'acknowledge').length,
      2,
      'both acknowledgements are audit-trailed',
    )
  })

  it('sessions key on a stable repo identity, not the checkout path', async () => {
    const optsA: import('./helpers.js').HarnessOptions = { repo: 'C:\\machineA\\work\\proj', diffs: { '*': DIFF_CLEAN } }
    const optsB: import('./helpers.js').HarnessOptions = { repo: 'C:\\machineB\\checkouts\\proj', diffs: { '*': DIFF_CLEAN } }
    const a = await makeHarness(optsA).gate.sessionIdForScope()
    const b = await makeHarness(optsB).gate.sessionIdForScope()
    assert.equal(a, b, 'same remote identity must yield the same session id across checkouts')
  })

  it('normalizeRepoUrl collapses schemes, ssh prefixes, scp/path forms and trailing .git', async () => {
    const { normalizeRepoUrl } = await import('../src/service/reviewGate.js')
    assert.equal(normalizeRepoUrl('https://github.com/acme/repo.git'), 'github.com/acme/repo')
    assert.equal(normalizeRepoUrl('git@github.com:acme/repo.git'), 'github.com/acme/repo')
    assert.equal(normalizeRepoUrl('ssh://git@github.com/acme/repo/'), 'github.com/acme/repo')
    // all clone spellings converge on one identity
    assert.equal(normalizeRepoUrl('github.com:acme/repo.git'), normalizeRepoUrl('https://github.com/acme/repo.git'))
    // a host:port is not mangled into a path segment
    assert.equal(normalizeRepoUrl('ssh://git@gitlab.example:2222/team/repo.git'), 'gitlab.example:2222/team/repo')
    // local paths are left opaque (never treated as scp host:path)
    assert.equal(normalizeRepoUrl('C:\\repo\\x'), 'C:/repo/x')
    assert.equal(normalizeRepoUrl('C:/repo/x'), 'C:/repo/x')
    assert.equal(normalizeRepoUrl('\\\\nas\\share\\repo'), '//nas/share/repo')
  })

  it('binary-only and pure-rename diffs are real changes, not empty diffs', async () => {
    const binary = [
      'diff --git a/blob.bin b/blob.bin',
      'new file mode 100644',
      'index 0000000..abc1234',
      'Binary files /dev/null and b/blob.bin differ',
    ].join('\n') + '\n'
    const rename = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new.ts',
    ].join('\n') + '\n'

    for (const raw of [binary, rename]) {
      const { gate } = makeHarness({ diffs: { '*': raw }, config: { onEmptyDiff: 'fail' } })
      const out = await gate.run()
      assert.equal(out.ok, true)
      if (!out.ok) return
      assert.equal(out.hasDiff, true, 'binary/rename output is a real diff')
      assert.ok(!out.session.findings.some((f) => f.rule === 'empty-diff'), 'empty-diff finding must not be injected')
    }
  })

  it('an aborted run never persists a partial round', async () => {
    const abort = new AbortController()
    let seenSignal = false
    const llm = {
      label: 'slow',
      generate: async (r: LlmReviewRequest) => {
        seenSignal = true
        abort.abort()
        assert.equal(r.signal?.aborted, true)
        throw new Error('LLM review aborted')
      },
    }
    const { gate } = makeHarness({
      diffs: { '*': DIFF_CLEAN },
      config: { llm: { enabled: true, temperature: 0.2, maxFindingsPerFile: 10, maxFilesPerRun: 10 } },
      llm: llm as LlmGateway,
    })
    const out = await gate.run({ signal: abort.signal })
    assert.equal(seenSignal, true)
    assert.equal(out.ok, false, 'abort must fail the run')
    const st = await gate.status()
    assert.equal(st.found, false, 'no session may be persisted for an aborted run')
    const events = await gate.audit()
    assert.ok(!events.some((e) => e.type === 'run'), 'no run audit entry for an aborted run')
  })
})
