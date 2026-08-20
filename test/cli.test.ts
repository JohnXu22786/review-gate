import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileP = promisify(execFile)
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url))

async function git(cwd: string, ...args: string[]) {
  await execFileP('git', args, { cwd })
}

interface CliResult {
  stdout: string
  stderr: string
  code: number
}

async function runCli(cwd: string, ...args: string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], { cwd, maxBuffer: 10 * 1024 * 1024 })
    return { stdout, stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }
  }
}

describe('review-gate CLI end to end (real git repo)', () => {
  let repo = ''

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), 'rg-cli-'))
    await git(repo, 'init', '-b', 'main')
    await git(repo, 'config', 'user.name', 'Gate Test')
    await git(repo, 'config', 'user.email', 'gate@test.local')
    await writeFile(join(repo, 'a.ts'), 'export function f() {}\n', 'utf8')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'init')
    await writeFile(join(repo, 'a.ts'), 'export function f() {\n  debugger;\n  // TODO drop later\n}\n', 'utf8')
  })

  after(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('run --json produces machine-readable output and a blocked verdict', async () => {
    const r = await runCli(repo, 'run', '--json')
    assert.equal(r.code, 0, r.stderr)
    const parsed = JSON.parse(r.stdout) as { ok: boolean; verdict: { status: string } }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.verdict.status, 'blocked')
  })

  it('gate-check exits non-zero while blocked and zero once approved', async () => {
    let r = await runCli(repo, 'gate-check', '--json')
    assert.equal(r.code, 1, 'blocked gate must fail the CI check')
    const blocked = JSON.parse(r.stdout) as { passed: boolean; status: string }
    assert.equal(blocked.passed, false)
    assert.equal(blocked.status, 'blocked')

    // status lists findings with machine-readable output
    r = await runCli(repo, 'status', '--json')
    const status = JSON.parse(r.stdout) as { status: string; findings: number }
    assert.equal(status.status, 'blocked')
    assert.ok(status.findings >= 2, 'debugger + TODO should be found')

    // acknowledge the severe (debugger) finding, then approve
    r = await runCli(repo, 'run', '--json')
    const run = JSON.parse(r.stdout) as { ok: boolean; session: { findings: Array<{ id: string; severity: string }> } }
    const severe = run.session.findings.find((f) => f.severity === 'severe')!
    r = await runCli(repo, 'acknowledge', severe.id, '--reviewer', 'tester', '--reason', 'manual QA sign-off')
    assert.equal(r.code, 0, r.stderr)

    // after acknowledging the severe, the warning (TODO) still blocks
    r = await runCli(repo, 'gate-check', '--json')
    assert.equal(r.code, 1, 'TODO warning still blocks')

    // acknowledge the TODO finding by id from the run output
    const todo = run.session.findings.find((f) => f.severity === 'warning')!
    r = await runCli(repo, 'acknowledge', todo.id, '--reviewer', 'tester', '--reason', 'tracked backlog')
    assert.equal(r.code, 0, r.stderr)

    r = await runCli(repo, 'approve', '--reviewer', 'tester')
    assert.equal(r.code, 0, r.stderr)

    r = await runCli(repo, 'gate-check', '--mode', 'merge', '--json')
    assert.equal(r.code, 0, 'approved merge gate must pass the CI check: ' + r.stdout)
    const approved = JSON.parse(r.stdout) as { passed: boolean; status: string }
    assert.equal(approved.passed, true)
    assert.equal(approved.status, 'approved')
  })

  it('export --format markdown writes a compliance report and audit works', async () => {
    const r = await runCli(repo, 'export', '--format', 'markdown', '--out', 'report.md')
    assert.equal(r.code, 0, r.stderr)
    const fs = await import('node:fs/promises')
    const md = await fs.readFile(join(repo, 'report.md'), 'utf8')
    assert.ok(md.includes('Code Review Gate Report'))

    const audit = await runCli(repo, 'audit', '--json')
    const events = JSON.parse(audit.stdout) as Array<{ type: string }>
    assert.ok(events.some((e) => e.type === 'run'))
    assert.ok(events.some((e) => e.type === 'vote'))
    assert.ok(events.some((e) => e.type === 'acknowledge'))
    assert.ok(events.some((e) => e.type === 'export'))
  })
})
