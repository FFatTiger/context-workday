// 按配置返回摘要器：'mock' → mock.ts；OpenAI 兼容配置 → openai.ts。
import type { LlmConfig } from '../config.js'
import { createMockSummarizer } from './mock.js'
import { createOpenAiSummarizer } from './openai.js'
import type { Summarizer } from './types.js'

export function createSummarizer(config: 'mock' | LlmConfig): Summarizer {
  if (config === 'mock') return createMockSummarizer()
  return createOpenAiSummarizer(config)
}
