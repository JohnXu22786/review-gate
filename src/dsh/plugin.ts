import { JsonFileStore } from '../store/json.js'
import { GitRunner } from '../git/runner.js'
import { ReviewGate } from '../service/reviewGate.js'
import type { GateConfig } from '../config.js'
import { resolveConfig } from '../config.js'
import { buildTools } from './tools.js'
import { DshLlmGateway } from './llmGateway.js'
import type { MinimalContext } from './context.js'

export { ReviewGate, GitRunner, JsonFileStore, MemoryStore } from '../index.js'
export type { GateConfig } from '../config.js'
export { resolveConfig } from '../config.js'
export { buildTools } from './tools.js'
export { DshLlmGateway } from './llmGateway.js'

/**
 * review-gate dsh bundle entry.
 *
 * Mounts the deterministic code-review gate as `ctx.tools`:
 * review_run / review_status / review_approve / review_request_changes /
 * review_reject / review_acknowledge / gate_check / review_export.
 *
 * Configuration (optional, from the `config:` block of the mounted row):
 * ```json
 * {
 *   "cwd": "/path/to/repo",            // where to run git; default process.cwd()
 *   "store": { "root": ".review-gate" },
 *   "gate":  { "severe": 0, "warning": 0, "suggestion": -1 },
 *   "approvals": { "required": 2 },
 *   "llm":   { "enabled": true }
 * }
 * ```
 */
export const name = 'review-gate'

/** Required services: only the tool registry is mandatory. */
export const inject = ['tools']

export function apply(ctx: MinimalContext, rawConfig?: unknown): void {
  const config = resolveConfig(toPartial(rawConfig))

  const store = new JsonFileStore({ root: config.store.root, useFileLock: true })
  const git = new GitRunner({ cwd: config.cwd })
  // Resolve ctx.llm lazily at call time so a later-mounted llm row is found.
  const llm = config.llm.enabled ? new DshLlmGateway(() => ctx.get('llm'), { provider: config.llm.provider, model: config.llm.model }) : undefined

  const gate = new ReviewGate({ config, store, git, llm })

  for (const tool of buildTools(gate)) {
    ctx.tools.register(tool)
  }

  // Tear the store down with the plugin fiber.
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => void store.close())
  }
}

function toPartial(raw: unknown): Partial<GateConfig> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('review-gate config must be an object')
  }
  return raw as Partial<GateConfig>
}
