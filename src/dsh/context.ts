/**
 * Minimal structural (duck-typed) view of the dsh harness context and the
 * tool-registration contract. Keeping these local means the bundle compiles and
 * tests WITHOUT @deepseek-ai/* installed; the real harness context satisfies
 * these shapes structurally at load time.
 *
 * The authoritative contracts live in @deepseek-ai/cordis and @deepseek-ai/dsh-tools.
 */

export interface ToolParamSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  required?: boolean
  description?: string
  enum?: string[]
  items?: ToolParamSchema
  properties?: Record<string, ToolParamSchema>
}

export interface ToolRunContext {
  signal?: AbortSignal
  agent?: {
    id?: string
    modelId?: string
    session?: { sessionId?: string }
  }
  // Other fields of the real ToolRunContext are intentionally not modelled.
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, ToolParamSchema>
  timeoutMs?: number
  output: {
    schema: Record<string, unknown>
    render(args: Record<string, unknown>, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec: ToolRunContext): Promise<unknown> | unknown
}

/**
 * One stream chunk as surfaced by `ctx.llm.stream`. Per the dsh-llm contract
 * the protocol is a discriminated union; we model the variants we consume and
 * ignore the rest (reasoning deltas must never be mistaken for output text).
 */
export interface LlmChunk {
  type: 'block-start' | 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'block-end' | 'usage' | 'finish'
  /** Present on text-delta (the only variant we read). */
  text?: string
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: Array<{ type: 'text'; text: string }>
}

export interface LlmStreamOptions {
  messages: LlmMessage[]
  provider?: string
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface LlmRuntime {
  stream(options: LlmStreamOptions): AsyncIterable<LlmChunk>
}

/** The subset of the real harness Context this bundle touches. */
export interface MinimalContext {
  tools: {
    register(definition: unknown): () => void
  }
  get<T = unknown>(key: string): T | undefined
  effect(fn: () => () => void): void
}
