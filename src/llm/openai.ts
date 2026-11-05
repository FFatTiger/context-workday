// OpenAI 兼容摘要器：POST {baseUrl}/chat/completions，用全局 fetch，不加 SDK。
// 网络错误、超时、5xx 按 spec 14 重试 3 次（10s / 30s / 90s，等待可注入，测试里设 0）。
// 输出格式不对抛 SummarizerFormatError，由流水线带 feedback 重试一次；这里不重试格式错误。
import type { LlmConfig } from '../config.js'
import { hourlyMessages, rollupMessages } from './prompts.js'
import { SummarizerFormatError } from './types.js'
import type { DraftItem, RollupOp, Summarizer } from './types.js'

const RETRY_WAITS_MS = [10_000, 30_000, 90_000]
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 网络错误、超时、5xx：可以重试 */
class RetryableError extends Error {}

export interface OpenAiDeps {
  /** 重试等待，测试里注入成 0 */
  sleep?: (ms: number) => Promise<void>
}

interface ChatBody {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature: number
  max_tokens?: number
}

function isRetryable(e: unknown): boolean {
  if (e instanceof RetryableError) return true
  if (e instanceof TypeError) return true // fetch 网络错误
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}

/** 从模型回复里剥出 JSON：容忍 ```json 围栏和前后杂文 */
export function extractJson(text: string): unknown {
  const t = text.trim()
  const tries: string[] = [t]
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) tries.push(fenced[1].trim())
  const a1 = t.indexOf('[')
  const a2 = t.lastIndexOf(']')
  if (a1 >= 0 && a2 > a1) tries.push(t.slice(a1, a2 + 1))
  const o1 = t.indexOf('{')
  const o2 = t.lastIndexOf('}')
  if (o1 >= 0 && o2 > o1) tries.push(t.slice(o1, o2 + 1))
  for (const s of tries) {
    try {
      return JSON.parse(s)
    } catch {
      continue
    }
  }
  throw new SummarizerFormatError('输出不是合法的 JSON')
}

function parseDraftItems(content: string): DraftItem[] {
  const data = extractJson(content)
  if (!Array.isArray(data)) throw new SummarizerFormatError('输出不是 JSON 数组')
  return data.map((raw, i) => {
    const what = `第 ${i + 1} 条`
    if (typeof raw !== 'object' || raw === null) throw new SummarizerFormatError(`${what}不是对象`)
    const { text, refs } = raw as { text?: unknown; refs?: unknown }
    if (typeof text !== 'string' || text.trim() === '') throw new SummarizerFormatError(`${what}缺少 text`)
    if (!Array.isArray(refs) || refs.some((r) => typeof r !== 'string')) throw new SummarizerFormatError(`${what}的 refs 不是字符串数组`)
    return { text: text.trim(), refs: refs as string[] }
  })
}

function parseOps(content: string): RollupOp[] {
  const data = extractJson(content)
  if (!Array.isArray(data)) throw new SummarizerFormatError('输出不是 JSON 数组')
  return data.map((raw, i) => {
    const what = `第 ${i + 1} 项操作`
    if (typeof raw !== 'object' || raw === null) throw new SummarizerFormatError(`${what}不是对象`)
    const o = raw as Record<string, unknown>
    switch (o.op) {
      case 'keep':
      case 'delete':
        if (typeof o.id !== 'number') throw new SummarizerFormatError(`${what}（${o.op}）缺少数字 id`)
        return { op: o.op, id: o.id }
      case 'edit':
        if (typeof o.id !== 'number') throw new SummarizerFormatError(`${what}（edit）缺少数字 id`)
      // fallthrough：edit/add 共用 text/refs 校验
      case 'add': {
        if (typeof o.text !== 'string' || o.text.trim() === '') throw new SummarizerFormatError(`${what}（${o.op}）缺少 text`)
        if (!Array.isArray(o.refs) || o.refs.some((r) => typeof r !== 'string')) throw new SummarizerFormatError(`${what}（${o.op}）的 refs 不是字符串数组`)
        return o.op === 'edit'
          ? { op: 'edit', id: o.id as number, text: (o.text as string).trim(), refs: o.refs as string[] }
          : { op: 'add', text: (o.text as string).trim(), refs: o.refs as string[] }
      }
      default:
        throw new SummarizerFormatError(`${what}的 op 不是 keep/edit/delete/add`)
    }
  })
}

export function createOpenAiSummarizer(config: LlmConfig, deps: OpenAiDeps = {}): Summarizer {
  const sleep = deps.sleep ?? defaultSleep
  const timeoutMs = config.timeoutMs ?? 120_000
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`

  async function request(body: ChatBody): Promise<string> {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      // fetch 网络错误 / 超时（AbortError / TimeoutError）→ 可重试
      if (isRetryable(e)) throw new RetryableError(e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      throw e
    }
    if (res.status >= 500) throw new RetryableError(`HTTP ${res.status}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new SummarizerFormatError('回复里没有文本内容')
    return content
  }

  async function chat(body: ChatBody): Promise<string> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_WAITS_MS[attempt - 1])
      try {
        return await request(body)
      } catch (e) {
        lastErr = e
        if (!isRetryable(e)) throw e
      }
    }
    throw lastErr
  }

  return {
    model: config.model,
    endpoint: config.baseUrl,
    async hourly(input, feedback) {
      return parseDraftItems(await chat({ model: config.model, messages: hourlyMessages(input, feedback), temperature: 0.2 }))
    },
    async rollupFull(input, feedback) {
      return parseDraftItems(await chat({ model: config.model, messages: rollupMessages(input, feedback), temperature: 0.2 }))
    },
    async rollupIncremental(input, feedback) {
      return parseOps(await chat({ model: config.model, messages: rollupMessages(input, feedback), temperature: 0.2 }))
    },
    async ping() {
      const startedAt = Date.now()
      try {
        // 极短请求，不重试
        await request({ model: config.model, messages: [{ role: 'user', content: 'ping' }], temperature: 0, max_tokens: 1 })
        return { ok: true, ms: Date.now() - startedAt }
      } catch (e) {
        return { ok: false, ms: Date.now() - startedAt, error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}
