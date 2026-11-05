// 运行时上下文：各模块都从这里拿依赖，便于测试时整体替换（假客户端、假模型、虚拟时钟）。
import type { Config } from './config.js'
import type { Db } from './db/db.js'
import type { Summarizer } from './llm/types.js'
import type { SourceAdapter } from './source/types.js'
import type { Clock } from './time.js'

export interface Ctx {
  db: Db
  clock: Clock
  source: SourceAdapter
  summarizer: Summarizer
  config: Config
  log(message: string): void
}
