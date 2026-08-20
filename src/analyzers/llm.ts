import type { Severity } from '../types.js'

/** One file's context handed to the LLM reviewer. */
export interface FileContext {
  path: string
  /** Added lines in order (with their new-file line numbers). */
  addedLines: Array<{ line: number; text: string }>
}

export interface LlmReviewRequest {
  files: FileContext[]
  options: {
    temperature: number
    maxFindingsPerFile: number
  }
  signal?: AbortSignal
}

/** A structured finding draft originating from the LLM reviewer. */
export interface LlmDraft {
  severity: Severity
  file: string
  message: string
  suggestion?: string
}

/**
 * The seam between the deterministic gate and any model-backed reviewer.
 * Implementations must never influence the gate directly: their output is only
 * turned into `ReviewFinding`s, and {@link runStaticAnalysis} findings still
 * rule the thresholds.
 */
export interface LlmGateway {
  /** Provider label recorded in audit events. */
  readonly label: string
  generate(request: LlmReviewRequest): Promise<LlmDraft[]>
}

/** Build the exact prompt passed to the model. Pure, unit-testable. */
export function buildLlmPrompt(files: FileContext[]): string {
  if (files.length === 0) return ''
  return [
    'You are a strict, read-only code reviewer. You are shown ADDED lines of code only.',
    'Report concrete, actionable findings. Obey these rules strictly:',
    '- Return ONLY a single JSON array. No markdown, no commentary.',
    '- Each element: {"file": "<exact file path>", "severity": "severe"|"warning"|"suggestion", "message": "<what is wrong>", "suggestion": "<how to fix>"}',
    '- "severe" is reserved for definite bugs or security problems; "warning" for likely issues; "suggestion" for style/improvement.',
    '- Base every finding on the shown added lines; never invent code that is not shown.',
    '- A file with no real problem must not appear in the output.',
    '- Keep messages short (under 200 characters).',
    '>>>',
    '',
    formatFilesForPrompt(files),
    '',
    '<<<',
    'OUTPUT JSON ARRAY (nothing else):',
  ].join('\n')
}

function formatFilesForPrompt(files: FileContext[]): string {
  return files
    .map((f) => {
      const body = f.addedLines.map((l) => `${l.line}: ${l.text}`).join('\n')
      return `### FILE: ${f.path}\n${body.length > 0 ? body : '(no added lines)'}`
    })
    .join('\n\n')
}

/**
 * Parse the model's JSON-array reply into validated drafts. Best-effort:
 * tolerates surrounding markdown fences and trailing commas, drops malformed
 * entries and files unknown to the request.
 */
export function parseLlmDrafts(text: string, request: LlmReviewRequest): LlmDraft[] {
  const knownFiles = new Set(request.files.map((f) => f.path))
  const cleaned = stripToJsonArray(text)
  if (cleaned === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    // Try removing trailing commas, a common model output quirk.
    try {
      parsed = JSON.parse(cleaned.replace(/,\s*([\]}])/g, '$1'))
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []

  const drafts: LlmDraft[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    if (typeof obj.file !== 'string' || !knownFiles.has(obj.file)) continue
    if (typeof obj.message !== 'string' || obj.message.trim().length === 0) continue
    const severity = normalizeSeverity(obj.severity)
    if (!severity) continue
    drafts.push({
      severity,
      file: obj.file,
      message: obj.message.trim().slice(0, 300),
      suggestion: typeof obj.suggestion === 'string' ? obj.suggestion.slice(0, 500) : undefined,
    })
  }

  // Enforce per-file / global caps while preserving order.
  const perFile: Record<string, number> = {}
  const capped: LlmDraft[] = []
  for (const draft of drafts) {
    const used = perFile[draft.file] ?? 0
    if (used >= request.options.maxFindingsPerFile) continue
    perFile[draft.file] = used + 1
    capped.push(draft)
  }
  return capped
}

function stripToJsonArray(text: string): string | null {
  const t = text.trim()
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : t
  if (!candidate.startsWith('[')) return null
  return candidate
}

function normalizeSeverity(value: unknown): Severity | null {
  if (value === 'severe' || value === 'warning' || value === 'suggestion') return value
  return null
}
