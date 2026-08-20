import type { DiffScope, ReviewDecision } from '../types.js'
import type { ReviewGate } from '../service/reviewGate.js'
import { normalizeScope } from '../service/reviewGate.js'
import type { ToolDefinition, ToolRunContext } from './context.js'

/**
 * The dsh tool roster wired to {@link ReviewGate}. Each tool returns a
 * machine-readable JSON value (for CI/hooks) and renders a readable summary
 * for the model-facing layer.
 */

const scopeSchema = {
  type: 'object',
  description: 'Which diff to target. Omit for the working tree vs HEAD.',
  properties: {
    kind: { type: 'string', enum: ['working', 'staged', 'commit', 'range'], required: true, description: 'Kind of diff' },
    ref: { type: 'string', description: 'Commit ref for kind=commit' },
    base: { type: 'string', description: 'Base ref (default HEAD or HEAD~1 for range)' },
    head: { type: 'string', description: 'Head ref for kind=range' },
  },
} as const

export function buildTools(gate: ReviewGate): ToolDefinition[] {
  const definitions: ToolDefinition[] = []

  definitions.push(defineTool({
    name: 'review_run',
    description: 'Run a read-only code review of the current git diff (or a specified commit/range), producing graded findings and a deterministic gate verdict.',
    parameters: {
      scope: scopeSchema,
      force: { type: 'boolean', description: 'Force a fresh review round even when the diff is unchanged', required: false },
    },
    async execute(args, exec) {
      const out = await gate.run({ scope: parseScope(args.scope), force: args.force === true, signal: exec?.signal })
      if (!out.ok) return { ok: false, error: out.error }
      return {
        ok: true,
        newSession: out.newSession,
        reusedRound: out.reusedRound,
        hasDiff: out.hasDiff,
        round: out.session.round,
        status: out.verdict.status,
        autoPass: out.verdict.autoPass,
        diffFiles: out.diffFiles,
        counts: out.verdict.activeCounts,
        approvals: {
          required: out.verdict.approvals.required,
          current: out.verdict.approvals.current,
          blockers: out.verdict.approvals.blockers,
        },
        findings: out.session.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          rule: f.rule,
          file: f.file,
          lines: f.lines,
          message: f.message,
        })),
        reasons: out.verdict.reasons,
      }
    },
  }))

  definitions.push(defineTool({
    name: 'review_status',
    description: 'Show the current review status, findings and approval progress for a diff scope.',
    parameters: { scope: scopeSchema },
    async execute(args) {
      const st = await gate.status(parseScope(args.scope))
      if (!st.found || !st.session || !st.verdict) {
        return { ok: true, found: false, status: null, message: 'no review session found for this scope; run `review_run` first' }
      }
      const session = st.session
      const verdict = st.verdict
      return {
        ok: true,
        found: true,
        status: verdict.status,
        autoPass: verdict.autoPass,
        round: session.round,
        counts: verdict.activeCounts,
        approvals: {
          required: verdict.approvals.required,
          current: verdict.approvals.current,
          approvers: verdict.approvals.approvers,
          blockers: verdict.approvals.blockers,
        },
        findings: session.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          rule: f.rule,
          file: f.file,
          lines: f.lines,
          message: f.message,
          acknowledged: session.acknowledgements.some(
            (a) => a.findingId === f.id && a.round === session.round,
          ),
        })),
        reasons: verdict.reasons,
      }
    },
  }))

  definitions.push(voteTool(gate, 'review_approve', 'approve', 'Approve this review, counting toward the approval quorum that unlocks the merge gate.'))
  definitions.push(voteTool(gate, 'review_request_changes', 'request_changes', 'Request changes: blocks the merge until the session is re-reviewed and re-approved.'))
  definitions.push(voteTool(gate, 'review_reject', 'reject', 'Reject this review: blocks the merge gate until the session is re-reviewed.'))

  definitions.push(defineTool({
    name: 'review_acknowledge',
    description: 'Acknowledge a specific finding with a reason, removing it from the failure set for the current round. Audit-trailed.',
    parameters: {
      scope: scopeSchema,
      findingId: { type: 'string', required: true, description: 'Finding id from review_run/review_status output' },
      reviewer: { type: 'string', required: false, description: 'Reviewer identity (defaults to the calling agent)' },
      reason: { type: 'string', required: true, description: 'Why this finding is acceptable' },
    },
    async execute(args, exec) {
      const out = await gate.acknowledge({
        scope: parseScope(args.scope),
        findingId: requireString(args.findingId, 'findingId'),
        reviewer: reviewer(args.reviewer, exec),
        reason: requireString(args.reason, 'reason'),
        actor: reviewer(args.reviewer, exec),
      })
      if (!out.ok) return { ok: false, error: out.error }
      return { ok: true, changed: out.changed, status: out.verdict?.status }
    },
  }))

  definitions.push(defineTool({
    name: 'gate_check',
    description: 'Evaluate the deterministic gate for a diff scope. Returns a machine-readable verdict for CI/hooks. Never mutates state.',
    parameters: {
      scope: scopeSchema,
      mode: { type: 'string', enum: ['gate', 'merge'], required: false, description: "'gate' (default) needs passed; 'merge' additionally needs the approval quorum" },
    },
    async execute(args) {
      const out = await gate.gateCheck({ scope: parseScope(args.scope), mode: args.mode === 'merge' ? 'merge' : 'gate' })
      return {
        found: out.found,
        passed: out.passed,
        status: out.status ?? null,
        counts: out.counts ?? null,
        requiredApprovals: out.requiredApprovals ?? null,
        currentApprovals: out.currentApprovals ?? null,
        blockers: out.blockers ?? [],
        reasons: out.reasons ?? [],
      }
    },
  }))

  definitions.push(defineTool({
    name: 'review_export',
    description: 'Export the compliance report for a diff scope as JSON (and the markdown equivalent). Records the export in the audit trail.',
    parameters: {
      scope: scopeSchema,
      format: { type: 'string', enum: ['json', 'markdown'], required: false, description: 'Report format (default json)' },
    },
    async execute(args) {
      const out = await gate.exportReport({ scope: parseScope(args.scope), actor: 'tool:review_export' })
      if (!out.ok || !out.report) return { ok: false, error: out.error ?? 'export failed' }
      const format = args.format === 'markdown' ? 'markdown' : 'json'
      return {
        ok: true,
        format,
        content: format === 'markdown' ? out.report.markdown : out.report.json,
      }
    },
  }))

  return definitions
}

export function reviewer(value: unknown, exec?: ToolRunContext): string {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  const agentId = exec?.agent?.id
  if (agentId) return `agent:${agentId}`
  return 'anonymous'
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`parameter '${name}' (string) is required`)
  }
  return value.trim()
}

export function parseScope(value: unknown): DiffScope {
  if (value === undefined || value === null) return normalizeScope()
  const raw = value as Record<string, unknown>
  if (typeof raw !== 'object') throw new Error('parameter \'scope\' must be an object')
  const kind = raw.kind as DiffScope['kind'] | undefined
  if (!kind) return normalizeScope()
  switch (kind) {
    case 'working':
      return { kind, base: stringOr(raw.base, 'HEAD') }
    case 'staged':
      return { kind }
    case 'commit':
      return { kind, ref: stringOr(raw.ref, 'HEAD') }
    case 'range':
      return { kind, base: stringOr(raw.base, 'HEAD~1'), head: stringOr(raw.head, 'HEAD') }
    default:
      throw new Error(`unknown scope.kind '${String(kind)}'`)
  }
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

type ToolBody = (args: Record<string, unknown>, exec?: ToolRunContext) => Promise<unknown> | unknown

function defineTool(def: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: ToolBody
}): ToolDefinition {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters as ToolDefinition['parameters'],
    output: {
      schema: {
        type: 'object',
        description: `Machine-readable result of '${def.name}'.`,
        additionalProperties: true,
      },
      render: (_args, value: unknown) => [{ type: 'text', text: renderJson(value) }],
    },
    execute: def.execute as ToolDefinition['execute'],
  }
}

function voteTool(
  gate: ReviewGate,
  name: string,
  decision: ReviewDecision,
  description: string,
): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: {
      scope: scopeSchema,
      reviewer: { type: 'string', required: false, description: 'Reviewer identity (defaults to the calling agent)' },
      comment: { type: 'string', required: false, description: 'Optional comment recorded in the audit trail' },
    },
    async execute(args, exec) {
      const out = await gate.vote({
        scope: parseScope(args.scope),
        decision,
        reviewer: reviewer(args.reviewer, exec),
        comment: typeof args.comment === 'string' ? args.comment : undefined,
        actor: reviewer(args.reviewer, exec),
      })
      if (!out.ok) return { ok: false, error: out.error }
      return {
        ok: true,
        changed: out.changed,
        decision,
        status: out.verdict?.status,
        approvals: out.verdict
          ? {
              required: out.verdict.approvals.required,
              current: out.verdict.approvals.current,
              approvers: out.verdict.approvals.approvers,
              blockers: out.verdict.approvals.blockers,
            }
          : null,
      }
    },
  })
}

function renderJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
