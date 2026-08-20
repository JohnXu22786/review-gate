import { spawn } from 'node:child_process'
import type { DiffScope } from '../types.js'
import { parseDiff } from './diff.js'
import type { ParsedDiff } from './diff.js'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

export type ExecFn = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>

export interface GitRunnerOptions {
  cwd: string
  /** Injectable exec used to shell out (defaults to a real `git` spawn). */
  exec?: ExecFn
  timeoutMs?: number
}

/** Runs `git` in a repository to resolve diff scopes. */
export class GitRunner {
  private readonly exec: ExecFn
  private readonly timeoutMs: number

  constructor(private readonly opts: GitRunnerOptions) {
    this.exec = opts.exec ?? defaultExec
    this.timeoutMs = opts.timeoutMs ?? 30000
  }

  get cwd(): string {
    return this.opts.cwd
  }

  async isRepository(): Promise<boolean> {
    const r = await this.exec('git', ['rev-parse', '--is-inside-work-tree'], this.opts.cwd, this.timeoutMs)
    return r.code === 0 && r.stdout.trim() === 'true'
  }

  /** The canonical top-level directory of the repository ($GIT_WORK_TREE). */
  async toplevel(): Promise<string> {
    const r = await this.exec('git', ['rev-parse', '--show-toplevel'], this.opts.cwd, this.timeoutMs)
    if (r.code !== 0) throw new Error(`cannot resolve git toplevel: ${r.stderr.trim() || r.stdout.trim()}`)
    return r.stdout.trim()
  }

  /** The configured `remote.origin.url`, or undefined when unset. */
  async remoteUrl(): Promise<string | undefined> {
    const r = await this.exec('git', ['config', '--get', 'remote.origin.url'], this.opts.cwd, this.timeoutMs)
    if (r.code !== 0) {
      // git exits 1 with an empty message when the key is not set.
      return undefined
    }
    const url = r.stdout.trim()
    return url.length > 0 ? url : undefined
  }

  /** Produce and parse the diff for the requested scope. */
  async diff(scope: DiffScope): Promise<ParsedDiff> {
    const args = this.diffArgs(scope)
    const r = await this.exec('git', args, this.opts.cwd, this.timeoutMs)
    if (r.code !== 0) {
      const detail = r.stderr.trim() || r.stdout.trim()
      throw new Error(`git diff failed (${scope.kind}): ${detail || 'unknown error'}`)
    }
    return parseDiff(r.stdout)
  }

  private diffArgs(scope: DiffScope): string[] {
    const common = ['--no-color', '--no-ext-diff', '--unified=3', '--find-renames']
    switch (scope.kind) {
      case 'working':
        return ['diff', ...common, scope.base || 'HEAD', '--']
      case 'staged':
        return ['diff', '--cached', ...common, '--']
      case 'commit': {
        const ref = scope.ref || 'HEAD'
        return ['show', ref, '--format=', ...common, '--']
      }
      case 'range': {
        const base = scope.base || 'HEAD~1'
        const head = scope.head || 'HEAD'
        return ['diff', ...common, base, head, '--']
      }
    }
  }
}

/** Real `git` spawn used as the default executor. */
export function defaultExec(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`git command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`))
        return
      }
      resolve({ stdout, stderr, code: code ?? -1 })
    })
  })
}
