/**
 * review-gate core domain types.
 *
 * These types are deliberately framework-agnostic: the dsh adapter, the CLI and
 * the programmatic API all speak this same vocabulary, so the gate stays
 * deterministic no matter which surface invokes it.
 */

/** Severity classification of a review finding. */
export type Severity = 'severe' | 'warning' | 'suggestion'

/** Where a finding came from. Deterministic rules never depend on a model. */
export type FindingSource = 'static' | 'llm' | 'manual'

/**
 * The kind of diff a review session targets.
 * - `working`  : working tree vs HEAD (`git diff HEAD`)
 * - `staged`   : staged changes vs HEAD (`git diff --cached`)
 * - `commit`   : a single commit vs its parent (`git show <ref>`)
 * - `range`    : any base..head range (`git diff base head`)
 */
export type DiffKind = 'working' | 'staged' | 'commit' | 'range'

/** A single review finding inside a session. */
export interface ReviewFinding {
  /** Deterministic, stable id derived from (file, rule, severity, content). */
  id: string
  severity: Severity
  /** The rule that produced this finding (or the LLM prompt id for llm findings). */
  rule: string
  /** The file the finding is attached to (path as reported by git). */
  file: string
  /** Added-line anchors if the finding maps onto changed lines. */
  lines: number[]
  /** Human readable description. */
  message: string
  /** Optional remediation hint. */
  suggestion?: string
  source: FindingSource
  /** Creation timestamp (epoch ms). */
  createdAt: number
}

/** A human acknowledgement that moves a finding out of the failure set. */
export interface Acknowledgement {
  findingId: string
  /** An arbitrary identifier of the reviewer (email, id, ...). */
  reviewer: string
  reason: string
  /** The round this acknowledgement applies to (mirrors vote round scoping). */
  round: number
  createdAt: number
}

/** A team approval/review decision for the current round. */
export type ReviewDecision = 'approve' | 'request_changes' | 'reject'

export interface ReviewVote {
  reviewer: string
  decision: ReviewDecision
  comment?: string
  /** The round this vote applies to. */
  round: number
  createdAt: number
}

/** The review status of a session (merge-unlock semantics in README). */
export type SessionStatus = 'open' | 'passed' | 'blocked' | 'approved'

/** Severity counters used by the deterministic gate. */
export interface FindingCounts {
  severe: number
  warning: number
  suggestion: number
  total: number
}

/** Static description of the diff a session reviews. */
export interface DiffScope {
  kind: DiffKind
  /** Commit ref for `commit` kind. */
  ref?: string
  /** Base ref for `range` / `working` / `staged` kind (default HEAD). */
  base?: string
  /** Head ref for `range` kind. */
  head?: string
}

/** The on-disk representation of a review session. */
export interface ReviewSession {
  /** Storage key (derived from a stable repo identity + scope). */
  id: string
  /** The working-directory path of the reviewed checkout (for display). */
  repoPath: string
  /** Stable repo identity used to key sessions (remote url / toplevel / path). */
  repoId: string
  scope: DiffScope
  /** Monotonic round counter. Bumped whenever the reviewed content changes. */
  round: number
  /** Fingerprint of the reviewed diff + rules; unchanged content reuses a round. */
  fingerprint: string
  /** The rules version in effect when the latest round was produced. */
  rulesVersion: string
  /** Findings of the latest round. */
  findings: ReviewFinding[]
  /** Acknowledgements; only those whose round equals `round` are live. */
  acknowledgements: Acknowledgement[]
  /** Team votes. Only votes whose round equals `round` are live. */
  votes: ReviewVote[]
  /**
   * The derived status. Recomputed deterministically from the fields above;
   * persisted for fast reads but never trusted without recomputation.
   */
  status: SessionStatus
  /** When the latest round was produced (epoch ms). */
  updatedAt: number
  /** When the session was first created (epoch ms). */
  createdAt: number
}

/** Verdict produced by {@link evaluateSession}. */
export interface SessionVerdict {
  status: SessionStatus
  /** autoPass: deterministic severity + acknowledgment rules satisfied. */
  autoPass: boolean
  /** Counts of ACKNOWLEDGED-exempt findings (the ones the caps apply to). */
  activeCounts: FindingCounts
  /** Counts of ALL findings (including acknowledged ones). */
  totalCounts: FindingCounts
  /** Deterministic reasons explaining the verdict. */
  reasons: string[]
  /** Approval bookkeeping. */
  approvals: {
    required: number
    current: number
    blocked: boolean
    approvers: string[]
    blockers: string[]
  }
}

/** One immutable audit event. */
export interface AuditEvent {
  /** event type, e.g. `session.created`, `run`, `vote`, `acknowledge`, `export`. */
  type: string
  sessionId: string
  /** Epoch ms. */
  ts: number
  /** Free-form actor (reviewer, CLI user, launcher, ...). */
  actor?: string
  /** Attached payload (severely typed per event type). */
  data: Record<string, unknown>
}
