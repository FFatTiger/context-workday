// 摘要器合同：生成流水线只通过它调用大模型。
// openai.ts 走 OpenAI 兼容接口；mock.ts 不联网、按规则拼出结果，用于演示和测试。
// 流水线负责校验引用、条目上限、重试；摘要器只负责"给输入、拿输出"。

/** 送给模型的一条原文。ref 是本次输入内的编号（"m1"、"e1"、"c1"），模型用它引用 */
export interface SourceLine {
  ref: string
  type: 'im' | 'mail' | 'event'
  time: number
  /** 会话名 / 邮件主题 / 日程标题 */
  where: string
  who: string
  text: string
  /** 上下文消息：仅供理解，不能被引用 */
  contextOnly: boolean
}

export interface HourlyInput {
  /** 例如 "2026-10-29 09:00–10:00" */
  label: string
  me: string
  lines: SourceLine[]
  maxItems: number
}

export interface DraftItem {
  text: string
  refs: string[]
}

/** 下层条目，作为上层摘要的输入。ref 形如 "d3"（本次输入内编号） */
export interface LowerItem {
  ref: string
  /** 例如 "10/29 周四 日结"、"10 月 月摘要" */
  from: string
  text: string
}

/** 上一版本的条目，id 是系列内永久编号 */
export interface PrevItem {
  id: number
  text: string
}

export interface RollupInput {
  level: 'day' | 'week' | 'month' | 'year'
  /** 例如 "第 44 周（10/26–11/1）" */
  label: string
  maxItems: number
  /** 增量时是上一版条目；全量时为空数组 */
  previous: PrevItem[]
  inputs: LowerItem[]
}

export type RollupOp =
  | { op: 'keep'; id: number }
  | { op: 'edit'; id: number; text: string; refs: string[] }
  | { op: 'delete'; id: number }
  | { op: 'add'; text: string; refs: string[] }

export interface Summarizer {
  /** 写进版本记录的模型名 */
  readonly model: string
  /** 小时摘要：从原文生成，最多 maxItems 条 */
  hourly(input: HourlyInput, feedback?: string): Promise<DraftItem[]>
  /** 全量生成上层摘要（日结首次、收尾、手动重建） */
  rollupFull(input: RollupInput, feedback?: string): Promise<DraftItem[]>
  /** 增量更新：逐条给出保留 / 修改 / 删除 / 新增 */
  rollupIncremental(input: RollupInput, feedback?: string): Promise<RollupOp[]>
  /** 设置页"测试连接" */
  ping(): Promise<{ ok: boolean; ms: number; error?: string }>
  /** 设置页"数据去向"：模型地址；mock 返回 null */
  readonly endpoint: string | null
}

/** 输出格式不对时抛这个错，流水线会带着 message 作为 feedback 重试一次 */
export class SummarizerFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SummarizerFormatError'
  }
}
