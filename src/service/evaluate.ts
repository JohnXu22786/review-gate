import type { ReviewSession, SessionStatus, SessionVerdict } from '../types.js'
import type { GateConfig } from '../config.js'
import { evaluateAutoGate } from '../gate/engine.js'
import { approvalSummary } from '../approval/flow.js'

/**
 * Combine the deterministic auto-gate and the human approval state into one
 * authoritative verdict + derived session status. Pure and recomputable: the
 * persisted `session.status` must always equal `evaluateSession(session).status`.
 */
export function evaluateSession(session: ReviewSession, config: GateConfig): SessionVerdict {
  const auto = evaluateAutoGate(session, config)
  const approvals = approvalSummary(session, config)
  const reasons = [...auto.reasons]

  let status: SessionStatus
  if (session.round === 0) {
    status = 'open'
  } else if (auto.autoPass && !approvals.blocked && approvals.current >= approvals.required) {
    status = 'approved'
    reasons.push(`approvals ${approvals.current}/${approvals.required}`)
  } else if (auto.autoPass && !approvals.blocked) {
    status = 'passed'
    reasons.push(`approvals ${approvals.current}/${approvals.required}`)
  } else {
    status = 'blocked'
  }

  if (approvals.blocked && auto.autoPass) {
    reasons.push(`negative vote(s) by: ${approvals.blockers.join(', ')}`)
  }

  return { status, autoPass: auto.autoPass, activeCounts: auto.activeCounts, totalCounts: auto.totalCounts, reasons, approvals }
}
