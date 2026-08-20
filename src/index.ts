/**
 * review-gate programmatic API.
 *
 * Consumers that run OUTSIDE a dsh harness (the CLI, CI jobs, custom scripts)
 * should use {@link ReviewGate} directly:
 *
 *   const gate = new ReviewGate({
 *     config, store, git,
 *     llm: myLlmGateway,   // optional
 *   })
 *   await gate.run({ scope })
 *   await gate.gateCheck({ mode: 'merge' })
 *
 * The dsh harness entry point is the package root (`exports["."]` →
 * `dist/dsh/plugin.js`) and mounts the same logic as ctx.tools; see
 * `review-gate` docs for the bundle integration. This module is the
 * framework-agnostic API for CLI / CI / custom scripts.
 */

export * from './types.js'
export * from './config.js'
export { ReviewGate } from './service/reviewGate.js'
export type {
  RunOptions,
  VoteOptions,
  AcknowledgeOptions,
  GateCheckOptions,
  RunOutcome,
  StatusOutcome,
  VoteOutcome,
  GateCheckOutcome,
  ReviewMode,
} from './service/reviewGate.js'
export { evaluateSession } from './service/evaluate.js'
export { evaluateAutoGate } from './gate/engine.js'
export { applyVote, approvalSummary } from './approval/flow.js'
export { runStaticAnalysis, findingId } from './analyzers/static.js'
export { parseLlmDrafts, buildLlmPrompt } from './analyzers/llm.js'
export type { LlmGateway, LlmDraft, LlmReviewRequest, FileContext } from './analyzers/llm.js'
export { parseDiff } from './git/diff.js'
export type { ParsedDiff, ParsedFileDiff, DiffHunk, DiffLine } from './git/diff.js'
export { GitRunner, defaultExec } from './git/runner.js'
export type { GitRunnerOptions, ExecFn, ExecResult } from './git/runner.js'
export type { Store } from './store/types.js'
export { MemoryStore } from './store/memory.js'
export { JsonFileStore } from './store/json.js'
export type { JsonStoreOptions } from './store/json.js'
export { FileLock } from './store/lock.js'
export { buildReportDocument, renderMarkdown, renderReport } from './audit/report.js'
export type { ReportSource, ReviewReport } from './audit/report.js'
