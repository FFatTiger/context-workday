// 搜索假数据（spec 第 10 节）：所有摘要系列当前版本的条目 + IM、邮件、日程原文。
// 关键词子串匹配、多个词按"与"组合，按时间倒序，每页 50 条。
import type { ItemView, Level, SearchHit, SearchResponse } from '../../../src/api-types'
import { fromLocal, periodRange } from '../../../src/time'
import { dateStart, hhmm, md } from '../format'
import { HOURS, MONTH, MONTH_ITEMS, TODAY, WEEK, WEEK_ITEMS, YEAR_ITEMS, dayCardFor } from './core'
import { allEvents, allImMessages, allMails } from './evidence'

export const PAGE_SIZE = 50

type SearchSource = SearchHit['type']
export type SearchRange = 'today' | 'week' | 'month' | 'all'

export interface SearchQuery {
  q: string
  range: SearchRange
  sources: SearchSource[]
  mine: boolean
  page: number
}

interface Entry {
  type: SearchSource
  source: string
  time: number
  snippet: string
  target: SearchHit['target']
  /** 原文是否与我有关（"只看与我有关"只筛原文） */
  related: boolean
}

const pad2 = (n: number) => String(n).padStart(2, '0')

function hourTime(period: string): number {
  const [date, hour] = period.split('T')
  const [y, mo, d] = date.split('-').map(Number)
  return fromLocal(y, mo, d, Number(hour), 5)
}

function summaryEntry(level: Level, period: string, version: number, item: ItemView, at: number, source: string): Entry {
  return {
    type: 'summary',
    source,
    time: at,
    snippet: item.text,
    target: { kind: 'item', ref: { level, period, version, itemId: item.itemId } },
    related: true,
  }
}

function summaryEntries(): Entry[] {
  const out: Entry[] = []
  for (const date of Object.keys(HOURS)) {
    for (const block of HOURS[date]) {
      const at = hourTime(block.period)
      const label = `小时摘要 · ${md(at)} ${pad2(block.hour)}:00`
      for (const item of block.items) {
        out.push(summaryEntry('hour', block.period, block.version?.version ?? 1, item, at, label))
      }
    }
  }
  for (const date of ['2026-10-26', TODAY]) {
    const card = dayCardFor(date)
    if (card.state !== 'ok' || !card.version) continue
    const at = card.version.createdAt
    for (const item of card.items) {
      out.push(summaryEntry('day', card.period, card.version.version, item, at, `日结 · ${md(at)}`))
    }
  }
  return out
}

function upperEntries(): Entry[] {
  const weekAt = fromLocal(2026, 10, 29, 20, 30)
  const monthAt = fromLocal(2026, 10, 29, 20, 30)
  const yearAt = fromLocal(2026, 10, 1, 3, 0)
  const out: Entry[] = []
  for (const item of WEEK_ITEMS) {
    out.push(summaryEntry('week', WEEK, 4, item, weekAt, '周摘要 · 第 44 周 · v4'))
  }
  for (const item of MONTH_ITEMS) {
    out.push(summaryEntry('month', MONTH, 16, item, monthAt, '月摘要 · 10 月 · v16'))
  }
  for (const item of YEAR_ITEMS) {
    out.push(summaryEntry('year', '2026', 3, item, yearAt, '年摘要 · 2026 年 · v3'))
  }
  return out
}

function isGroupSession(session: string): boolean {
  return /群|组|周会/.test(session)
}

function imEntries(): Entry[] {
  return allImMessages().map((message) => ({
    type: 'im',
    source: isGroupSession(message.session)
      ? `群「${message.session}」· ${message.sender}`
      : `私聊 · ${message.sender}`,
    time: message.time,
    snippet: message.text,
    target: { kind: 'im', id: message.id },
    related: message.isMine || message.text.includes('我'),
  }))
}

function mailEntries(): Entry[] {
  return allMails().map((mail) => ({
    type: 'mail',
    source: `邮件「${mail.subject}」· ${mail.from} → ${mail.to.join('、')}`,
    time: mail.time,
    snippet: mail.text.replace(/\s+/g, ' ').trim(),
    target: { kind: 'mail', id: mail.id },
    related: true,
  }))
}

function eventEntries(): Entry[] {
  return allEvents().map((event) => ({
    type: 'event',
    source: `日程「${event.title}」· ${md(event.start)} ${hhmm(event.start)} – ${hhmm(event.end)}`,
    time: event.start,
    snippet: event.notes || event.title,
    target: { kind: 'event', id: event.id },
    related: true,
  }))
}

let pool: Entry[] | null = null

function entries(): Entry[] {
  if (!pool) pool = [...summaryEntries(), ...upperEntries(), ...imEntries(), ...mailEntries(), ...eventEntries()]
  return pool
}

function rangeFrom(range: SearchRange): number {
  switch (range) {
    case 'today':
      return dateStart(TODAY)
    case 'week':
      return periodRange('week', WEEK).from
    case 'month':
      return periodRange('month', MONTH).from
    case 'all':
      return -Infinity
  }
}

/** 片段里每处命中都高亮，重叠的合并 */
function highlightsOf(text: string, terms: string[]): Array<[number, number]> {
  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const term of terms) {
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(term, from)
      if (at < 0) break
      ranges.push([at, at + term.length])
      from = at + term.length
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged.slice(0, 12)
}

export function searchFixtures(query: SearchQuery): SearchResponse {
  const page = Math.max(1, query.page)
  const pageSize = PAGE_SIZE
  const terms = query.q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return { items: [], total: 0, page, pageSize }

  const sources = new Set(query.sources)
  const from = rangeFrom(query.range)
  const matched = entries()
    .filter((entry) => sources.has(entry.type))
    .filter((entry) => entry.time >= from)
    .filter((entry) => (query.mine && entry.type !== 'summary' ? entry.related : true))
    .filter((entry) => {
      const haystack = `${entry.source}\n${entry.snippet}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .sort((a, b) => b.time - a.time)

  const items: SearchHit[] = matched.slice((page - 1) * pageSize, page * pageSize).map((entry) => ({
    type: entry.type,
    source: entry.source,
    time: entry.time,
    snippet: entry.snippet,
    highlights: highlightsOf(entry.snippet, terms),
    target: entry.target,
  }))

  const response: SearchResponse = { items, total: matched.length, page, pageSize }
  if (!matched.length) response.hint = '今天的原文会在下次 IM 备份后可搜'
  return response
}
