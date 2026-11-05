// 回顾页假数据：版本轨、版本对比、下层输入（周 → 日、月 → 日、年 → 月）。
// 内容延续原型（第 44 周 v1–v4、10 月 v16），类型严格按 src/api-types.ts。
import type {
  ChildPeriod,
  ChildrenResponse,
  DiffResponse,
  Level,
  VersionListItem,
  VersionListResponse,
  VersionMeta,
} from '../../../src/api-types'
import { WEEKDAY_ZH, fmt, fromLocal, local, periodRange } from '../../../src/time'
import {
  DAY_ITEMS,
  MONTH,
  MONTH_ITEMS,
  NOW,
  WEEK,
  WEEK_ITEMS,
  cardFor,
  dayCardFor,
  findHourBlock,
  version,
} from './core'

export interface SeriesItem {
  itemId: number
  text: string
}

interface SeriesVersion extends VersionListItem {
  items: SeriesItem[]
}

function mkVersion(
  n: number,
  createdAt: number,
  mode: 'incremental' | 'full',
  changes: { added: number; edited: number; deleted: number },
  inputNote: string,
  items: SeriesItem[],
  extra: Partial<VersionListItem> = {},
): SeriesVersion {
  return {
    ...version(n, createdAt, { mode, ...extra }),
    changes,
    inputNote,
    items,
  }
}

const WEEK_ITEMS_BY_VERSION: Record<number, SeriesItem[]> = {
  1: [
    { itemId: 1, text: '核心系统迁移：评审中，切换时间待定' },
    { itemId: 3, text: 'Q4 预算：非核心项先砍 15%' },
  ],
  2: [
    { itemId: 1, text: '核心系统迁移：评审中，切换时间待定' },
    { itemId: 3, text: 'Q4 预算：非核心项先砍 15%，口径待确认' },
  ],
  3: [
    { itemId: 1, text: '核心系统迁移：评审中，切换时间待定' },
    { itemId: 3, text: 'Q4 预算：非核心项先砍 15%，口径待确认' },
    { itemId: 5, text: '回滚方案周五前补齐' },
  ],
  4: [
    { itemId: 1, text: '核心系统迁移：评审通过，切换窗口定为 11月8日' },
    { itemId: 2, text: '智能客服灰度从 5% 提到 20%' },
    { itemId: 3, text: 'Q4 预算：非核心项先砍 15%，口径待确认' },
    { itemId: 4, text: '数据安全整改：周五前反馈自查结果' },
  ],
}

const WEEK_VERSIONS: SeriesVersion[] = [
  mkVersion(4, fromLocal(2026, 10, 29, 20, 30), 'incremental', { added: 2, edited: 1, deleted: 1 }, '并入周四日结', WEEK_ITEMS_BY_VERSION[4]),
  mkVersion(3, fromLocal(2026, 10, 28, 20, 30), 'incremental', { added: 1, edited: 0, deleted: 0 }, '并入周三日结', WEEK_ITEMS_BY_VERSION[3]),
  mkVersion(2, fromLocal(2026, 10, 27, 20, 30), 'incremental', { added: 0, edited: 1, deleted: 0 }, '并入周二日结', WEEK_ITEMS_BY_VERSION[2]),
  mkVersion(1, fromLocal(2026, 10, 26, 20, 30), 'full', { added: 2, edited: 0, deleted: 0 }, '初版 · 2 条', WEEK_ITEMS_BY_VERSION[1]),
]

const MONTH_VERSIONS: SeriesVersion[] = [
  mkVersion(16, fromLocal(2026, 10, 29, 20, 30), 'incremental', { added: 1, edited: 1, deleted: 0 }, '并入 10/29 日结', [
    { itemId: 1, text: '完成数据中台指标口径统一' },
    { itemId: 2, text: '核心系统迁移方案成型并通过评审' },
    { itemId: 3, text: '启动智能客服灰度' },
  ]),
  mkVersion(15, fromLocal(2026, 10, 28, 20, 30), 'incremental', { added: 0, edited: 1, deleted: 0 }, '并入 10/28 日结', [
    { itemId: 1, text: '完成数据中台指标口径统一' },
    { itemId: 2, text: '核心系统迁移方案成型，等待评审' },
    { itemId: 3, text: '启动智能客服灰度' },
  ]),
  mkVersion(14, fromLocal(2026, 10, 27, 20, 30), 'incremental', { added: 1, edited: 0, deleted: 0 }, '并入 10/27 日结', [
    { itemId: 1, text: '完成数据中台指标口径统一' },
    { itemId: 3, text: '启动智能客服灰度' },
  ]),
  mkVersion(13, fromLocal(2026, 10, 26, 20, 30), 'incremental', { added: 0, edited: 0, deleted: 1 }, '并入 10/26 日结', [
    { itemId: 1, text: '完成数据中台指标口径统一' },
    { itemId: 3, text: '启动智能客服灰度' },
  ]),
  mkVersion(12, fromLocal(2026, 10, 25, 20, 30), 'incremental', { added: 1, edited: 0, deleted: 0 }, '并入 10/25 日结', [
    { itemId: 1, text: '完成数据中台指标口径统一' },
    { itemId: 3, text: '启动智能客服灰度' },
  ]),
]

const YEAR_VERSIONS: SeriesVersion[] = [
  mkVersion(3, fromLocal(2026, 10, 1, 3, 0), 'incremental', { added: 1, edited: 0, deleted: 0 }, '并入 9 月', [
    { itemId: 1, text: '数据中台立项，指标口径开始统一' },
    { itemId: 2, text: '指标口径初稿完成' },
    { itemId: 3, text: '完成数据中台指标口径统一' },
  ]),
  mkVersion(2, fromLocal(2026, 9, 1, 3, 0), 'incremental', { added: 1, edited: 0, deleted: 0 }, '并入 8 月', [
    { itemId: 1, text: '数据中台立项，指标口径开始统一' },
    { itemId: 2, text: '指标口径初稿完成' },
  ]),
  mkVersion(1, fromLocal(2026, 8, 1, 3, 0), 'full', { added: 1, edited: 0, deleted: 0 }, '初版 · 1 条', [
    { itemId: 1, text: '数据中台立项，指标口径开始统一' },
  ]),
]

const KNOWN_SERIES: Record<string, SeriesVersion[]> = {
  [`week|${WEEK}`]: WEEK_VERSIONS,
  [`month|${MONTH}`]: MONTH_VERSIONS,
  'year|2026': YEAR_VERSIONS,
}

/** 手动重新生成的版本，按系列覆盖 */
const REGENERATED: Record<string, SeriesVersion[]> = {}

export function recordRegeneratedVersion(
  level: Level,
  period: string,
  n: number,
  createdAt: number,
  items: SeriesItem[],
): void {
  const key = `${level}|${period}`
  const base = REGENERATED[key] ?? seriesOf(level, period)
  REGENERATED[key] = [
    mkVersion(
      n,
      createdAt,
      'full',
      { added: items.length, edited: 0, deleted: 0 },
      '手动重新生成 · 全量',
      items,
      { trigger: 'manual' },
    ),
    ...base,
  ]
}

function itemsOf(items: Array<{ itemId: number; text: string }>): SeriesItem[] {
  return items.map((item) => ({ itemId: item.itemId, text: item.text }))
}

function hourSeries(period: string): SeriesVersion[] {
  const block = findHourBlock(period)
  if (!block || !block.version) return []
  const current = itemsOf(block.items)
  const isRerun = block.version.version > 1
  if (!isRerun) {
    return [
      mkVersion(1, block.version.createdAt, 'full', { added: current.length, edited: 0, deleted: 0 }, '初版', current),
    ]
  }
  const before = current.map((item) => ({
    itemId: item.itemId,
    text: item.itemId === 1 ? '数据中台周会：预算按季度重新排' : item.text,
  }))
  return [
    mkVersion(
      block.version.version,
      block.version.createdAt,
      'full',
      { added: 0, edited: 1, deleted: 0 },
      '手动重跑',
      current,
      { trigger: block.version.trigger },
    ),
    mkVersion(1, block.version.createdAt - 47 * 60_000, 'full', { added: before.length, edited: 0, deleted: 0 }, '初版', before),
  ]
}

/** 某个系列的全部版本（新 → 旧）；没数据的周期返回空数组 */
function seriesOf(level: Level, period: string): SeriesVersion[] {
  const regenerated = REGENERATED[`${level}|${period}`]
  if (regenerated) return regenerated
  const known = KNOWN_SERIES[`${level}|${period}`]
  if (known) return known
  if (level === 'hour') return hourSeries(period)
  const card = cardFor(level, period)
  if (!card || card.state !== 'ok' || !card.items.length) return []
  const fixed = level === 'day' ? DAY_ITEMS : level === 'week' ? WEEK_ITEMS : level === 'month' ? MONTH_ITEMS : card.items
  return [
    mkVersion(
      card.version?.version ?? 1,
      card.version?.createdAt ?? NOW,
      'full',
      { added: card.items.length, edited: 0, deleted: 0 },
      '初版',
      itemsOf(card.items.length ? card.items : fixed),
      { isFinal: card.version?.isFinal ?? false },
    ),
  ]
}

export function fixtureVersions(level: Level, period: string): VersionListResponse {
  return {
    level,
    period,
    upstreamChanged: false,
    versions: seriesOf(level, period).map(({ items: _items, ...rest }) => rest),
  }
}

/** 某个版本的元信息；选历史版本时摘要卡头部用它 */
export function versionMetaFor(level: Level, period: string, n: number): VersionMeta | null {
  const found = seriesOf(level, period).find((item) => item.version === n)
  if (!found) return null
  const { changes: _changes, inputNote: _inputNote, items: _items, ...meta } = found
  return meta
}

/** 某个版本的条目；选历史版本时摘要卡和证据抽屉都用它 */
export function itemsForVersion(level: Level, period: string, n: number): SeriesItem[] | null {
  const found = seriesOf(level, period).find((item) => item.version === n)
  return found ? found.items : null
}

export function fixtureDiff(level: Level, period: string, a: number, b: number): DiffResponse {
  const series = seriesOf(level, period)
  const va = series.find((item) => item.version === a)
  const vb = series.find((item) => item.version === b)
  if (!va || !vb) throw new Error('没有这个版本')
  if (va.mode === 'full' || vb.mode === 'full') {
    return { mode: 'fulltext', a: va.items.map((item) => item.text), b: vb.items.map((item) => item.text) }
  }
  const before = new Map(vb.items.map((item) => [item.itemId, item.text]))
  const rows: Extract<DiffResponse, { mode: 'items' }>['rows'] = []
  for (const item of va.items) {
    const old = before.get(item.itemId)
    if (old === undefined) rows.push({ kind: 'add', itemId: item.itemId, text: item.text })
    else if (old !== item.text) rows.push({ kind: 'edit', itemId: item.itemId, before: old, after: item.text })
    else rows.push({ kind: 'same', itemId: item.itemId, text: item.text })
  }
  const after = new Set(va.items.map((item) => item.itemId))
  for (const item of vb.items) {
    if (!after.has(item.itemId)) rows.push({ kind: 'delete', itemId: item.itemId, text: item.text })
  }
  return { mode: 'items', rows }
}

// ───── 下层输入 ─────

const MERGED_IN: Record<string, number> = {
  '2026-10-25': 12,
  '2026-10-26': 13,
  '2026-10-27': 14,
  '2026-10-28': 15,
  '2026-10-29': 16,
}

const WEEK_MERGED_IN: Record<string, number> = {
  '2026-10-26': 1,
  '2026-10-27': 2,
  '2026-10-28': 3,
  '2026-10-29': 4,
}

function startOf(date: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  return fromLocal(y, mo, d)
}

function dayChild(date: string, label: string, mergedIn?: number): ChildPeriod {
  const start = startOf(date)
  if (start > NOW) return { period: date, label, state: 'future', preview: [] }
  const card = dayCardFor(date)
  const base = { period: date, label }
  if (card.state === 'ok') {
    return {
      ...base,
      state: 'ok',
      preview: card.items.slice(0, 2).map((item) => item.text),
      ...(mergedIn ? { mergedIn } : {}),
    }
  }
  if (card.state === 'none' || card.state === 'failed') {
    const [y, mo, d] = date.split('-').map(Number)
    return {
      ...base,
      state: 'none',
      preview: [],
      scheduledAt: card.scheduledAt ?? fromLocal(y, mo, d, 20, 30),
    }
  }
  return { ...base, state: 'empty', preview: [] }
}

function monthChild(month: number): ChildPeriod {
  const first = fromLocal(2026, month)
  const label = `${month} 月`
  if (first > NOW) return { period: `2026-${String(month).padStart(2, '0')}`, label, state: 'future', preview: [] }
  if (month > 10) return { period: `2026-${String(month).padStart(2, '0')}`, label, state: 'future', preview: [] }
  if (month === 10) {
    return {
      period: '2026-10',
      label,
      state: 'ok',
      preview: ['完成数据中台指标口径统一', '核心系统迁移方案成型并通过评审'],
    }
  }
  if (month === 9) {
    return { period: '2026-09', label, state: 'ok', preview: ['指标口径初稿完成'], mergedIn: 3 }
  }
  if (month === 8) {
    return { period: '2026-08', label, state: 'ok', preview: ['数据中台立项'], mergedIn: 2 }
  }
  return { period: `2026-${String(month).padStart(2, '0')}`, label, state: 'empty', preview: [] }
}

export function fixtureChildren(level: Level, period: string): ChildrenResponse {
  if (level === 'week') {
    const range = periodRange('week', period)
    const children = Array.from({ length: 7 }, (_, index) => {
      const t = range.from + index * 86_400_000
      const date = fmt(t, 'YYYY-MM-DD')
      return dayChild(date, `${WEEKDAY_ZH[local(t).wd]} ${fmt(t, 'MM/DD')}`, WEEK_MERGED_IN[date])
    })
    return { children }
  }
  if (level === 'month') {
    const [y, mo] = period.split('-').map(Number)
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const children = Array.from({ length: days }, (_, index) => {
      const date = fmt(fromLocal(y, mo, index + 1), 'YYYY-MM-DD')
      return dayChild(date, `${mo}/${index + 1}`, MERGED_IN[date])
    })
    return { children }
  }
  if (level === 'year') {
    return { children: Array.from({ length: 12 }, (_, index) => monthChild(index + 1)) }
  }
  return { children: [] }
}
