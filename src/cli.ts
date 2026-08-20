#!/usr/bin/env node
/**
 * review-gate CLI.
 *
 * Subcommands:
 *   run|review-run [scope] [--force] [--json]
 *   status [scope] [--json]
 *   approve|reject|request-changes [scope] [--reviewer r] [--comment c] [--json]
 *   acknowledge <findingId> [scope] --reviewer r --reason "..."
 *   gate-check [scope] [--mode gate|merge] [--json]         (exit 0 iff passed)
 *   export [scope] [--format json|markdown] [--out file] [--json]
 *   audit [scope] [--json]
 *   init [--config file]
 *   version
 *
 * Scope syntax: working | staged | commit:<ref> | range:<base>..<head>
 * Global flags: --dir <repo>  --config <file>  --json  --actor <label>
 */
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { JsonFileStore } from './store/json.js'
import { GitRunner } from './git/runner.js'
import { ReviewGate, normalizeScope } from './service/reviewGate.js'
import type { DiffScope } from './types.js'
import { resolveConfig, type GateConfig } from './config.js'

type Flags = Record<string, string | boolean | string[]>

const SCOPE_HELP = 'scope: working | staged | commit:<ref> | range:<base>..<head>'

/** Run the CLI and return the intended process exit code. Exported for tests. */
export async function main(argv: string[]): Promise<number> {
  const { flags, positionals } = parseArgv(argv)
  // `--help` / `--version` land in `flags`; `-h` / `-v` arrive as positionals.
  const cmd = positionals[0] ?? (flags.version === true ? 'version' : 'help')

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      printHelp()
      return 0
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`review-gate ${versionOf()}\n`)
      return 0
    case 'init':
      return cmdInit(flags, positionals)
  }

  const gate = await openGate(flags)
  if (!gate) return 2

  switch (cmd) {
    case 'run':
    case 'review-run':
      return await cmdRun(gate, flags, positionals)
    case 'status':
      return await cmdStatus(gate, flags, positionals)
    case 'approve':
    case 'reject':
    case 'request-changes': {
      const decision = cmd === 'approve' ? 'approve' : cmd === 'reject' ? 'reject' : 'request_changes'
      return await cmdVote(gate, flags, positionals, decision)
    }
    case 'acknowledge':
      return await cmdAcknowledge(gate, flags, positionals)
    case 'gate-check':
      return await cmdGateCheck(gate, flags, positionals)
    case 'export':
      return await cmdExport(gate, flags, positionals)
    case 'audit':
      return await cmdAudit(gate, flags, positionals)
    default:
      process.stderr.write(`unknown command '${cmd}'\n` + SCOPE_HELP + '\n')
      return 2
  }
}

function printHelp(): void {
  process.stdout.write(`review-gate - deterministic code-review gate

Usage:
  review-gate <command> [scope] [options]

Commands:
  run            Run a review of the diff and evaluate the gate
  status         Show current review status and findings
  approve        Approve the review (counts toward the quorum)
  reject         Reject the review (blocks the gate)
  request-changes Request changes (blocks the gate)
  acknowledge    Acknowledge a finding by id with a reason
  gate-check     Evaluate the gate (exit 0 iff passed)
  export         Export the compliance report (json/markdown)
  audit          Print the audit trail
  init           Write an example config file
  version        Print the version

${SCOPE_HELP}
  (omit scope for the working tree vs HEAD)

Options:
  --dir <path>      git repository to review (default: current dir)
  --config <file>   config JSON file (default: <dir>/.review-gate.config.json)
  --force           force a fresh review round (with run)
  --mode <m>        gate | merge (with gate-check; merge requires approvals)
  --reviewer <r>    reviewer identity (default: reviewer)
  --comment <text>  vote comment
  --reason <text>   acknowledgement reason
  --format <f>      json | markdown (with export)
  --out <file>      write export to a file instead of stdout
  --actor <label>   audit actor label
  --json            machine-readable JSON output
`)
}

async function cmdInit(flags: Flags, positionals: string[]): Promise<number> {
  const configFile = stringFlag(flags, 'config') ?? '.review-gate.config.json'
  const example: GateConfig = resolveConfig({})
  const payload = {
    cwd: example.cwd,
    store: { root: '.review-gate' },
    gate: example.gate,
    approvals: example.approvals,
    llm: example.llm,
    onEmptyDiff: example.onEmptyDiff,
    maxFindings: example.maxFindings,
  }
  await writeFile(configFile, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  process.stdout.write(`wrote example config to '${configFile}'\n`)
  void positionals
  return 0
}

async function openGate(flags: Flags): Promise<ReviewGate | null> {
  const dir = stringFlag(flags, 'dir') ?? process.cwd()
  const configFile = stringFlag(flags, 'config') ?? join(dir, '.review-gate.config.json')
  let fileConfig: Partial<GateConfig> | undefined
  try {
    const raw = await readFile(configFile, 'utf8')
    fileConfig = JSON.parse(raw) as Partial<GateConfig>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`failed to read config '${configFile}': ${(err as Error).message}\n`)
      return null
    }
  }

  let config: GateConfig
  try {
    config = resolveConfig(fileConfig ? { ...fileConfig, cwd: dir } : { cwd: dir })
  } catch (err) {
    process.stderr.write(`config error: ${(err as Error).message}\n`)
    return null
  }

  const git = new GitRunner({ cwd: dir })
  const store = new JsonFileStore({ root: config.store.root, useFileLock: true })
  const gate = new ReviewGate({ config, store, git })
  return gate
}

async function cmdRun(gate: ReviewGate, flags: Flags, positionals: string[]): Promise<number> {
  const out = await gate.run({
    scope: parseScopeArg(positionals[1]),
    force: flags.force === true,
    actor: stringFlag(flags, 'actor'),
  })
  if (!out.ok) {
    process.stderr.write(`error: ${out.error}\n`)
    return 1
  }
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    process.stdout.write(
      `review: ${out.session.round === 0 ? 'nothing' : `round ${out.session.round}`} ` +
        `${out.reusedRound ? '(unchanged, reused)' : ''}\n` +
        `status: ${out.verdict.status} (auto ${out.verdict.autoPass ? 'pass' : 'block'})\n` +
        `counts: severe=${out.verdict.activeCounts.severe} warning=${out.verdict.activeCounts.warning} suggestion=${out.verdict.activeCounts.suggestion}\n` +
        `${out.verdict.reasons.map((r) => `  - ${r}`).join('\n')}\n`,
    )
  }
  return 0
}

async function cmdStatus(gate: ReviewGate, flags: Flags, positionals: string[]): Promise<number> {
  const st = await gate.status(parseScopeArg(positionals[1]))
  if (!st.found) {
    if (flags.json === true) process.stdout.write(JSON.stringify({ found: false }) + '\n')
    else process.stdout.write('no review session found; run `review-gate run` first\n')
    return 0
  }
  if (flags.json === true) {
    process.stdout.write(
      JSON.stringify(
        {
          found: true,
          status: st.verdict!.status,
          autoPass: st.verdict!.autoPass,
          round: st.session!.round,
          counts: st.verdict!.activeCounts,
          approvals: st.verdict!.approvals,
          findings: st.session!.findings.length,
          reasons: st.verdict!.reasons,
        },
        null,
        2,
      ) + '\n',
    )
  } else {
    process.stdout.write(
      `status: ${st.verdict!.status} (auto ${st.verdict!.autoPass ? 'pass' : 'block'})\n` +
        `round: ${st.session!.round}  approvals: ${st.verdict!.approvals.current}/${st.verdict!.approvals.required}\n` +
        `counts: severe=${st.verdict!.activeCounts.severe} warning=${st.verdict!.activeCounts.warning} suggestion=${st.verdict!.activeCounts.suggestion}\n` +
        `${st.verdict!.reasons.map((r) => `  - ${r}`).join('\n')}\n`,
    )
  }
  return 0
}

async function cmdVote(
  gate: ReviewGate,
  flags: Flags,
  positionals: string[],
  decision: 'approve' | 'reject' | 'request_changes',
): Promise<number> {
  const reviewer = stringFlag(flags, 'reviewer') ?? 'reviewer'
  const out = await gate.vote({
    scope: parseScopeArg(positionals[1]),
    decision,
    reviewer,
    comment: stringFlag(flags, 'comment'),
    actor: stringFlag(flags, 'actor') ?? reviewer,
  })
  if (!out.ok) {
    if (flags.json === true) process.stdout.write(JSON.stringify({ ok: false, error: out.error }) + '\n')
    else process.stderr.write(`error: ${out.error}\n`)
    return 1
  }
  if (flags.json === true) {
    process.stdout.write(JSON.stringify({ ok: true, changed: out.changed, status: out.verdict?.status }, null, 2) + '\n')
  } else {
    process.stdout.write(
      `${decision} recorded by '${reviewer}'${out.changed ? '' : ' (no change)'}; status: ${out.verdict?.status}\n`,
    )
  }
  return 0
}

async function cmdAcknowledge(gate: ReviewGate, flags: Flags, positionals: string[]): Promise<number> {
  const findingId = positionals[1]
  if (!findingId) {
    process.stderr.write('usage: review-gate acknowledge <findingId> [scope] --reviewer r --reason "..."\n')
    return 2
  }
  const reason = stringFlag(flags, 'reason')
  if (!reason) {
    process.stderr.write('--reason is required for acknowledge\n')
    return 2
  }
  const reviewer = stringFlag(flags, 'reviewer') ?? 'reviewer'
  const out = await gate.acknowledge({
    scope: parseScopeArg(positionals[2]),
    findingId,
    reviewer,
    reason,
    actor: stringFlag(flags, 'actor') ?? reviewer,
  })
  if (!out.ok) {
    if (flags.json === true) process.stdout.write(JSON.stringify({ ok: false, error: out.error }) + '\n')
    else process.stderr.write(`error: ${out.error}\n`)
    return 1
  }
  if (flags.json === true) {
    process.stdout.write(JSON.stringify({ ok: true, changed: out.changed, status: out.verdict?.status }, null, 2) + '\n')
  } else {
    process.stdout.write(`finding '${findingId}' acknowledged by '${reviewer}'; status: ${out.verdict?.status}\n`)
  }
  return 0
}

async function cmdGateCheck(gate: ReviewGate, flags: Flags, positionals: string[]): Promise<number> {
  const modeArg = stringFlag(flags, 'mode') ?? 'gate'
  if (modeArg !== 'gate' && modeArg !== 'merge') {
    throw new Error(`invalid --mode '${modeArg}' (expected gate|merge)`)
  }
  const mode = modeArg === 'merge' ? 'merge' : 'gate'
  const out = await gate.gateCheck({ scope: parseScopeArg(positionals[1]), mode })
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    process.stdout.write(
      `passed: ${out.passed}  status: ${out.status ?? 'none'}  ` +
        `counts: severe=${out.counts?.severe ?? '-'} warning=${out.counts?.warning ?? '-'} suggestion=${out.counts?.suggestion ?? '-'}  ` +
        `approvals: ${out.currentApprovals ?? '-'}/${out.requiredApprovals ?? '-'}\n` +
        `${(out.reasons ?? []).map((r) => `  - ${r}`).join('\n')}\n`,
    )
  }
  return out.passed ? 0 : 1
}

async function cmdExport(gate: ReviewGate, flags: Flags, positionals: string[]): Promise<number> {
  const out = await gate.exportReport({ scope: parseScopeArg(positionals[1]), actor: stringFlag(flags, 'actor') })
  if (!out.ok || !out.report) {
    if (flags.json === true) process.stdout.write(JSON.stringify({ ok: false, error: out.error }) + '\n')
    else process.stderr.write(`error: ${out.error}\n`)
    return 1
  }
  const formatArg = stringFlag(flags, 'format') ?? 'json'
  if (formatArg !== 'json' && formatArg !== 'markdown') {
    throw new Error(`invalid --format '${formatArg}' (expected json|markdown)`)
  }
  const format = formatArg === 'markdown' ? 'markdown' : 'json'
  const content = format === 'markdown' ? out.report.markdown : out.report.json
  const target = stringFlag(flags, 'out')
  if (target) {
    const parent = target.slice(0, Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')))
    if (parent) mkdirSync(parent, { recursive: true })
    await writeFile(target, content, 'utf8')
    if (flags.json === true) process.stdout.write(JSON.stringify({ ok: true, file: target, format }) + '\n')
    else process.stdout.write(`report written to '${target}'\n`)
  } else {
    process.stdout.write(content + '\n')
  }
  return 0
}

async function cmdAudit(gate: ReviewGate, flags: Flags, positionals: string[]): Promise<number> {
  const scope = positionals[1] ? parseScopeArg(positionals[1]) : undefined
  const events = await gate.audit(scope)
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(events, null, 2) + '\n')
  } else {
    for (const e of events) {
      process.stdout.write(`${new Date(e.ts).toISOString()} ${e.type} by ${e.actor ?? '?'} ${e.sessionId}\n`)
    }
  }
  return 0
}

function parseScopeArg(raw: string | undefined): DiffScope {
  if (!raw) return normalizeScope()
  if (raw === 'working') return { kind: 'working', base: 'HEAD' }
  if (raw === 'staged') return { kind: 'staged' }
  if (raw.startsWith('commit:')) return { kind: 'commit', ref: raw.slice('commit:'.length) }
  if (raw.startsWith('range:')) {
    const [base, head] = raw.slice('range:'.length).split('..')
    return { kind: 'range', base: base || 'HEAD~1', head: head || 'HEAD' }
  }
  throw new Error(`invalid scope '${raw}'; ${SCOPE_HELP}`)
}

function parseArgv(argv: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {}
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq >= 0) {
        const key = arg.slice(2, eq)
        flags[key] = arg.slice(eq + 1)
      } else {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          flags[arg.slice(2)] = next
          i += 1
        } else {
          flags[arg.slice(2)] = true
        }
      }
      continue
    }
    positionals.push(arg)
  }
  return { flags, positionals }
}

function stringFlag(flags: Flags, name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

/**
 * Read the package version from the nearest package.json above this file
 * (works both from the `dist/` and `dist-test/src/` layouts).
 */
function versionOf(): string {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const pkg = readFileSync(join(current, 'package.json'), 'utf8')
      const parsed = JSON.parse(pkg) as { version?: string }
      if (typeof parsed.version === 'string') return parsed.version
    } catch {
      /* keep climbing */
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return '0.0.0'
}

const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMainModule) {
  try {
    const code = await main(process.argv.slice(2))
    process.exitCode = code
  } catch (err) {
    // Invalid scope strings and other usage errors surface here without a crash dump.
    process.stderr.write(`error: ${(err as Error).message}\n`)
    process.exitCode = 2
  }
}
