import { createHash } from 'node:crypto'
import type { Severity } from './types.js'

/** A single deterministic static-analysis rule. */
export interface StaticRule {
  /** Unique rule id, also used in finding ids. */
  id: string
  severity: Severity
  /**
   * Regular expression matched against each ADDED line of a file.
   * Applied case-insensitively on the trimmed line.
   */
  pattern: string
  /** Human readable description of the finding. */
  message: string
  /** Optional remediation hint / suggestion text. */
  suggestion?: string
  /**
   * Optional path filter: regex tested against the file path.
   * e.g. `\.ts$`, `^src/`.
   */
  files?: string
}

/** Deterministic gate thresholds. `-1` means "unlimited". */
export interface GateThresholds {
  /** Max unacknowledged `severe` findings (default 0). */
  severe: number
  /** Max unacknowledged `warning` findings (default 0). */
  warning: number
  /** Max unacknowledged `suggestion` findings (default -1). */
  suggestion: number
  /**
   * Finding ids that must explicitly be acknowledged before the gate passes.
   * The special token `severe` means "every severe finding must be
   * acknowledged". Findings listed here but absent from the current round are
   * considered satisfied automatically.
   */
  requiredAcknowledge: string[]
}

export interface ApprovalConfig {
  /** Number of distinct approvals required to unlock merge (default 1). */
  required: number
}

/** Deterministic static rule set. The `default` entry is always enabled. */
export type RuleSet = Record<string, StaticRule>

/** Optional LLM-assisted review. Gate decisions never depend on this. */
export interface LlmConfig {
  enabled: boolean
  /** Optional provider name; falls back to the harness default when unset. */
  provider?: string
  /** Optional model name; falls back to the harness default when unset. */
  model?: string
  /** Temperature passed to the model (default 0.2). */
  temperature: number
  /** Max findings per file the LLM may return (default 20). */
  maxFindingsPerFile: number
  /** Max files sent to the model in a single run (default 20). */
  maxFilesPerRun: number
}

/** Behaviour when a run finds no diff at all. */
export type EmptyDiffPolicy = 'pass' | 'fail'

/** The full review-gate configuration. */
export interface GateConfig {
  store: {
    /** Directory holding session documents + `audit.jsonl`. */
    root: string
    /**
     * Optional STRONG repo identity used to key sessions across checkouts
     * (e.g. a remote URL). When unset, the gate derives one from
     * `remote.origin.url`, then `git rev-parse --show-toplevel`, then the
     * working directory. Set it to keep a committed trail readable from any
     * machine / CI checkout.
     */
    repoId?: string
  }
  gate: GateThresholds
  approvals: ApprovalConfig
  rules: RuleSet
  llm: LlmConfig
  /**
   * Behaviour on an empty diff. `pass` (default) lets a no-op change through;
   * `fail` forces a blocked session so CI must approve the emptiness.
   */
  onEmptyDiff: EmptyDiffPolicy
  /**
   * Explicit rules version tag. When absent it is derived deterministically
   * from the rules + gate thresholds; resolved config always carries a value.
   */
  rulesVersion: string
  /** Max findings kept per session (default 500, guards storage/LLM size). */
  maxFindings: number
  /** Base directory used to resolve relative store paths (default process.cwd()). */
  cwd: string
}

/** Built-in deterministic rules that ship with the gate. */
export function defaultRules(): RuleSet {
  return {
    todo: {
      id: 'todo',
      severity: 'warning',
      pattern: '\\b(?:TODO|FIXME)\\b',
      message: 'A TODO/FIXME marker was introduced with this change.',
      suggestion: 'Resolve or remove the marker before merging.',
      files: '\\..+$',
    },
    debugger: {
      id: 'debugger',
      severity: 'severe',
      pattern: '^\\s*debugger\\s*;?\\s*$',
      message: 'A `debugger` statement was committed.',
      suggestion: 'Remove debugging statements from production code.',
      files: '\\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$',
    },
    consoleLog: {
      id: 'console-log',
      severity: 'suggestion',
      pattern: '^\\s*console\\.(log|debug)\\s*\\(',
      message: 'A console.log/debug call was added.',
      suggestion: 'Consider structured logging or removing the call.',
      files: '\\.(js|ts|jsx|tsx|mjs|cjs|mts|cts)$',
    },
    hardcodedSecret: {
      id: 'hardcoded-secret',
      severity: 'severe',
      pattern:
        '(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)' +
        '\\s*[=:]\\s*["\'](?:[^"\']*[A-Za-z0-9]){8,}["\']',
      message: 'A literal that looks like a secret was added.',
      suggestion: 'Move secrets to a credential store / environment.',
      files: '\\..+$',
    },
    longLine: {
      id: 'long-line',
      severity: 'suggestion',
      pattern: '^.{121,}$',
      message: 'Added line exceeds 120 characters.',
      suggestion: 'Wrap long expressions or strings.',
      files: '\\..+$',
    },
    mergeMarkers: {
      id: 'merge-markers',
      severity: 'severe',
      pattern: '^(?:<<<<<<<|=======|>>>>>>>)',
      message: 'Unresolved merge conflict marker was added.',
      suggestion: 'Resolve the conflict before merging.',
      files: '\\..+$',
    },
  }
}

/** Default threshold values a user starts from. */
export function defaultGateThresholds(): GateThresholds {
  return { severe: 0, warning: 0, suggestion: -1, requiredAcknowledge: [] }
}

/**
 * Merge a partial user config over the defaults. Values are validated and any
 * structurally invalid value is rejected loudly (never silently ignored).
 */
export function resolveConfig(partial?: Partial<GateConfig>): GateConfig {
  const p = partial ?? {}
  // Custom rules OVERLAY the built-in set per rule id (documented behaviour).
  const rules = { ...defaultRules(), ...(p.rules ?? {}) }
  const gate = { ...defaultGateThresholds(), ...(p.gate ?? {}) }
  const approvals = { required: 1, ...(p.approvals ?? {}) }
  const llm = { enabled: false, temperature: 0.2, maxFindingsPerFile: 20, maxFilesPerRun: 20, ...(p.llm ?? {}) }
  const store = { ...(p.store ?? { root: '' }) }

  if (typeof gate.severe !== 'number' || gate.severe < -1 || !Number.isInteger(gate.severe)) {
    throw new TypeError('gate.severe must be -1 (unlimited) or a non-negative integer')
  }
  if (typeof gate.warning !== 'number' || gate.warning < -1 || !Number.isInteger(gate.warning)) {
    throw new TypeError('gate.warning must be -1 (unlimited) or a non-negative integer')
  }
  if (typeof gate.suggestion !== 'number' || gate.suggestion < -1 || !Number.isInteger(gate.suggestion)) {
    throw new TypeError('gate.suggestion must be -1 (unlimited) or a non-negative integer')
  }
  if (!Array.isArray(gate.requiredAcknowledge)) throw new TypeError('gate.requiredAcknowledge must be an array of finding ids')
  if (typeof approvals.required !== 'number' || approvals.required < 1 || !Number.isInteger(approvals.required)) {
    throw new TypeError('approvals.required must be a positive integer')
  }
  if (typeof llm.enabled !== 'boolean') throw new TypeError('llm.enabled must be a boolean')
  if (typeof llm.temperature !== 'number' || Number.isNaN(llm.temperature) || llm.temperature < 0 || llm.temperature > 2) {
    throw new TypeError('llm.temperature must be a number in the range 0..2')
  }
  if (typeof llm.maxFindingsPerFile !== 'number' || llm.maxFindingsPerFile < 0 || !Number.isInteger(llm.maxFindingsPerFile)) {
    throw new TypeError('llm.maxFindingsPerFile must be a non-negative integer')
  }
  if (typeof llm.maxFilesPerRun !== 'number' || llm.maxFilesPerRun < 1 || !Number.isInteger(llm.maxFilesPerRun)) {
    throw new TypeError('llm.maxFilesPerRun must be a positive integer')
  }
  if (p.onEmptyDiff !== undefined && p.onEmptyDiff !== 'pass' && p.onEmptyDiff !== 'fail') {
    throw new TypeError("onEmptyDiff must be 'pass' or 'fail'")
  }
  for (const [id, rule] of Object.entries(rules)) {
    if (!rule || typeof rule.pattern !== 'string' || rule.pattern.length === 0) {
      throw new TypeError(`rules.${id}.pattern must be a non-empty regex string`)
    }
    if (rule.severity !== 'severe' && rule.severity !== 'warning' && rule.severity !== 'suggestion') {
      throw new TypeError(`rules.${id}.severity must be severe|warning|suggestion`)
    }
    if (rule.files !== undefined) {
      new RegExp(rule.files) // throws on invalid pattern
    }
    try {
      new RegExp(rule.pattern)
    } catch (e) {
      throw new TypeError(`rules.${id}.pattern is not a valid regex: ${(e as Error).message}`)
    }
  }

  if (p.maxFindings !== undefined && (typeof p.maxFindings !== 'number' || p.maxFindings < 1)) {
    throw new TypeError('maxFindings must be a positive integer')
  }

  const cwd = p.cwd || process.cwd()
  const storeRoot = store.root && store.root.length > 0 ? store.root : '.review-gate'
  if (store.repoId !== undefined && (typeof store.repoId !== 'string' || store.repoId.trim().length === 0)) {
    throw new TypeError('store.repoId must be a non-empty string when set')
  }
  return {
    store: { root: resolvePath(storeRoot, cwd), repoId: store.repoId },
    gate,
    approvals,
    rules,
    llm,
    onEmptyDiff: p.onEmptyDiff ?? 'pass',
    rulesVersion: p.rulesVersion ?? deriveRulesVersion(rules, gate),
    maxFindings: p.maxFindings ?? 500,
    cwd,
  }
}

/** Resolve `target` against `base` unless it is already absolute. */
export function resolvePath(target: string, base: string): string {
  if (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) return target
  if (target === '.' || target.length === 0) return base
  return joinPath(base, target)
}

/** Minimal path join (keeps this module dependency free). */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts.map((p) => p.replace(/^[\\/]+/, ''))].join(sep)
}

/** Deterministic rules version derived from rules + thresholds. */
export function deriveRulesVersion(rules: RuleSet, gate: GateThresholds): string {
  const stable = JSON.stringify({ rules, gate })
  return sha256Hex(stable).slice(0, 12)
}

/** Small SHA-256 hex helper (re-exported here to avoid import churn). */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}
