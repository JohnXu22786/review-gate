import type {
  AuditEvent,
  DiffScope,
  ReviewFinding,
  ReviewSession,
  SessionVerdict,
} from '../types.js'
import { sha256Hex } from '../config.js'
import type { GateConfig } from '../config.js'
import type { Store } from '../store/types.js'
import { GitRunner } from '../git/runner.js'
import type { LlmGateway } from '../analyzers/llm.js'
import { runStaticAnalysis, findingId } from '../analyzers/static.js'
import { evaluateSession } from './evaluate.js'
import { applyVote } from '../approval/flow.js'
import { renderReport } from '../audit/report.js'
import type { ReviewReport } from '../audit/report.js'
import type { ParsedDiff } from '../git/diff.js'

export type ReviewMode = 'gate' | 'merge'

export interface RunOptions {
  /** Diff scope to review (default: working tree vs HEAD). */
  scope?: DiffScope
  /** Force a brand-new round even when the reviewed content is unchanged. */
  force?: boolean
  /** Abort the review; an aborted run never persists a partial round. */
  signal?: AbortSignal
  /** Actor label recorded in the audit trail. */
  actor?: string
}

export interface VoteOptions {
  scope?: DiffScope
  reviewer: string
  comment?: string
  actor?: string
}

export interface AcknowledgeOptions {
  scope?: DiffScope
  findingId: string
  reviewer: string
  reason: string
  actor?: string
}

export interface GateCheckOptions {
  scope?: DiffScope
  mode?: ReviewMode
}

export type RunOutcome =
  | {
      ok: true
      newSession: boolean
      reusedRound: boolean
      diffFiles: string[]
      hasDiff: boolean
      session: ReviewSession
      verdict: SessionVerdict
    }
  | { ok: false; error: string }

export interface StatusOutcome {
  found: boolean
  session?: ReviewSession
  verdict?: SessionVerdict
}

export interface VoteOutcome {
  ok: boolean
  error?: string
  session?: ReviewSession
  verdict?: SessionVerdict
  /** True when the operation actually changed state (else idempotent no-op). */
  changed: boolean
}

export interface GateCheckOutcome {
  found: boolean
  sessionId?: string
  /** gate mode: status in {passed, approved}; merge mode: status === 'approved'. */
  passed: boolean
  status?: ReviewSession['status']
  counts?: { severe: number; warning: number; suggestion: number }
  requiredApprovals?: number
  currentApprovals?: number
  blockers?: string[]
  reasons?: string[]
}

/**
 * The review-gate facade. All mutations run through the store's atomic
 * read-modify-write; all decisions are recomputed deterministically from the
 * persisted fields. `run`/`vote`/`acknowledge` are idempotent (an identical
 * repeat call returns the same state without a second write), and `gateCheck`
 * never mutates.
 */
export class ReviewGate {
  private readonly config: GateConfig
  private readonly store: Store
  private readonly git: GitRunner
  private readonly llm?: LlmGateway
  private readonly now: () => number
  private readonly repoPath: string
  /** Lazily-resolved stable repository identity (cached per instance). */
  private identityPromise: Promise<string> | undefined

  constructor(deps: { config: GateConfig; store: Store; git: GitRunner; llm?: LlmGateway; now?: () => number }) {
    this.config = deps.config
    this.store = deps.store
    this.git = deps.git
    this.llm = deps.llm
    this.now = deps.now ?? (() => Date.now())
    this.repoPath = deps.git.cwd
  }

  /**
   * A stable identity for the repository, used to key sessions so a committed
   * trail stays readable from any checkout/CI machine. Resolution order:
   * `store.repoId` config → `remote.origin.url` → `git rev-parse --show-toplevel`
   * → the working directory (last resort).
   */
  async repoIdentity(): Promise<string> {
    this.identityPromise ??= this.resolveIdentity()
    return this.identityPromise
  }

  private async resolveIdentity(): Promise<string> {
    const explicit = this.config.store.repoId
    if (explicit && explicit.trim().length > 0) return explicit.trim()

    try {
      const remote = await this.git.remoteUrl()
      if (remote && remote.length > 0) return normalizeRepoUrl(remote)
    } catch {
      /* not a git repo / no remote: fall through */
    }
    try {
      return await this.git.toplevel()
    } catch {
      return this.repoPath
    }
  }

  /** Deterministic session id derived from the repository identity + scope. */
  async sessionIdForScope(scope?: DiffScope): Promise<string> {
    const identity = await this.repoIdentity()
    return sha256Hex(`${identity}\u0000${JSON.stringify(normalizeScope(scope))}`)
  }

  /** Produce (or fetch) the review for a diff scope. Idempotent by fingerprint. */
  async run(opts: RunOptions = {}): Promise<RunOutcome> {
    if (opts.signal?.aborted) return { ok: false, error: 'review aborted before it started' }
    const scope = normalizeScope(opts.scope)
    const sessionId = await this.sessionIdForScope(scope)

    if (!(await this.git.isRepository())) {
      return { ok: false, error: `refusing to review: '${this.git.cwd}' is not a git working tree` }
    }

    let diff: ParsedDiff
    try {
      diff = await this.git.diff(scope)
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }

    const rulesVersion = this.config.rulesVersion ?? ''
    const fingerprint = this.fingerprint(scope, diff, rulesVersion)
    // A diff is "empty" only when git reported nothing at all. Binary-only,
    // mode-only and pure-rename changes ARE real changes (raw output exists),
    // they simply have no added text lines for the line analyzers.
    const hasDiff = diff.raw.trim().length > 0 && diff.files.some((f) => f.path !== '(merge)' && f.path !== null)
    const diffFiles = diff.files.map((f) => f.path).filter((p): p is string => p !== null)

    const prior = await this.store.readSession(sessionId)
    const existing = opts.force ? undefined : prior
    if (existing && existing.fingerprint === fingerprint) {
      const verdict = evaluateSession(existing, this.config)
      return {
        ok: true,
        newSession: false,
        reusedRound: true,
        diffFiles,
        hasDiff,
        session: { ...existing, status: verdict.status },
        verdict,
      }
    }

    const repoId = await this.repoIdentity()
    let built: ReviewSession
    try {
      built = await this.buildSession(sessionId, repoId, scope, diff, hasDiff, fingerprint, rulesVersion, prior, opts.signal)
    } catch (err) {
      // e.g. an aborted LLM review: nothing was persisted, so just surface it.
      return { ok: false, error: (err as Error).message }
    }
    let adopted = false
    const persisted = await this.store.updateSession(sessionId, (doc) => {
      // A concurrent process may already have produced this exact round; adopt
      // it UNLESS the caller explicitly forced a fresh round.
      if (doc && doc.fingerprint === fingerprint && !opts.force) {
        adopted = true
        return doc
      }
      return built
    })

    const verdict = evaluateSession(persisted ?? built, this.config)
    if (!adopted && persisted !== undefined) {
      await this.appendAudit(sessionId, 'run', opts.actor, {
        round: persisted.round,
        fingerprint,
        findings: persisted.findings.length,
        counts: verdict.totalCounts,
        hasDiff,
      })
    }

    return {
      ok: true,
      newSession: adopted ? false : prior === undefined,
      reusedRound: adopted,
      diffFiles,
      hasDiff,
      session: { ...(persisted ?? built), status: verdict.status },
      verdict,
    }
  }

  /** Read the current status of a scope without mutating anything. */
  async status(scope?: DiffScope): Promise<StatusOutcome> {
    const session = await this.store.readSession(await this.sessionIdForScope(scope))
    if (!session) return { found: false }
    const verdict = evaluateSession(session, this.config)
    return { found: true, session: { ...session, status: verdict.status }, verdict }
  }

  /** Record an approval vote (approve / request_changes / reject). */
  async vote(opts: VoteOptions & { decision: 'approve' | 'request_changes' | 'reject' }): Promise<VoteOutcome> {
    const sessionId = await this.sessionIdForScope(opts.scope)
    try {
      let mutated = false
      const persisted = await this.store.updateSession(sessionId, (doc) => {
        if (!doc) return undefined
        const next = applyVote(doc, {
          reviewer: opts.reviewer,
          decision: opts.decision,
          comment: opts.comment,
          now: this.now(),
        })
        if (next.votes === doc.votes) return doc // idempotent: identical vote already present
        mutated = true
        return next
      })

      if (!persisted) {
        return { ok: false, error: 'no review session exists for this scope; run a review first', changed: false }
      }
      const verdict = evaluateSession(persisted, this.config)
      if (mutated) {
        await this.appendAudit(sessionId, 'vote', opts.actor ?? opts.reviewer, {
          reviewer: opts.reviewer,
          decision: opts.decision,
          comment: opts.comment,
          round: persisted.round,
        })
      }
      return { ok: true, changed: mutated, session: { ...persisted, status: verdict.status }, verdict }
    } catch (err) {
      return { ok: false, error: (err as Error).message, changed: false }
    }
  }

  /** Acknowledge a finding (removes it from the failure set). Idempotent. */
  async acknowledge(opts: AcknowledgeOptions): Promise<VoteOutcome> {
    const reviewer = opts.reviewer.trim()
    if (reviewer.length === 0) return { ok: false, error: 'reviewer must not be empty', changed: false }
    const reason = opts.reason.trim()
    if (reason.length === 0) return { ok: false, error: 'reason must not be empty', changed: false }
    const sessionId = await this.sessionIdForScope(opts.scope)
    try {
      let mutated = false
      const persisted = await this.store.updateSession(sessionId, (doc) => {
        if (!doc) return undefined
        const finding = doc.findings.find((f) => f.id === opts.findingId)
        if (!finding) throw new Error(`unknown finding id '${opts.findingId}' in the current round`)
        if (
          doc.acknowledgements.some(
            (a) => a.findingId === opts.findingId && a.reviewer === reviewer && a.round === doc.round,
          )
        ) {
          return doc // idempotent for the CURRENT round
        }
        mutated = true
        return {
          ...doc,
          acknowledgements: [
            ...doc.acknowledgements,
            {
              findingId: opts.findingId,
              reviewer,
              reason: reason.slice(0, 500),
              round: doc.round,
              createdAt: this.now(),
            },
          ],
        }
      })

      if (!persisted) return { ok: false, error: 'no review session exists for this scope; run a review first', changed: false }
      const verdict = evaluateSession(persisted, this.config)
      if (mutated) {
        await this.appendAudit(sessionId, 'acknowledge', opts.actor ?? reviewer, {
          findingId: opts.findingId,
          reviewer,
          reason: reason.slice(0, 500),
          round: persisted.round,
        })
      }
      return { ok: true, changed: mutated, session: { ...persisted, status: verdict.status }, verdict }
    } catch (err) {
      return { ok: false, error: (err as Error).message, changed: false }
    }
  }

  /** Pure, deterministic gate check; never mutates state. */
  async gateCheck(opts: GateCheckOptions = {}): Promise<GateCheckOutcome> {
    const sessionId = await this.sessionIdForScope(opts.scope)
    const session = await this.store.readSession(sessionId)
    if (!session) {
      return { found: false, sessionId, passed: false, reasons: ['no review session found for this scope'] }
    }
    const verdict = evaluateSession(session, this.config)
    const mode = opts.mode ?? 'gate'
    const passed =
      mode === 'merge' ? verdict.status === 'approved' : verdict.status === 'passed' || verdict.status === 'approved'
    return {
      found: true,
      sessionId,
      passed,
      status: verdict.status,
      counts: verdict.activeCounts,
      requiredApprovals: verdict.approvals.required,
      currentApprovals: verdict.approvals.current,
      blockers: verdict.approvals.blockers,
      reasons: verdict.reasons,
    }
  }

  /** All audit events for a scope (or all scopes when no scope given). */
  async audit(scope?: DiffScope): Promise<AuditEvent[]> {
    const sessionId = scope ? await this.sessionIdForScope(scope) : undefined
    return this.store.readAudit(sessionId)
  }

  /** Render the compliance report for a scope. Records the export in the trail. */
  async exportReport(opts?: { scope?: DiffScope; actor?: string }): Promise<{
    ok: boolean
    error?: string
    report?: ReviewReport
  }> {
    const status = await this.status(opts?.scope)
    if (!status.found || !status.session || !status.verdict) {
      return { ok: false, error: 'no review session exists for this scope; run a review first' }
    }
    const sessionId = status.session.id
    // Record the export first so the report's own audit array includes it.
    await this.appendAudit(sessionId, 'export', opts?.actor, { format: 'report@1' })
    const audit = await this.store.readAudit(sessionId)
    const report = renderReport({
      session: status.session,
      verdict: status.verdict,
      audit,
      config: this.config,
      generatedAt: this.now(),
    })
    return { ok: true, report }
  }

  private async buildSession(
    sessionId: string,
    repoId: string,
    scope: DiffScope,
    diff: ParsedDiff,
    hasDiff: boolean,
    fingerprint: string,
    rulesVersion: string,
    previous: ReviewSession | undefined,
    signal?: AbortSignal,
  ): Promise<ReviewSession> {
    const now = this.now()
    const findings = await this.collectFindings(diff, hasDiff, now, signal)
    return {
      id: sessionId,
      repoPath: this.repoPath,
      repoId,
      scope,
      round: (previous?.round ?? 0) + 1,
      fingerprint,
      rulesVersion,
      findings,
      acknowledgements: previous?.acknowledgements ?? [],
      votes: previous?.votes ?? [],
      status: 'open',
      updatedAt: now,
      createdAt: previous?.createdAt ?? now,
    }
  }

  private async collectFindings(diff: ParsedDiff, hasDiff: boolean, now: number, signal?: AbortSignal): Promise<ReviewFinding[]> {
    let findings = runStaticAnalysis(diff.files, this.config.rules, now, this.config.maxFindings)

    if (!hasDiff && this.config.onEmptyDiff === 'fail') {
      findings = [...findings, emptyDiffFinding(now)]
    }

    if (this.llm && this.config.llm.enabled && hasDiff) {
      try {
        const llmItems = await this.llmFindings(diff, now, signal)
        findings = llmItems.concat(findings)
      } catch (err) {
        // An aborted review is a cancellation, not a model outage: fail the
        // run so no partial round is persisted.
        if (signal?.aborted) throw err
        // Otherwise the model is simply unavailable; log and continue.
        this.logLlmFailure(err)
      }
    }

    const seen = new Set<string>()
    const unique: ReviewFinding[] = []
    for (const f of findings) {
      if (seen.has(f.id)) continue
      seen.add(f.id)
      unique.push(f)
    }
    const capped = unique.slice(0, this.config.maxFindings)
    capped.sort(compareFindings)
    return capped
  }

  /** Structured review-gate findings derived from one LLM run. */
  private async llmFindings(diff: ParsedDiff, now: number, signal?: AbortSignal): Promise<ReviewFinding[]> {
    if (!this.llm) return []
    const files = diff.files
      .filter((f) => f.path && f.path !== '(merge)' && f.hunks.some((h) => h.added.length > 0))
      .slice(0, this.config.llm.maxFilesPerRun)

    const drafts = await this.llm.generate({
      files: files.map((f) => ({
        path: f.path!,
        addedLines: f.hunks.flatMap((h) => h.added).map((l) => ({ line: l.newLine, text: l.text })),
      })),
      options: {
        temperature: this.config.llm.temperature,
        maxFindingsPerFile: this.config.llm.maxFindingsPerFile,
      },
      signal,
    })

    const messages = new Map<string, ReviewFinding>()
    for (const d of drafts) {
      const id = findingId(`${d.file}\u0000llm\u0000${d.severity}\u0000${d.message.trim().replace(/\s+/g, ' ')}`)
      if (messages.has(id)) continue
      messages.set(id, {
        id,
        severity: d.severity,
        rule: 'llm',
        file: d.file,
        lines: [],
        message: d.message,
        suggestion: d.suggestion,
        source: 'llm',
        createdAt: now,
      })
    }
    return [...messages.values()]
  }

  /** Best-effort record of an LLM outage; the gate continues without it. */
  private logLlmFailure(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    void this.store.appendAudit({
      type: 'llm.warn',
      sessionId: '',
      ts: this.now(),
      actor: 'launcher',
      data: { error: message, provider: this.llm?.label ?? 'unknown' },
    }).catch(() => undefined)
  }

  private fingerprint(scope: DiffScope, diff: ParsedDiff, rulesVersion: string): string {
    return sha256Hex(
      JSON.stringify({
        scope: normalizeScope(scope),
        raw: diff.raw,
        rulesVersion,
        thresholds: this.config.gate,
        onEmptyDiff: this.config.onEmptyDiff,
        maxFindings: this.config.maxFindings,
        llm: this.config.llm.enabled
          ? {
              enabled: true,
              provider: this.config.llm.provider ?? null,
              model: this.config.llm.model ?? null,
              temperature: this.config.llm.temperature,
              maxFindingsPerFile: this.config.llm.maxFindingsPerFile,
              maxFilesPerRun: this.config.llm.maxFilesPerRun,
            }
          : { enabled: false },
      }),
    )
  }

  private async appendAudit(
    sessionId: string,
    type: string,
    actor: string | undefined,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.store.appendAudit({ type, sessionId, ts: this.now(), actor: actor ?? 'launcher', data })
  }
}

function emptyDiffFinding(now: number): ReviewFinding {
  return {
    id: 'empty-diff',
    severity: 'severe',
    rule: 'empty-diff',
    file: '',
    lines: [],
    message: 'onEmptyDiff=fail: this run produced no diff but the gate requires an explicit review.',
    suggestion: 'Acknowledge this finding to record that the empty diff was consciously accepted.',
    source: 'static',
    createdAt: now,
  }
}

const SEVERITY_ORDER = { severe: 0, warning: 1, suggestion: 2 } as const

/** Locale-independent, code-unit ordering so reports match across machines. */
function compareFindings(a: ReviewFinding, b: ReviewFinding): number {
  if (a.file < b.file) return -1
  if (a.file > b.file) return 1
  const sevCmp = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  if (sevCmp !== 0) return sevCmp
  const lineA = a.lines[0] ?? 0
  const lineB = b.lines[0] ?? 0
  return lineA - lineB
}

/**
 * Normalize a remote URL into a stable session key ingredient:
 * trailing `.git`, leading `git@`/schemes, and redundant `/` are stripped.
 */
export function normalizeRepoUrl(url: string): string {
  let u = url.trim()
  // Local paths (Windows drive letters, UNC, POSIX absolute) are opaque: they
  // never get scheme/colon treatment because they are not remote URLs. Only a
  // configured store.repoId gives cross-machine stability for local remotes.
  if (/^[A-Za-z]:[\\/]/.test(u) || u.startsWith('\\\\') || u.startsWith('/')) {
    return u.replace(/\\/g, '/').replace(/\/+$/, '')
  }
  // Strip optional scheme, then any userinfo (e.g. `git@`) prefix.
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  u = u.replace(/^[^@/]*@/, '')
  // Canonicalize the scp-style `host:path` form into `host/path` so all clone
  // URL spellings converge — but never rewrite a `host:port` port segment.
  const colon = u.indexOf(':')
  const slash = u.indexOf('/')
  if (colon > 0 && (slash === -1 || colon < slash)) {
    const nextSegment = u.slice(colon + 1).split('/')[0] ?? ''
    if (!/^\d+$/.test(nextSegment)) {
      u = u.slice(0, colon) + '/' + u.slice(colon + 1)
    }
  }
  if (u.endsWith('.git')) u = u.slice(0, -4)
  u = u.replace(/\/+$/, '')
  return u
}

export function normalizeScope(scope?: DiffScope): DiffScope {
  if (!scope) return { kind: 'working', base: 'HEAD' }
  const kind = scope.kind
  switch (kind) {
    case 'working':
      return { kind, base: scope.base || 'HEAD' }
    case 'staged':
      return { kind }
    case 'commit':
      return { kind, ref: scope.ref || 'HEAD' }
    case 'range':
      return { kind, base: scope.base || 'HEAD~1', head: scope.head || 'HEAD' }
    default:
      throw new Error(`unknown diff kind: ${String(kind)}`)
  }
}
