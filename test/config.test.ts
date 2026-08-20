import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, defaultRules, deriveRulesVersion } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies defaults and resolves relative store roots against cwd', () => {
    const c = resolveConfig({ cwd: 'C:\\repo\\x' } as never)
    assert.equal(c.gate.severe, 0)
    assert.equal(c.gate.warning, 0)
    assert.equal(c.gate.suggestion, -1)
    assert.equal(c.approvals.required, 1)
    assert.equal(c.llm.enabled, false)
    assert.equal(c.onEmptyDiff, 'pass')
    assert.equal(c.store.root, 'C:\\repo\\x\\.review-gate')
    assert.ok(c.rulesVersion.length > 0)
  })

  it('merges user values over defaults', () => {
    const c = resolveConfig({ cwd: 'C:\\repo', gate: { severe: 0, warning: 5, suggestion: -1, requiredAcknowledge: [] }, approvals: { required: 3 } })
    assert.equal(c.gate.warning, 5)
    assert.equal(c.approvals.required, 3)
  })

  it('custom rules OVERLAY built-ins rather than replacing them', () => {
    const c = resolveConfig({
      cwd: 'C:\\repo',
      rules: { extra: { id: 'extra', severity: 'warning', pattern: 'FOOBAR', message: 'extra' } },
    })
    assert.ok(c.rules.todo, 'built-in rule must survive custom rules')
    assert.ok(c.rules.extra, 'the custom rule is added')
    // overriding a built-in works per id
    const c2 = resolveConfig({
      cwd: 'C:\\repo',
      rules: { debugger: { id: 'debugger', severity: 'suggestion', pattern: '^\\s*debugger\\s*$', message: 'relaxed' } },
    })
    assert.equal(c2.rules.debugger!.severity, 'suggestion')
  })

  it('rejects structurally invalid configuration loudly', () => {
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', gate: { severe: -2, warning: 0, suggestion: -1 } as never }), /severe/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', approvals: { required: 0 } } as never), /approvals\.required/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', onEmptyDiff: 'maybe' } as never), /onEmptyDiff/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', rules: { bad: { id: 'bad', severity: 'warning', pattern: '[', message: 'x' } } } as never), /not a valid regex/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', maxFindings: 0 } as never), /maxFindings/)
  })

  it('validates the llm temperature range and integer caps', () => {
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', llm: { enabled: true, temperature: 2.5 } } as never), /temperature/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', llm: { enabled: true, temperature: -0.1 } } as never), /temperature/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', llm: { enabled: true, maxFindingsPerFile: 1.5 } } as never), /maxFindingsPerFile/)
    assert.throws(() => resolveConfig({ cwd: 'C:\\r', llm: { enabled: true, maxFilesPerRun: 0 } } as never), /maxFilesPerRun/)
    // boundary values are accepted
    const c = resolveConfig({
      cwd: 'C:\\r',
      llm: { enabled: true, temperature: 0, maxFindingsPerFile: 0, maxFilesPerRun: 1 },
    })
    assert.equal(c.llm.temperature, 0)
    assert.equal(c.llm.maxFindingsPerFile, 0)
    assert.equal(c.llm.maxFilesPerRun, 1)
  })

  it('derives a stable rules version that changes when rules change', () => {
    const rules = defaultRules()
    const v1 = deriveRulesVersion(rules, { severe: 0, warning: 0, suggestion: -1, requiredAcknowledge: [] })
    const v2 = deriveRulesVersion({ ...rules, extra: { id: 'extra', severity: 'warning', pattern: 'x', message: 'extra' } }, { severe: 0, warning: 0, suggestion: -1, requiredAcknowledge: [] })
    assert.equal(v1.length, 12)
    assert.notEqual(v1, v2)
  })
})
