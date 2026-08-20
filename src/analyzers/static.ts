import { createHash } from 'node:crypto'
import type { ParsedFileDiff } from '../git/diff.js'
import type { ReviewFinding } from '../types.js'
import type { RuleSet, StaticRule } from '../config.js'

/** group key used for id stability and de-duplication. */
function groupKey(file: string, rule: StaticRule, normalized: string): string {
  return `${file}\u0000${rule.id}\u0000${normalized}`
}

/** Deterministic finding id derived from content, stable across identical diffs. */
export function findingId(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 16)
}

function normalizeLine(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * Run the deterministic, model-free static analyzers over the added lines of
 * each file. Findings that would merge (same file, same rule, same normalized
 * added content) are collapsed into a single finding carrying all line anchors.
 */
export function runStaticAnalysis(
  files: ParsedFileDiff[],
  rules: RuleSet,
  now: number,
  limit: number,
): ReviewFinding[] {
  const merged = new Map<string, ReviewFinding>()

  for (const file of files) {
    if (!file.path || file.path === '(merge)') continue

    for (const hunk of file.hunks) {
      for (const line of hunk.added) {
        for (const rule of Object.values(rules)) {
          if (!ruleMatchesFile(rule, file.path)) continue
          let matched: RegExpExecArray | null
          try {
            matched = new RegExp(rule.pattern, 'i').exec(normalizeLine(line.text))
          } catch {
            // Pattern compile errors are rejected at config load; defensive skip.
            continue
          }
          if (!matched) continue

          const key = groupKey(file.path, rule, normalizeLine(line.text))
          const existing = merged.get(key)
          if (existing) {
            if (!existing.lines.includes(line.newLine)) existing.lines.push(line.newLine)
          } else {
            merged.set(key, {
              id: findingId(key),
              severity: rule.severity,
              rule: rule.id,
              file: file.path,
              lines: [line.newLine],
              message: rule.message,
              suggestion: rule.suggestion,
              source: 'static',
              createdAt: now,
            })
          }
          if (merged.size > limit) {
            // Truncate beyond the configured cap; keep deterministic ordering.
            return [...merged.values()].slice(0, limit)
          }
        }
      }
    }
  }

  const findings = [...merged.values()]
  for (const f of findings) f.lines.sort((a, b) => a - b)
  // Deterministic ordering for stable reports.
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.lines[0] - (b.lines[0] ?? 0)))
  return findings
}

function ruleMatchesFile(rule: StaticRule, path: string): boolean {
  if (!rule.files) return true
  try {
    return new RegExp(rule.files).test(path)
  } catch {
    return true
  }
}
