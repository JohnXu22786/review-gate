import type { AuditEvent, ReviewSession, SessionVerdict } from '../types.js'
import type { GateConfig } from '../config.js'

export interface ReportSource {
  session: ReviewSession
  verdict: SessionVerdict
  audit: AuditEvent[]
  config: GateConfig
  generatedAt: number
}

export interface ReviewReport {
  document: Record<string, unknown>
  json: string
  markdown: string
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/** Build the machine-readable report document (also the JSON payload). */
export function buildReportDocument(src: ReportSource): Record<string, unknown> {
  const { session, verdict, audit } = src
  const liveAcks = session.acknowledgements.filter((a) => a.round === session.round)
  const acked = new Set(liveAcks.map((a) => a.findingId))
  return {
    schema: 'review-gate/report@1',
    generatedAt: iso(src.generatedAt),
    session: {
      id: session.id,
      repoPath: session.repoPath,
      repoId: session.repoId,
      scope: session.scope,
      round: session.round,
      status: verdict.status,
      autoPass: verdict.autoPass,
      rulesVersion: session.rulesVersion,
      fingerprint: session.fingerprint,
      createdAt: iso(session.createdAt),
      updatedAt: iso(session.updatedAt),
    },
    counts: {
      active: verdict.activeCounts,
      total: verdict.totalCounts,
    },
    approvals: verdict.approvals,
    reasons: verdict.reasons,
    findings: session.findings.map((f) => ({
      id: f.id,
      severity: f.severity,
      rule: f.rule,
      file: f.file,
      lines: f.lines,
      message: f.message,
      suggestion: f.suggestion ?? null,
      source: f.source,
      acknowledged: acked.has(f.id),
    })),
    acknowledgements: liveAcks.map((a) => ({
      findingId: a.findingId,
      reviewer: a.reviewer,
      reason: a.reason,
      round: a.round,
      at: iso(a.createdAt),
    })),
    votes: session.votes
      .filter((v) => v.round === session.round)
      .map((v) => ({
        reviewer: v.reviewer,
        decision: v.decision,
        comment: v.comment ?? null,
        at: iso(v.createdAt),
      })),
    audit: audit.map((e) => ({
      type: e.type,
      at: iso(e.ts),
      actor: e.actor ?? null,
      data: e.data,
    })),
  }
}

/** Human readable markdown report for compliance review / filing. */
export function renderMarkdown(src: ReportSource): string {
  const doc = buildReportDocument(src)
  const session = doc.session as Record<string, unknown>
  const findings = doc.findings as Array<Record<string, unknown>>
  const approvals = doc.approvals as Record<string, unknown>
  const lines: string[] = []

  lines.push(`# Code Review Gate Report`, ``)
  lines.push(`- **Repo**: \`${String(session.repoPath ?? '')}\``)
  lines.push(`- **Repo id**: \`${String(session.repoId ?? '')}\``)
  lines.push(`- **Scope**: ${describeScope(String(JSON.stringify(session.scope)))}`)
  lines.push(`- **Status**: \`${String(session.status)}\` (auto ${String(session.autoPass) ? 'pass' : 'block'})`)
  lines.push(`- **Round**: ${String(session.round)} — **Rules version**: \`${String(session.rulesVersion)}\``)
  lines.push(`- **Generated at**: ${String(doc.generatedAt)}`, ``)

  lines.push(`## Counts`)
  const counts = doc.counts as Record<string, Record<string, number>>
  lines.push(
    `| severity | active | total |`,
    `| --- | --- | --- |`,
    `| severe | ${counts.active.severe} | ${counts.total.severe} |`,
    `| warning | ${counts.active.warning} | ${counts.total.warning} |`,
    `| suggestion | ${counts.active.suggestion} | ${counts.total.suggestion} |`,
    ``,
  )

  lines.push(`## Approvals`)
  lines.push(`- Required: ${String(approvals.required)} — current: ${String(approvals.current)}`)
  lines.push(`- Approvers: ${String((approvals.approvers as string[]).join(', ') || '—')}`)
  lines.push(`- Blockers: ${String((approvals.blockers as string[]).join(', ') || '—')}`, ``)

  lines.push(`## Reasons`)
  for (const r of doc.reasons as string[]) lines.push(`- ${r}`)
  lines.push('')

  lines.push(`## Findings (${findings.length})`)
  for (const f of findings) {
    const badge = f.acknowledged ? '~(acknowledged)~' : ''
    const where = `${f.file}${Array.isArray(f.lines) && (f.lines as number[]).length > 0 ? `:${(f.lines as number[]).join(',')}` : ''}`
    lines.push(`- **[${String(f.severity)}]** \`${String(f.rule)}\` ${where} ${badge}: ${String(f.message)}`)
    if (f.suggestion) lines.push(`  - ${String(f.suggestion)}`)
  }
  lines.push('')

  const audit = doc.audit as Array<{ type: string; at: string; actor: string | null; data: Record<string, unknown> }>
  lines.push(`## Audit trail (${audit.length})`)
  for (const e of audit) {
    lines.push(`- ${e.at} \`${e.type}\` by ${e.actor ?? '?'} — ${safeJson(e.data)}`)
  }
  lines.push('')

  return lines.join('\n')
}

export function renderReport(src: ReportSource): ReviewReport {
  const document = buildReportDocument(src)
  return {
    document,
    json: JSON.stringify(document, null, 2),
    markdown: renderMarkdown(src),
  }
}

function describeScope(json: string): string {
  try {
    const scope = JSON.parse(json) as { kind: string; ref?: string; base?: string; head?: string }
    switch (scope.kind) {
      case 'working':
        return `working tree vs ${scope.base ?? 'HEAD'}`
      case 'staged':
        return 'staged changes'
      case 'commit':
        return `commit ${scope.ref}`
      case 'range':
        return `${scope.base}..${scope.head}`
      default:
        return scope.kind
    }
  } catch {
    return json
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
