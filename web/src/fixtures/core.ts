// 票 06 的假数据：2026-10-29 周四 20:36，内容照 docs/design/prototype/index.html。
// 类型严格按 src/api-types.ts，只在前端 fixtures 模式下使用。
import type {
  CardResponse,
  HourBlock,
  ItemView,
  Level,
  StatusResponse,
  TimelineResponse,
  VersionMeta,
} from '../../../src/api-types'
import { fromLocal, local, dayKey, periodRange, WEEKDAY_ZH } from '../../../src/time'

export const NOW = fromLocal(2026, 10, 29, 20, 36)
export const TODAY = '2026-10-29'
export const WEEK = '2026-W44'
export const MONTH = '2026-10'

export function version(n: number, createdAt: number, extra: Partial<VersionMeta> = {}): VersionMeta {
  return { version: n, createdAt, trigger: 'scheduled', mode: 'full', isFinal: false, model: 'demo-model', ...extra }
}

function item(
  itemId: number,
  text: string,
  counts: ItemView['counts'],
  degraded = 0,
  op: ItemView['op'] = 'keep',
): ItemView {
  return { itemId, text, op, counts, degraded }
}

// ───── 2026-10-29 时间线 ─────

export const HOURS: Record<string, HourBlock[]> = {
  '2026-10-29': [
    {
      period: '2026-10-29T09',
      hour: 9,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 10, 5)),
      related: 34,
      items: [
        item(1, '【核心迁移】项目群确认切换窗口改到 11月8日 凌晨 2:00', { evidence: 9, im: 9 }),
        item(2, '回复赵磊：大促期间不做切换', { evidence: 3, im: 3 }),
      ],
    },
    {
      period: '2026-10-29T10',
      hour: 10,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 11, 5)),
      related: 26,
      items: [item(1, '迁移方案评审会：评审通过，回滚方案补齐后签字', { evidence: 7, im: 6, event: 1 })],
    },
    {
      period: '2026-10-29T11',
      hour: 11,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 12, 5)),
      related: 30,
      items: [item(1, '智能客服灰度从 5% 提到 20%，周一看指标', { evidence: 11, im: 11 })],
    },
    {
      period: '2026-10-29T14',
      hour: 14,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 15, 5)),
      related: 16,
      items: [item(1, '与陈工确认回滚方案周五前补齐', { evidence: 5, im: 5 })],
    },
    {
      period: '2026-10-29T15',
      hour: 15,
      state: 'ok',
      version: version(2, fromLocal(2026, 10, 29, 15, 52), { trigger: 'manual' }),
      related: 42,
      items: [
        item(1, '数据中台周会：Q4 非核心项先砍 15%', { evidence: 14, im: 14 }),
        item(2, '李敏问预算表用哪一版口径，还没回复', { evidence: 2, im: 2 }),
      ],
    },
    {
      period: '2026-10-29T16',
      hour: 16,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 17, 5)),
      related: 12,
      items: [item(1, '收到《数据安全整改通知》，周五前反馈自查结果', { evidence: 1, mail: 1 })],
    },
    {
      period: '2026-10-29T18',
      hour: 18,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 19, 5)),
      related: 14,
      items: [item(1, '整理切换演练排期草稿', { evidence: 4, im: 4 })],
    },
  ],
  '2026-10-28': [
    {
      period: '2026-10-28T10',
      hour: 10,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 28, 11, 5)),
      related: 12,
      items: [item(1, '回滚演练脚本评审，同意按 40 分钟估算', { evidence: 6, im: 6 })],
    },
    {
      period: '2026-10-28T15',
      hour: 15,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 28, 16, 5)),
      related: 8,
      items: [item(1, '把周会时间改到周四上午', { evidence: 3, im: 3 })],
    },
  ],
  '2026-10-27': [
    {
      period: '2026-10-27T11',
      hour: 11,
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 27, 12, 5)),
      related: 9,
      items: [item(1, '整理迁移风险评估表，等陈工补充回滚细节', { evidence: 6, im: 6 })],
    },
    {
      period: '2026-10-27T14',
      hour: 14,
      state: 'failed',
      error: '模型输出格式不对，重试后仍失败',
      related: 6,
      items: [item(1, '补录：回滚窗口从 40 分钟调到 60 分钟', { evidence: 3, im: 3 })],
    },
  ],
}

const hourOverrides = new Map<string, HourBlock>()

export function overrideHour(block: HourBlock) {
  hourOverrides.set(block.period, block)
}

function hourBlocks(date: string): HourBlock[] {
  return (HOURS[date] ?? []).map((h) => hourOverrides.get(h.period) ?? h)
}

export function findHourBlock(period: string): HourBlock | null {
  for (const date of Object.keys(HOURS)) {
    const block = hourBlocks(date).find((h) => h.period === period)
    if (block) return block
  }
  return null
}

export function findHourItem(period: string, itemId: number): { block: HourBlock; item: ItemView } | null {
  const block = findHourBlock(period)
  const found = block?.items.find((it) => it.itemId === itemId)
  return block && found ? { block, item: found } : null
}

export function timelineFor(date: string, extra: HourBlock[] = []): TimelineResponse {
  const hours = [...hourBlocks(date), ...extra].sort((a, b) => a.hour - b.hour)
  const activity = new Array<number>(24).fill(0)
  for (const hour of hours) activity[hour.hour] = hour.related
  const gaps: Array<{ from: number; to: number }> = []
  for (let i = 1; i < hours.length; i++) {
    const prev = hours[i - 1].hour
    const cur = hours[i].hour
    if (cur - prev > 1) gaps.push({ from: prev + 1, to: cur })
  }
  return {
    date,
    isToday: date === TODAY,
    now: NOW,
    nextHourlyAt: date === TODAY ? fromLocal(2026, 10, 29, 21, 5) : null,
    hours,
    gaps,
    activity,
  }
}

// ───── 摘要卡 ─────

export const DAY_ITEMS: ItemView[] = [
  item(1, '核心系统迁移切换窗口定为 11月8日，评审通过', { evidence: 2 }),
  item(2, '智能客服灰度提到 20%，周一看指标', { evidence: 1 }),
  item(3, '李敏的预算口径问题还没回复', { evidence: 1 }),
]

export const WEEK_ITEMS: ItemView[] = [
  item(1, '核心系统迁移：评审通过，切换窗口定为 11月8日', { evidence: 3 }, 0, 'edit'),
  item(2, '智能客服灰度从 5% 提到 20%', { evidence: 2 }, 0, 'add'),
  item(3, 'Q4 预算：非核心项先砍 15%，口径待确认', { evidence: 2 }),
  item(4, '数据安全整改：周五前反馈自查结果', { evidence: 1 }, 0, 'add'),
]

export const MONTH_ITEMS: ItemView[] = [
  item(1, '完成数据中台指标口径统一', { evidence: 3 }, 1),
  item(2, '核心系统迁移方案成型并通过评审', { evidence: 5 }, 0, 'edit'),
  item(3, '启动智能客服灰度', { evidence: 3 }),
]

export const YEAR_ITEMS: ItemView[] = [
  item(1, '数据中台立项，指标口径开始统一', { evidence: 2 }),
  item(2, '指标口径初稿完成', { evidence: 2 }),
  item(3, '完成数据中台指标口径统一', { evidence: 1 }),
]

const WEEK_CARD: CardResponse = {
  level: 'week',
  period: WEEK,
  rangeLabel: '10/26 – 10/29',
  state: 'ok',
  version: version(4, fromLocal(2026, 10, 29, 20, 30), { mode: 'incremental' }),
  upstreamChanged: false,
  items: WEEK_ITEMS,
  inputCount: 4,
}

const MONTH_CARD: CardResponse = {
  level: 'month',
  period: MONTH,
  rangeLabel: '10/1 – 10/29',
  state: 'ok',
  version: version(16, fromLocal(2026, 10, 29, 20, 30), { mode: 'incremental' }),
  upstreamChanged: false,
  items: MONTH_ITEMS,
  inputCount: 16,
}

const YEAR_CARD: CardResponse = {
  level: 'year',
  period: '2026',
  rangeLabel: '1/1 – 10/29',
  state: 'ok',
  version: version(3, fromLocal(2026, 10, 1, 3, 0), { mode: 'incremental' }),
  upstreamChanged: false,
  items: YEAR_ITEMS,
  inputCount: 9,
}

function dayRangeLabel(date: string): string {
  const [y, mo, d] = date.split('-').map(Number)
  const t = fromLocal(y, mo, d)
  const l = local(t)
  return `${l.mo}/${l.d} ${WEEKDAY_ZH[l.wd]}`
}

export function dayCardFor(date: string): CardResponse {
  if (date === TODAY) {
    return {
      level: 'day',
      period: date,
      rangeLabel: '10/29 周四',
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 29, 20, 30)),
      upstreamChanged: false,
      items: DAY_ITEMS,
      inputCount: 7,
      dayStats: { totalMsgs: 1284, relatedMsgs: 86, hours: 7 },
    }
  }
  if (date === '2026-10-28') {
    return {
      level: 'day',
      period: date,
      rangeLabel: '10/28 周三',
      state: 'none',
      scheduledAt: fromLocal(2026, 10, 28, 20, 30),
      upstreamChanged: false,
      // 还没生成，界面只显示计划时间；点"立即生成"后用这批条目
      items: [
        item(1, '回滚演练脚本评审，同意按 40 分钟估算', { evidence: 6, im: 6 }),
        item(2, '把周会时间改到周四上午', { evidence: 3, im: 3 }),
      ],
      inputCount: 2,
      dayStats: { totalMsgs: 642, relatedMsgs: 20, hours: 2 },
    }
  }
  if (date === '2026-10-26') {
    return {
      level: 'day',
      period: date,
      rangeLabel: '10/26 周一',
      state: 'ok',
      version: version(1, fromLocal(2026, 10, 26, 20, 30)),
      upstreamChanged: false,
      items: [
        item(1, '提出切换推迟；预算先砍 15%', { evidence: 2, im: 2 }),
        item(2, '预算口径等财务确认', { evidence: 1, im: 1 }),
      ],
      inputCount: 4,
      dayStats: { totalMsgs: 512, relatedMsgs: 18, hours: 4 },
    }
  }
  if (date === '2026-10-27') {
    return {
      level: 'day',
      period: date,
      rangeLabel: '10/27 周二',
      state: 'failed',
      error: '模型调用超时，重试 3 次后仍失败',
      upstreamChanged: false,
      // 失败时界面不显示条目；重试成功后用这批内容
      items: [item(1, '整理迁移风险评估表，等陈工补充回滚细节', { evidence: 6, im: 6 })],
      inputCount: 1,
      dayStats: { totalMsgs: 903, relatedMsgs: 9, hours: 1 },
    }
  }
  return {
    level: 'day',
    period: date,
    rangeLabel: dayRangeLabel(date),
    state: 'empty',
    upstreamChanged: false,
    items: [],
    inputCount: 0,
  }
}

const cardOverrides = new Map<string, CardResponse>()

export function overrideCard(card: CardResponse) {
  cardOverrides.set(`${card.level}|${card.period}`, card)
}

export function cardFor(level: Level, period: string, asOf = NOW): CardResponse | null {
  const overridden = cardOverrides.get(`${level}|${period}`)
  if (overridden) return overridden
  if (level === 'day') return dayCardFor(period)
  if (level === 'week') return { ...WEEK_CARD, period, rangeLabel: periodLabelRange('week', period, asOf) }
  if (level === 'month') return { ...MONTH_CARD, period, rangeLabel: periodLabelRange('month', period, asOf) }
  if (level === 'year') return { ...YEAR_CARD, period, rangeLabel: periodLabelRange('year', period, asOf) }
  return null
}

function shortDate(t: number): string {
  const l = local(t)
  return `${l.mo}/${l.d}`
}

/** 进行中的周期截至查看日期，已结束的周期用完整范围 */
function periodLabelRange(level: 'week' | 'month' | 'year', period: string, asOf: number): string {
  const range = periodRange(level, period)
  const current = NOW >= range.from && NOW < range.to
  const end = current ? Math.min(range.to - 1, asOf) : range.to - 1
  return `${shortDate(range.from)} – ${shortDate(end)}`
}

export function findCardItem(level: Level, period: string, itemId: number): ItemView | null {
  const card = cardFor(level, period)
  return card?.items.find((it) => it.itemId === itemId) ?? null
}

// ───── 全局状态 ─────

export function statusFor(opts: { failed?: boolean; redact: boolean }): StatusResponse {
  return {
    now: NOW,
    im: { lastAt: fromLocal(2026, 10, 29, 2, 0), result: opts.failed ? 'failed' : 'success', backedUpDays: 55 },
    daily: { state: 'ok', at: fromLocal(2026, 10, 29, 20, 30), scheduledAt: fromLocal(2026, 10, 29, 20, 30) },
    alerts: opts.failed ? [{ source: 'im', daysLeft: 2 }] : [],
    redact: opts.redact,
    demo: true,
  }
}

export function todayDate(): string {
  return dayKey(NOW)
}
