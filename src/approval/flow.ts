import type { ReviewDecision, ReviewSession, ReviewVote } from '../types.js'
import type { GateConfig } from '../config.js'

export interface VoteInput {
  reviewer: string
  decision: ReviewDecision
  comment?: string
  now: number
}

export interface ApprovalSummary {
  required: number
  current: number
  approvers: string[]
  blockers: string[]
  blocked: boolean
  liveVotes: ReviewVote[]
}

/**
 * Apply a review decision to a session. Semantics:
 * - A decision always applies to the CURRENT round: a reviewer voting on stale
 *   content implicitly votes on the state as of now.
 * - Last-writer-wins per reviewer within the round: a second `approve` after
 *   `reject` replaces the old vote (and vice versa), so votes never stack.
 * - Returns a NEW session object (immutable-ish update) for the caller to persist.
 */
export function applyVote(session: ReviewSession, input: VoteInput): ReviewSession {
  if (input.reviewer.trim().length === 0) throw new Error('reviewer must not be empty')
  const vote: ReviewVote = {
    reviewer: input.reviewer,
    decision: input.decision,
    comment: input.comment?.trim().slice(0, 1000) || undefined,
    round: session.round,
    createdAt: input.now,
  }

  if (session.round === 0) {
    // No review has been run yet: votes would apply to nothing, reject loudly.
    throw new Error('cannot vote on a session that has not been reviewed yet (run a review first)')
  }

  const existingIndex = session.votes.findIndex(
    (v) => v.reviewer === input.reviewer && v.round === session.round,
  )
  if (existingIndex >= 0) {
    const previous = session.votes[existingIndex]!
    const identical =
      previous.decision === vote.decision &&
      (previous.comment ?? '') === (vote.comment ?? '')
    if (identical) return session // idempotent no-op
    const votes = [...session.votes]
    votes[existingIndex] = vote
    return { ...session, votes }
  }

  return { ...session, votes: [...session.votes, vote] }
}

/**
 * Summary of the live (current-round) approval state. `blocked` is true when any
 * current-round vote carries a negative decision; approvals count only
 * distinctive approvers whose LATEST live decision is `approve`.
 */
export function approvalSummary(session: ReviewSession, config: GateConfig): ApprovalSummary {
  const live = session.votes.filter((v) => v.round === session.round)
  const latestByReviewer = new Map<string, ReviewVote>()
  for (const vote of live) latestByReviewer.set(vote.reviewer, vote)

  const approvers: string[] = []
  const blockers: string[] = []
  for (const vote of latestByReviewer.values()) {
    if (vote.decision === 'approve') approvers.push(vote.reviewer)
    else blockers.push(vote.reviewer)
  }
  approvers.sort()
  blockers.sort()

  return {
    required: config.approvals.required,
    current: approvers.length,
    approvers,
    blockers,
    blocked: blockers.length > 0,
    liveVotes: [...live].sort((a, b) => a.createdAt - b.createdAt),
  }
}
