/**
 * Unified-diff parsing. Pure functions with no I/O so they can be unit tested
 * by feeding sample `git diff` output as strings.
 */

/** A single added or removed line inside a hunk. */
export interface DiffLine {
  /** Line number in the NEW file (-1 for removed lines). */
  newLine: number
  /** Line number in the OLD file (-1 for added lines). */
  oldLine: number
  /** Content without the leading `+`/`-`/space marker. */
  text: string
}

export interface DiffHunk {
  /** New-file start line of the hunk range. */
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  /** Context + added + removed lines in order. */
  lines: DiffLine[]
  /** Only lines marked `+` (additions). */
  added: DiffLine[]
  /** Only lines marked `-` (removals). */
  removed: DiffLine[]
}

export interface ParsedFileDiff {
  /** Path as reported by git (`a/b` vs `b/c`); dual-`/dev/null` tolerated. */
  fromPath: string | null
  toPath: string | null
  /** The conventional display path (usually the toPath). */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  hunks: DiffHunk[]
}

export interface ParsedDiff {
  files: ParsedFileDiff[]
  /** The raw diff text (used for fingerprinting). */
  raw: string
}

const HEADER_RE = /^diff --git a\/(.*) b\/(.*)$/
const INDEX_LINE_RE = /^index [0-9a-f]{7,}\.\.(?:[0-9a-f]{7,}|0{7,})(?: \d+)?$/
const NEW_FILE_RE = /^new file mode \d+$/
const DELETED_FILE_RE = /^deleted file mode \d+$/
const RENAME_FROM_RE = /^rename from (.+)$/
const RENAME_TO_RE = /^rename to (.+)$/
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/

/**
 * Parse unified diff text into files/hunks. Handles:
 * - ordinary `git diff` unified format for one or many files,
 * - combined (`diff --cc`) records: skipped with a single placeholder hunk so
 *   they never corrupt the parsed model (git merge diffs are out of scope).
 */
export function parseDiff(raw: string): ParsedDiff {
  const files: ParsedFileDiff[] = []
  const lines = raw.split(/\r?\n/)
  let current: ParsedFileDiff | null = null
  let hunk: DiffHunk | null = null
  let oldLine = -1
  let newLine = -1

  const flushHunk = () => {
    const currentHunk = hunk
    if (currentHunk) {
      currentHunk.lines.forEach((l) => {
        if (l.oldLine >= 0 && l.newLine < 0) currentHunk.removed.push(l)
        else if (l.oldLine < 0 && l.newLine >= 0) currentHunk.added.push(l)
      })
      if (current) current.hunks.push(currentHunk)
      hunk = null
    }
  }

  const pushCurrent = () => {
    if (current) files.push(current)
    current = null
  }

  for (const line of lines) {
    const diffMatch = line.match(HEADER_RE)
    if (diffMatch) {
      flushHunk()
      pushCurrent()
      current = { fromPath: diffMatch[1] === '/dev/null' ? null : diffMatch[1], toPath: diffMatch[2] === '/dev/null' ? null : diffMatch[2], path: diffMatch[2] === '/dev/null' ? diffMatch[1] : diffMatch[2], status: 'modified', hunks: [] }
      continue
    }

    if (line.startsWith('diff --cc ')) {
      flushHunk()
      pushCurrent()
      // Combined diffs are not reviewed line-by-line; record a marker file.
      current = { fromPath: null, toPath: null, path: '(merge)', status: 'modified', hunks: [] }
      continue
    }

    if (!current) continue

    if (NEW_FILE_RE.test(line)) { current.status = 'added'; continue }
    if (DELETED_FILE_RE.test(line)) { current.status = 'deleted'; continue }
    if (INDEX_LINE_RE.test(line)) { continue }

    const renameFrom = line.match(RENAME_FROM_RE)
    if (renameFrom) { current.fromPath = renameFrom[1]; if (current.status === 'modified') current.status = 'renamed'; continue }
    const renameTo = line.match(RENAME_TO_RE)
    if (renameTo) { current.toPath = renameTo[1]; current.path = renameTo[1]; if (current.status === 'modified') current.status = 'renamed'; continue }

    const hunkMatch = line.match(HUNK_RE)
    if (hunkMatch) {
      flushHunk()
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        lines: [],
        added: [],
        removed: [],
      }
      oldLine = hunk.oldStart
      newLine = hunk.newStart
      continue
    }

    // The `\ ` no-newline marker is never content; skip it anywhere.
    if (line.startsWith('\\ ')) { continue }

    // The `--- a/x` / `+++ b/x` FILE headers only appear between the diff
    // header and the first hunk. Inside an open hunk a content line may itself
    // start with `++ ` / `-- ` (or a bare `--- `), so only skip as headers
    // while no hunk is open.
    if (!hunk && (line.startsWith('--- ') || line.startsWith('+++ '))) { continue }

    if (hunk) {
      const marker = line[0]
      const text = line.slice(1)
      if (marker === '+') {
        hunk.lines.push({ oldLine: -1, newLine, text })
        newLine += 1
      } else if (marker === '-') {
        hunk.lines.push({ oldLine, newLine: -1, text })
        oldLine += 1
      } else if (marker === ' ') {
        hunk.lines.push({ oldLine, newLine, text })
        newLine += 1
        oldLine += 1
      }
    }
  }

  flushHunk()
  pushCurrent()
  return { files, raw }
}
