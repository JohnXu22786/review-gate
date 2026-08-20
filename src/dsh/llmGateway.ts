import type { LlmDraft, LlmGateway, LlmReviewRequest } from '../analyzers/llm.js'
import { buildLlmPrompt, parseLlmDrafts } from '../analyzers/llm.js'
import type { LlmRuntime, MinimalContext } from './context.js'

export interface DshLlmGatewayOptions {
  provider?: string
  model?: string
}

export type LlmGetter = () => LlmRuntime | undefined

/**
 * DSH-backed LLM reviewer. Bridges the deterministic review engine to the
 * harness model layer (`ctx.llm.stream`).
 *
 * The runtime is resolved lazily at call time through a getter so the plugin
 * picks up `ctx.llm` whenever it becomes available — the harness may mount the
 * llm row after this bundle. This path is strictly advisory: the gate's
 * deterministic thresholds decide pass/fail and never consult the model.
 */
export class DshLlmGateway implements LlmGateway {
  readonly label: string
  private readonly getLlm: LlmGetter
  private readonly provider?: string
  private readonly model?: string

  constructor(getLlm: LlmGetter, opts: DshLlmGatewayOptions = {}) {
    this.getLlm = getLlm
    this.provider = opts.provider
    this.model = opts.model
    this.label = `dsh:${opts.provider ?? 'default'}:${opts.model ?? 'default'}`
  }

  async generate(request: LlmReviewRequest): Promise<LlmDraft[]> {
    this.assertNotAborted(request)
    const llm = this.getLlm()
    if (!llm) throw new Error('llm service is unavailable (ctx.get("llm") returned undefined)')

    const prompt = buildLlmPrompt(request.files)
    if (!prompt) return []

    let text = ''
    const stream = llm.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      provider: this.provider,
      model: this.model,
      temperature: request.options.temperature,
    })

    for await (const chunk of stream) {
      if (request.signal?.aborted) throw new Error('LLM review aborted')
      // Only text deltas carry the output; reasoning deltas must not leak in.
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }

    return parseLlmDrafts(text, request)
  }

  private assertNotAborted(request: LlmReviewRequest): void {
    if (request.signal?.aborted) throw new Error('LLM review aborted')
  }
}
