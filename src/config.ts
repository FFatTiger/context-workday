// 配置：<数据目录>/config.json + 命令行参数。数据目录默认 ~/.context-workday。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export interface LlmConfig {
  /** OpenAI 兼容接口地址，例如 http://llm.corp/v1 */
  baseUrl: string
  apiKey?: string
  model: string
  /** 毫秒，默认 120000 */
  timeoutMs?: number
}

export interface Config {
  dataDir: string
  port: number
  host: string
  /** "mock" 或数据源模块的路径 / 包名（见 docs/intranet.md） */
  source: string
  sourceOptions: Record<string, unknown>
  /** "mock" 或 OpenAI 兼容接口 */
  llm: 'mock' | LlmConfig
  /** 演示模式：mock 数据源 + mock 模型 */
  demo: boolean
}

export interface CliFlags {
  data?: string
  port?: string
  host?: string
  source?: string
  demo?: boolean
}

export function loadConfig(flags: CliFlags): Config {
  const dataDir = resolve(flags.data ?? process.env.CONTEXT_DATA_DIR ?? join(homedir(), '.context-workday'))
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'config.json')
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<Config>) : {}
  const demo = flags.demo ?? fromFile.demo ?? false
  const llm = demo ? 'mock' : (fromFile.llm ?? 'mock')
  if (llm !== 'mock' && process.env.CONTEXT_LLM_API_KEY) llm.apiKey = process.env.CONTEXT_LLM_API_KEY
  return {
    dataDir,
    port: Number(flags.port ?? fromFile.port ?? 4318),
    host: flags.host ?? fromFile.host ?? '127.0.0.1',
    source: demo ? 'mock' : (flags.source ?? fromFile.source ?? 'mock'),
    sourceOptions: fromFile.sourceOptions ?? {},
    llm,
    demo,
  }
}
