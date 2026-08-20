import { resolveConfig, type GateConfig } from '../src/config.js'
import { MemoryStore } from '../src/store/memory.js'
import { GitRunner, type ExecResult } from '../src/git/runner.js'
import { ReviewGate } from '../src/service/reviewGate.js'
import type { LlmGateway } from '../src/analyzers/llm.js'

/** A diff with a `// TODO` addition (warning, rule `todo`). */
export const DIFF_TODO = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const x = 1',
  '-const old = 2',
  '+const fresh = 2',
  '+// TODO: fix later',
].join('\n') + '\n'

/** A diff with a `debugger` statement (severe, rule `debugger`). */
export const DIFF_DEBUGGER = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -10,2 +10,3 @@',
  ' export function main() {',
  '+  debugger;',
  ' }',
].join('\n') + '\n'

/** A diff that has content but no rule matches (clean change). */
export const DIFF_CLEAN = [
  'diff --git a/README.md b/README.md',
  'index 1111111..2222222 100644',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1,1 +1,2 @@',
  '+hello world',
].join('\n') + '\n'

export const EMPTY_DIFF = ''

export interface FakeGitEnvOptions {
  /** Maps `git` argv-joined strings -> raw diff text. `*` is the fallback. */
  diffs?: Record<string, string>
  isRepo?: boolean
  /** Value returned for `git config --get remote.origin.url`. */
  remoteUrl?: string
}

/** A configurable fake git for tests. Keys are the argv joined with spaces. */
export class FakeGit {
  readonly diffs: Record<string, string>
  private readonly isRepo: boolean
  private readonly remoteUrl?: string
  callLog: string[] = []

  constructor(private readonly cwd: string, opts: FakeGitEnvOptions = {}) {
    this.diffs = opts.diffs ?? { '*': DIFF_CLEAN }
    this.isRepo = opts.isRepo ?? true
    this.remoteUrl = opts.remoteUrl
  }

  /** Implements the ExecFn contract consumed by GitRunner. */
  exec = async (cmd: string, args: string[], _cwd: string, _timeout: number): Promise<ExecResult> => {
    const key = args.join(' ')
    this.callLog.push(key)
    if (args.includes('rev-parse')) {
      if (args.includes('--show-toplevel')) {
        return { stdout: this.cwd, stderr: '', code: 0 }
      }
      return this.isRepo
        ? { stdout: 'true', stderr: '', code: 0 }
        : { stdout: 'false', stderr: '', code: 1 }
    }
    if (args.includes('config') && args.includes('remote.origin.url')) {
      return this.isRepo && this.remoteUrl
        ? { stdout: this.remoteUrl, stderr: '', code: 0 }
        : { stdout: '', stderr: '', code: 1 }
    }
    if (args.includes('diff') || args.includes('show')) {
      const raw = this.diffs[key] ?? this.diffs['*']
      if (raw === undefined) return { stdout: '', stderr: 'no configured diff', code: 1 }
      return { stdout: raw, stderr: '', code: 0 }
    }
    return { stdout: '', stderr: `unhandled command: git ${key}`, code: 1 }
  }
}

export interface HarnessOptions {
  config?: Partial<GateConfig>
  diffs?: Record<string, string>
  repo?: string
  now?: () => number
  llm?: LlmGateway
}

/** Build a ReviewGate wired to a MemoryStore + FakeGit for tests. */
export function makeHarness(opts: HarnessOptions = {}): {
  gate: ReviewGate
  store: MemoryStore
  git: FakeGit
  runner: GitRunner
  config: GateConfig
} {
  const repo = opts.repo ?? 'C:\\repo\\demo'
  const config = resolveConfig({ cwd: repo, ...(opts.config ?? {}) })
  const store = new MemoryStore()
  const git = new FakeGit(repo, {
    diffs: opts.diffs ?? { '*': DIFF_TODO },
    // A stable remote so session identity is deterministic in every test.
    remoteUrl: 'https://github.com/acme/demo.git',
  })
  const runner = new GitRunner({ cwd: repo, exec: git.exec })
  const gate = new ReviewGate({ config, store, git: runner, llm: opts.llm, now: opts.now })
  return { gate, store, git, runner, config }
}
