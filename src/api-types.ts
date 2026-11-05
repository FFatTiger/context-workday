// HTTP 接口合同（spec 第 13 节）。前端 web/ 和服务端 src/server/ 都从这里取类型。
// 所有路径以 /api 开头，JSON 进出。时间是 epoch 毫秒；周期键见 src/time.ts。
// 错误一律返回 { error: string }，HTTP 状态 4xx/5xx。
// 演示脱敏开启时，服务端在出口统一替换人名、群名、金额、邮箱（前端不做脱敏）。

import type { Level } from './time.js'

export type { Level }
export type Trigger = 'scheduled' | 'catchup' | 'close' | 'manual' | 'late' | 'startup'
export type GenMode = 'incremental' | 'full'
export type RawType = 'im' | 'mail' | 'event'
export type LostReason = 'backup_gap' | 'gone_at_backup' | 'expired_unbacked'
export type BackupSource = 'im' | 'mail' | 'calendar'

/** 指向某个版本里的某个条目 */
export interface ItemRef {
  level: Level
  period: string
  version: number
  itemId: number
}

export interface ItemView {
  itemId: number
  text: string
  /** 本版操作；回顾页显示 "v4 新增 / v4 修改" */
  op: 'keep' | 'edit' | 'add'
  /** 小时条目：按类型计数；上层条目：只有 evidence */
  counts: { evidence: number; im?: number; mail?: number; event?: number }
  /** 证据链下已降级的小时条目个数 */
  degraded: number
}

export interface VersionMeta {
  version: number
  createdAt: number
  trigger: Trigger
  mode: GenMode
  isFinal: boolean
  model: string
}

// ───────── 1. 某天时间线  GET /api/timeline?date=YYYY-MM-DD ─────────
export interface HourBlock {
  period: string // 2026-10-29T09
  hour: number // 9
  state: 'ok' | 'generating' | 'failed'
  error?: string
  version?: VersionMeta // state=ok 时有
  items: ItemView[]
  /** 本小时与我有关的原文数（活动条柱高） */
  related: number
}
export interface TimelineResponse {
  date: string
  isToday: boolean
  now: number
  nextHourlyAt: number | null
  hours: HourBlock[]
  /** 连续的空档区间，例如 [{from: 12, to: 14}] 表示 12:00–14:00 无记录（to 不含） */
  gaps: Array<{ from: number; to: number }>
  /** 0–23 每小时与我有关的原文数，供活动条使用 */
  activity: number[]
}

// ───────── 2. 摘要卡片  GET /api/card?level=hour|day|week|month|year&period=… 或 &date=YYYY-MM-DD [&version=N] ─────────
// 带 version 时返回该历史版本的条目（回顾页选中版本轨时用），不带返回当前版本
export interface CardResponse {
  level: Level
  period: string
  /** 例如 "10/26 – 10/29"（进行中的周期截至今天） */
  rangeLabel: string
  state: 'none' | 'generating' | 'ok' | 'failed' | 'empty'
  /** state=none：计划生成时间 */
  scheduledAt?: number
  error?: string
  version?: VersionMeta
  upstreamChanged: boolean
  items: ItemView[]
  /** 例如 4 = "依据 4 份日结" */
  inputCount: number
  /** 仅日结：当天消息统计 */
  dayStats?: { totalMsgs: number; relatedMsgs: number; hours: number }
}

// ───────── 3. 证据链  GET /api/evidence?level&period&version&itemId[&expand=raw] ─────────
export type EvidenceNode =
  | {
      kind: 'item'
      ref: ItemRef
      /** 等宽显示的日期或时间，例如 "10/29"、"15:00" */
      when: string
      levelName: string // 小时摘要 / 日结 / 周摘要 / 月摘要
      text: string
      /** 引用的是旧版本时 */
      latestVersion?: number
      degraded?: { generatedAt: number; reason: LostReason; count: number }
      children?: EvidenceNode[] // 只有展开后才有
    }
  | { kind: 'im'; id: string; session: string; sender: string; time: number; text: string; isMine: boolean }
  | { kind: 'mail'; id: string; subject: string; from: string; to: string; time: number }
  | { kind: 'event'; id: string; title: string; start: number; end: number; attendeeCount: number }
  | {
      kind: 'lost'
      rawType: RawType
      id: string // 第一条判定丢失的原文（合并框取最先判定的那条）
      reason: LostReason
      /** 合并的丢失原文条数（票 11：同一小时条目下只出一个降级框） */
      count: number
      /** 该小时条目自己的文本，作为“AI 当时概述” */
      text: string
      generatedAt: number
      /** 丢失原因不一时为 true：前端在原因后写“等 N 条” */
      mixedReasons?: boolean
    }
  | { kind: 'unreadable'; rawType: RawType; id: string }
  | { kind: 'more'; count: number }
export interface EvidenceResponse {
  /** itemIndex：条目在该版本里的序号（从 1 起），抽屉头部显示“第 N 条” */
  item: ItemRef & { text: string; levelName: string; createdAt: number; itemIndex: number; degraded?: { generatedAt: number; reason: LostReason; count: number } }
  /** 祖先路径，例如 本月 v16 › 本周 v4 › 今天 v1 › 09:00 */
  path: Array<{ label: string; ref?: ItemRef }>
  totals: { items: number; im: number; mail: number; event: number; degraded: number }
  nodes: EvidenceNode[]
}

// ───────── 4. 原文上下文  GET /api/raw/im/:id/context ─────────
export interface ImContextResponse {
  session: string
  messages: Array<{ id: string; sender: string; time: number; text: string; isMine: boolean; isTarget: boolean }>
}
// 邮件、日程详情  GET /api/raw/mail/:id   GET /api/raw/event/:id
export interface MailDetail {
  id: string
  subject: string
  from: string
  to: string[]
  cc: string[]
  time: number
  text: string
  folder: string
}
export interface EventDetail {
  id: string
  title: string
  start: number
  end: number
  location: string
  organizer: string
  attendees: Array<{ name: string; response: string }>
  notes: string
}

// ───────── 5. 版本列表  GET /api/series/:level/:period/versions ─────────
export interface VersionListItem extends VersionMeta {
  changes: { added: number; edited: number; deleted: number }
  /** 例如 "并入周四日结" */
  inputNote: string
}
export interface VersionListResponse {
  level: Level
  period: string
  upstreamChanged: boolean
  versions: VersionListItem[] // 新 → 旧
}

// ───────── 6. 版本对比  GET /api/series/:level/:period/diff?a=3&b=4 ─────────
export type DiffResponse =
  | {
      mode: 'items'
      rows: Array<
        | { kind: 'edit'; itemId: number; before: string; after: string }
        | { kind: 'add'; itemId: number; text: string }
        | { kind: 'delete'; itemId: number; text: string }
        | { kind: 'same'; itemId: number; text: string }
      >
    }
  | { mode: 'fulltext'; a: string[]; b: string[] }

// ───────── 7. 周期的下层输入  GET /api/series/:level/:period/children ─────────
export interface ChildPeriod {
  period: string // 2026-10-29 或 2026-10
  label: string // "周四 10/29" 或 "10 月"
  state: 'ok' | 'none' | 'future' | 'empty'
  preview: string[] // 前两个条目
  /** 被并入到本系列的哪个版本 */
  mergedIn?: number
  scheduledAt?: number
}
export interface ChildrenResponse {
  children: ChildPeriod[]
}

// ───────── 8. 重新生成  POST /api/series/:level/:period/regenerate → { version } ─────────
// ───────── 9. 立即生成日结  POST /api/daily/run → TaskRun ─────────

// ───────── 10–12. 定时任务 ─────────
export type JobName = 'hourly' | 'daily' | 'catchup' | 'yearly' | 'backup_im' | 'backup_calendar' | 'backup_mail'
export type ScheduleRule =
  | { type: 'hourly'; minute: number }
  | { type: 'daily'; hour: number; minute: number }
  | { type: 'weekly'; weekday: number; hour: number; minute: number } // weekday 1=周一 … 7=周日
  | { type: 'monthly'; day: number; hour: number; minute: number }
export interface Job {
  name: JobName
  title: string // 小时摘要 / 日结 / ...
  description: string
  enabled: boolean
  rule: ScheduleRule
  running: boolean
  lastRun?: { at: number; result: TaskRun['result'] }
  nextRunAt: number | null
}
// GET /api/jobs → Job[]
// PATCH /api/jobs/:name  body {enabled?, rule?} → Job；不合法返回 400 {error:"日结时间需在 12:00 到 23:59 之间"}
// POST /api/jobs/:name/run → { runId }；正在运行时 409
export interface TaskRun {
  id: number
  job: JobName
  target: string
  scheduledAt: number | null
  startedAt: number
  endedAt: number | null
  result: 'running' | 'success' | 'skipped' | 'failed' | 'interrupted'
  trigger: 'scheduled' | 'manual' | 'startup' | 'retry'
  note: string
  outputs: Array<{ level: Level; period: string; version: number }>
}
// GET /api/runs?job=&result=&page= → Page<TaskRun>
export interface Page<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

// ───────── 13–18. 备份 ─────────
export interface BackupSourceStatus {
  source: BackupSource
  state: 'ok' | 'failed' | 'partial' | 'running' | 'never'
  /** IM：已备份天数；邮件：封数；日程：场数 */
  total: number
  retentionDays: number
  rule: ScheduleRule
  lastRun?: { at: number; result: string; error?: string; added: number }
  nextRunAt: number | null
  watermark: number | null
  /** 备份中：已读取条数 */
  progress?: { read: number }
}
// GET /api/backup/status → BackupSourceStatus[]
export type CoverageState = 'ok' | 'gap_recoverable' | 'gap_expired' | 'no_data' | 'pending'
export interface CoverageResponse {
  source: BackupSource
  days: Array<{ day: string; state: CoverageState; clientCount?: number; localCount?: number }>
  /** 7 天可补救窗口内未备份的天数（不含等待备份的 pending） */
  unbackedInWindow: number
  /** 受缺口影响的降级小时条目数 */
  degradedItems: number
  /** 该来源备份任务的当前时间规则（pending 天悬停显示“等待 HH:MM 备份”） */
  rule: ScheduleRule
}
// GET /api/backup/coverage?source=im&days=60 → CoverageResponse
// GET /api/backup/affected → AffectedResponse
export interface AffectedResponse {
  items: Array<{ ref: ItemRef; text: string; reason: LostReason; usedBy: Array<{ ref: ItemRef; text: string }> }>
}
export interface BackupRun {
  id: number
  source: BackupSource
  trigger: 'scheduled' | 'retry' | 'manual' | 'startup'
  startedAt: number
  endedAt: number | null
  result: 'running' | 'success' | 'partial' | 'failed'
  error: string | null
  added: number
  note: string // 例如 "10/27、10/28 核对不一致"
}
// GET /api/backup/runs?source=&result=&page= → Page<BackupRun>
// POST /api/backup/run → { started: true }（依次跑三个备份）
export interface StorageResponse {
  totalBytes: number
  rawBytes: number
  summaryBytes: number
  integrity: { at: number; ok: boolean; note: string } | null
}
// GET /api/backup/storage → StorageResponse

// ───────── 19. 搜索  GET /api/search?q=&range=today|week|month|all&sources=summary,im,mail,event&mine=1&page=1 ─────────
export interface SearchHit {
  type: 'summary' | 'im' | 'mail' | 'event'
  /** 例如 "小时摘要 · 10/29 09:00"、"群「供应链对接」· 王*"、"邮件「Q4 预算」" */
  source: string
  time: number
  snippet: string
  /** snippet 中命中的 [起, 止) 位置 */
  highlights: Array<[number, number]>
  target:
    | { kind: 'item'; ref: ItemRef } // 小时/日 → 今天页；周月年 → 回顾页
    | { kind: 'im'; id: string }
    | { kind: 'mail'; id: string }
    | { kind: 'event'; id: string }
}
export interface SearchResponse extends Page<SearchHit> {
  /** 结果为空且范围含今天时提示 "今天的原文会在下次 IM 备份后可搜" */
  hint?: string
}

// ───────── 20. 设置  GET/PUT /api/settings；POST /api/settings/test-model ─────────
export interface Settings {
  participation: {
    speak: boolean // 我开口
    mention: boolean // @我
    reply: boolean // 回复我
    private: boolean // 私聊
    directed: boolean // 定向发给我
    events: boolean // 我参加的日程
    sentMail: boolean // 我发出的邮件
    toMail: boolean // 收件人是我的邮件
  }
  redact: boolean
}
export interface SettingsResponse extends Settings {
  model: { name: string; endpoint: string | null; destination: string } // destination："仅本机" / "发送到 llm.corp" / "演示模型（不联网）"
  source: { name: string }
  me: { name: string }
  /** 本机数据目录（设置页“关于”显示） */
  dataDir: string
}
// POST /api/settings/test-model → { ok, ms, error? }

// ───────── 21. 全局状态  GET /api/status ─────────
export interface StatusResponse {
  now: number
  im: { lastAt: number | null; result: string | null; backedUpDays: number }
  daily: { state: 'none' | 'ok' | 'generating' | 'failed'; at: number | null; scheduledAt: number | null }
  alerts: Array<{ source: 'im' | 'mail'; daysLeft: number }>
  redact: boolean
  demo: boolean
}
