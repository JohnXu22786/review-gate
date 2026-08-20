import type { FindingCounts, ReviewFinding, ReviewSession } from '../types.js'
import type { GateConfig } from '../config.js'

export interface AutoGateResult {
  autoPass: boolean
  /** Counts of findings that are NOT acknowledged (subject to caps). */
  activeCounts: FindingCounts
  /** Counts of all findings. */
  totalCounts: FindingCounts
  reasons: string[]
}

/**
 * Deterministic gate evaluation. This is the ONLY authority for whether the
 * automated thresholds pass — it never consults a model.
 */
export function evaluateAutoGate(session: ReviewSession, config: GateConfig): AutoGateResult {
  const acked = liveAcknowledgements(session)
  const isAcked = (f: ReviewFinding) => acked.has(f.id)

  const total = countFindings(session.findings, () => true)
  const active = countFindings(session.findings, (f) => !isAcked(f))
  const reasons: string[] = []

  const check = (severity: 'severe' | 'warning' | 'suggestion', allowed: number, actual: number) => {
    if (allowed < 0) return true
    if (actual > allowed) {
      reasons.push(`${actual} unacknowledged ${severity} finding(s) exceed the cap of ${allowed}`)
      return false
    }
    return true
  }

  const capsOk =
    check('severe', config.gate.severe, active.severe) &&
    check('warning', config.gate.warning, active.warning) &&
    check('suggestion', config.gate.suggestion, active.suggestion)

  const requiredOk = requiredAcknowledgeOk(session, config, reasons)

  const autoPass = capsOk && requiredOk
  return { autoPass, activeCounts: active, totalCounts: total, reasons }
}

function countFindings(findings: ReviewFinding[], include: (f: ReviewFinding) => boolean): FindingCounts {
  const c: FindingCounts = { severe: 0, warning: 0, suggestion: 0, total: 0 }
  for (const f of findings) {
    if (!include(f)) continue
    c[f.severity] += 1
    c.total += 1
  }
  return c
}

/** Acknowledgements valid for the CURRENT round only (mirrors votes). */
function liveAcknowledgements(session: ReviewSession): Set<string> {
  return new Set(session.acknowledgements.filter((a) => a.round === session.round).map((a) => a.findingId))
}

function requiredAcknowledgeOk(
  session: ReviewSession,
  config: GateConfig,
  reasons: string[],
): boolean {
  const acked = liveAcknowledgements(session)
  let ok = true
  for (const token of config.gate.requiredAcknowledge) {
    if (token === 'severe') {
      const missing = session.findings
        .filter((f) => f.severity === 'severe')
        .filter((f) => !acked.has(f.id))
        .map((f) => f.id)
      if (missing.length > 0) {
        reasons.push(`required acknowledgement missing for severe findings: ${missing.join(', ')}`)
        ok = false
      }
      continue
    }
    // token is a concrete finding id
    const relevant = session.findings.find((f) => f.id === token)
    if (relevant && !acked.has(token)) {
      reasons.push(`required acknowledgement missing for finding ${token}`)
      ok = false
    }
  }
  return ok
}
