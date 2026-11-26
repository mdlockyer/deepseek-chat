export type ModelId = string
export type ProviderId = string

export type ModelCapabilities = {
  readonly thinking: boolean
  readonly vision: boolean
  readonly documents: boolean
  readonly tools: boolean
  readonly promptCaching: boolean
}

export type ModelSpec = {
  readonly id: ModelId
  readonly provider: ProviderId
  readonly label: string
  /** Maximum total context window tokens (input + output). */
  readonly contextWindow: number
  /** Maximum output tokens the model can produce in one response. */
  readonly maxOutputTokens: number
  readonly capabilities: ModelCapabilities
}

export const DEFAULT_DEEPSEEK_MODEL: ModelId = 'deepseek-flash'

const DEFAULT_FALLBACK_CAPABILITIES: ModelCapabilities = {
  thinking: true,
  vision: true,
  documents: true,
  tools: true,
  promptCaching: false,
}

export const DEEPSEEK_MODELS: readonly ModelSpec[] = [
  {
    id: 'deepseek-flash',
    provider: 'deepseek',
    label: 'DeepSeek Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 393_216,
    capabilities: {
      thinking: true,
      vision: true,
      documents: true,
      tools: true,
      promptCaching: true,
    },
  },
]

export const resolveModelSpec = (
  models: readonly ModelSpec[],
  providerId: ProviderId,
  modelId: ModelId,
  fallbackOverrides?: Partial<Pick<ModelSpec, 'contextWindow' | 'maxOutputTokens'>>
): ModelSpec => {
  const exact = models.find((spec) => spec.id === modelId)
  if (exact) {
    return exact
  }
  return {
    id: modelId,
    provider: providerId,
    label: modelId,
    contextWindow: fallbackOverrides?.contextWindow ?? 128_000,
    maxOutputTokens: fallbackOverrides?.maxOutputTokens ?? 16_384,
    capabilities: DEFAULT_FALLBACK_CAPABILITIES,
  }
}
