// 搜索（spec 第 10 节、api-types 19）：LIKE 子串匹配，空格分词按"与"。
// 范围 = 所有摘要系列当前版本的条目 + 本机备份的原文；时间倒序、每页 50 条。
// 今天还没备份的原文搜不到（只查本机），空结果时由接口层给 hint。
import type { SearchHit, SearchResponse } from './api-types.js'
import type { Ctx } from './context.js'
import { LEVEL_NAME } from './summary/evidence.js'
import { DAY_MS, fmt, monthKey, periodRange, startOfDay, weekKey, type Level } from './time.js'

export type SearchRange = 'today' | 'week' | 'month' | 'all'
export type SearchSource = 'summary' | 'im' | 'mail' | 'event'

export interface SearchParams {
  q: string
  range: SearchRange
  sources: SearchSource[]
  /** 只看与我有关：原文按备份时算好的 related_to_me 过滤；摘要不受影响 */
  mine: boolean
  page: number
}

export const SEARCH_PAGE_SIZE = 50

const like = (term: string) => `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`

/** 关键词分词：空格分隔，去掉空串 */
export function tokenize(q: string): string[] {
  return q.split(/\s+/).filter(Boolean)
}

function rangeFrom(range: SearchRange, now: number): number {
  if (range === 'today') return startOfDay(now)
  if (range === 'week') return periodRange('week', weekKey(now)).from
  if (range === 'month') return periodRange('month', monthKey(now)).from
  return 0
}

/** 周期键 → 条目代表时间（用于排序和时间筛选） */
export function periodTime(level: Level, period: string): number {
  return periodRange(level, period).from
}

function summaryLabel(level: Level, period: string): string {
  const { from, to } = periodRange(level, period)
  if (level === 'hour') return `${LEVEL_NAME[level]} · ${fmt(from, 'MM/DD HH:mm')}`
  if (level === 'day') return `${LEVEL_NAME[level]} · ${fmt(from, 'MM/DD')}`
  if (level === 'week') return `${LEVEL_NAME[level]} · 第 ${Number(period.split('W')[1])} 周`
  if (level === 'month') return `${LEVEL_NAME[level]} · ${fmt(from, 'YYYY-MM')}`
  return `${LEVEL_NAME[level]} · ${period}`
}

/** 一个字段里各关键词的全部命中位置（不重叠，小写比较） */
function occurrences(haystack: string, term: string): Array<[number, number]> {
  if (!term) return []
  const h = haystack.toLowerCase()
  const t = term.toLowerCase()
  const out: Array<[number, number]> = []
  let i = h.indexOf(t)
  while (i !== -1) {
    out.push([i, i + term.length])
    i = h.indexOf(t, i + t.length)
  }
  return out
}

/** snippet 以第一个命中为中心截 80 字左右，highlights 标出片段内所有命中 */
export function makeSnippet(text: string, terms: string[], width = 80): { snippet: string; highlights: Array<[number, number]> } {
  const all: Array<[number, number]> = []
  for (const t of terms) all.push(...occurrences(text, t))
  if (all.length === 0) return { snippet: text.length > width ? `${text.slice(0, width)}…` : text, highlights: [] }
  all.sort((a, b) => a[0] - b[0])
  const first = all[0][0]
  let start = Math.max(0, first - Math.floor(width / 3))
  let end = Math.min(text.length, start + width)
  if (end - start < width) start = Math.max(0, end - width)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const snippet = prefix + text.slice(start, end) + suffix
  const highlights = all
    .filter(([s, e]) => s >= start && e <= end)
    .map(([s, e]) => [s - start + prefix.length, e - start + prefix.length] as [number, number])
  return { snippet, highlights }
}

export function search(ctx: Ctx, params: SearchParams): SearchResponse {
  const db = ctx.db
  const now = ctx.clock.now()
  const terms = tokenize(params.q)
  const from = rangeFrom(params.range, now)
  const hits: SearchHit[] = []
  const want = (s: SearchSource) => params.sources.includes(s)

  // ── 摘要条目（当前版本）──
  if (want('summary') && terms.length > 0) {
    const where = terms.map(() => 'i.text LIKE ? ESCAPE \'\\\'').join(' AND ')
    const rows = db
      .prepare(
        `SELECT s.level AS level, s.period AS period, v.version AS version, v.created_at AS created_at, i.item_id AS item_id, i.text AS text
         FROM series s
         JOIN versions v ON v.series_id = s.id AND v.version = s.current_version
         JOIN items i ON i.version_id = v.id
         WHERE s.current_version > 0 AND ${where}`,
      )
      .all(...terms.map(like)) as unknown as Array<{ level: Level; period: string; version: number; created_at: number; item_id: number; text: string }>
    for (const r of rows) {
      const time = periodTime(r.level, r.period)
      if (time < from || time > now + DAY_MS) continue
      const { snippet, highlights } = makeSnippet(r.text, terms)
      hits.push({
        type: 'summary',
        source: summaryLabel(r.level, r.period),
        time,
        snippet,
        highlights,
        target: { kind: 'item', ref: { level: r.level, period: r.period, version: r.version, itemId: r.item_id } },
      })
    }
  }

  // ── IM 原文（本机备份）──
  if (want('im') && terms.length > 0) {
    const where = terms.map(() => 'm.text LIKE ? ESCAPE \'\\\'').join(' AND ')
    const rows = db
      .prepare(
        `SELECT m.id AS id, m.session_id AS session_id, m.sender_name AS sender_name, m.time AS time, m.text AS text
         FROM im_messages m WHERE ${where} AND m.time >= ? ${params.mine ? 'AND m.related_to_me = 1' : ''}
         ORDER BY m.time DESC LIMIT 2000`,
      )
      .all(...terms.map(like), from) as unknown as Array<{ id: string; session_id: string; sender_name: string; time: number; text: string }>
    const sessCache = new Map<string, { name: string; type: string }>()
    for (const r of rows) {
      let sess = sessCache.get(r.session_id)
      if (!sess) {
        const row = db.prepare('SELECT name, type FROM sessions WHERE id = ?').get(r.session_id) as { name: string; type: string } | undefined
        sess = row ?? { name: r.session_id, type: 'group' }
        sessCache.set(r.session_id, sess)
      }
      const source = sess.type === 'private' ? `私聊 · ${r.sender_name}` : `群「${sess.name}」· ${r.sender_name}`
      const { snippet, highlights } = makeSnippet(r.text, terms)
      hits.push({ type: 'im', source, time: r.time, snippet, highlights, target: { kind: 'im', id: r.id } })
    }
  }

  // ── 邮件（主题 + 正文，每个词都要在其中出现）──
  if (want('mail') && terms.length > 0) {
    const where = terms.map(() => "(subject LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')").join(' AND ')
    const args: string[] = []
    for (const t of terms.map(like)) args.push(t, t)
    const rows = db
      .prepare(`SELECT id, subject, time, text FROM mails WHERE ${where} AND time >= ? ${params.mine ? 'AND related_to_me = 1' : ''} ORDER BY time DESC LIMIT 2000`)
      .all(...args, from) as unknown as Array<{ id: string; subject: string; time: number; text: string }>
    for (const r of rows) {
      // 命中优先显示主题；主题没命中才截正文
      const inSubject = terms.some((t) => r.subject.toLowerCase().includes(t.toLowerCase()))
      const field = inSubject ? r.subject : r.text
      const { snippet, highlights } = makeSnippet(field, terms)
      hits.push({ type: 'mail', source: `邮件「${r.subject}」`, time: r.time, snippet, highlights, target: { kind: 'mail', id: r.id } })
    }
  }

  // ── 日程（标题 + 地点 + 备注）──
  if (want('event') && terms.length > 0) {
    const where = terms.map(() => "(title LIKE ? ESCAPE '\\' OR location LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')").join(' AND ')
    const args: string[] = []
    for (const t of terms.map(like)) args.push(t, t, t)
    const rows = db
      .prepare(`SELECT id, title, start, location, notes FROM events WHERE ${where} AND start >= ? ${params.mine ? 'AND related_to_me = 1' : ''} ORDER BY start DESC LIMIT 2000`)
      .all(...args, from) as unknown as Array<{ id: string; title: string; start: number; location: string; notes: string }>
    for (const r of rows) {
      const inTitle = terms.some((t) => r.title.toLowerCase().includes(t.toLowerCase()))
      const inLocation = !inTitle && terms.some((t) => r.location.toLowerCase().includes(t.toLowerCase()))
      const field = inTitle ? r.title : inLocation ? r.location : r.notes
      const { snippet, highlights } = makeSnippet(field, terms)
      hits.push({ type: 'event', source: `日程「${r.title}」`, time: r.start, snippet, highlights, target: { kind: 'event', id: r.id } })
    }
  }

  // 关键词为空时不搜（q 为空直接返回空页）
  hits.sort((a, b) => b.time - a.time)
  const total = hits.length
  const page = Math.max(1, params.page)
  const items = hits.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE)
  const res: SearchResponse = { items, total, page, pageSize: SEARCH_PAGE_SIZE }
  if (total === 0 && terms.length > 0) res.hint = '今天的原文会在下次 IM 备份后可搜'
  return res
}
