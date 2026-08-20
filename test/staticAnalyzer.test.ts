import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseDiff } from '../src/git/diff.js'
import { runStaticAnalysis, findingId } from '../src/analyzers/static.js'
import { defaultRules, resolveConfig } from '../src/config.js'

const RULES = resolveConfig({}).rules

function analyze(raw: string, rules = RULES) {
  return runStaticAnalysis(parseDiff(raw).files, rules, 1000, 500)
}

describe('runStaticAnalysis', () => {
  it('flags only ADDED lines and honors the rule file filter', () => {
    const raw = [
      'diff --git a/src/app.js b/src/app.js',
      'index 111..222 100644',
      '--- a/src/app.js',
      '+++ b/src/app.js',
      '@@ -1,4 +1,5 @@',
      ' // TODO: existing context is NOT flagged',
      '-// TODO: removed line is NOT flagged',
      '+function run() {',
      '+  debugger;',
      '+// TODO: added marker IS flagged',
    ].join('\n') + '\n'

    const findings = analyze(raw)
    const severity = Object.fromEntries(findings.map((f) => [f.rule, f.severity]))
    // context + removed TODO must not appear
    assert.ok(!findings.some((f) => f.rule === 'todo' && f.lines.includes(0)))
    // added TODO flagged (newLine 4: context is 1, function-run 2, debugger 3)
    const todo = findings.find((f) => f.rule === 'todo')
    assert.ok(todo, 'added TODO should be flagged')
    assert.equal(todo!.severity, 'warning')
    assert.deepEqual(todo!.lines, [4])
    // debugger flagged (severe) - applies only to its file type
    const dbg = findings.find((f) => f.rule === 'debugger')
    assert.ok(dbg)
    assert.equal(dbg!.severity, 'severe')
    assert.deepEqual(dbg!.lines, [3])

    // non-js files never match js-only rules
    const mdRaw = DIFF_MD
    const mdFindings = analyze(mdRaw)
    assert.ok(!mdFindings.some((f) => f.rule === 'debugger'))
  })

  it('merges identical findings and keeps ids stable across runs', () => {
    const raw = [
      'diff --git a/f.ts b/f.ts',
      'index 111..222 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -1,3 +1,3 @@',
      '+// FIXME same text 1',
      '-old',
      '+// FIXME same text 1',
    ].join('\n') + '\n'

    const first = analyze(raw)
    const todoIds = first.filter((f) => f.rule === 'todo')
    assert.equal(todoIds.length, 1, 'two identical added lines must collapse into one finding')
    assert.equal(todoIds[0]!.lines.length, 2)
    assert.equal(todoIds[0]!.id, findingId(`f.ts\u0000todo\u0000// FIXME same text 1`))
    // id must be stable: re-analyzing the same diff yields the same id
    const second = analyze(raw)
    assert.equal(second.find((f) => f.rule === 'todo')!.id, todoIds[0]!.id)
  })

  it('orders findings deterministically by file then severity', () => {
    const raw = [
      'diff --git a/z.js b/z.js',
      'index 1..2 100644',
      '--- a/z.js',
      '+++ b/z.js',
      '@@ -1,3 +1,3 @@',
      '+// TODO a',
      'diff --git a/a.js b/a.js',
      'index 3..4 100644',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,3 +1,3 @@',
      '+  debugger;',
    ].join('\n') + '\n'
    const findings = analyze(raw)
    const files = findings.map((f) => f.file)
    assert.deepEqual(files, ['a.js', 'z.js'])
  })

  it('caps the number of findings at the configured limit', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `+// TODO item ${i}`).join('\n')
    const raw = [
      'diff --git a/x.ts b/x.ts',
      'index 1..2 100644',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,30 +1,60 @@',
      lines,
    ].join('\n') + '\n'
    const files = parseDiff(raw).files
    const findings = runStaticAnalysis(files, { todo: defaultRules().todo } as ReturnType<typeof defaultRules>, 1000, 5)
    assert.equal(findings.length, 5, 'findings must be capped at the limit')
  })
})

const DIFF_MD = [
  'diff --git a/README.md b/README.md',
  'index 111..222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,2 +1,3 @@',
  ' hello',
  '+  debugger;',
].join('\n') + '\n'
