// 搜索接口（api-types 19）：GET /api/search?q=&range=today|week|month|all&sources=summary,im,mail,event&mine=1&page=1
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { search, type SearchRange, type SearchSource } from '../../search.js'

const RANGES: SearchRange[] = ['today', 'week', 'month', 'all']
const SOURCES: SearchSource[] = ['summary', 'im', 'mail', 'event']

export function registerSearch(api: Hono, ctx: Ctx) {
  api.get('/search', (c) => {
    const q = c.req.query('q') ?? ''
    const range = (c.req.query('range') ?? 'all') as SearchRange
    if (!RANGES.includes(range)) return c.json({ error: `时间范围应为 ${RANGES.join(' / ')}` }, 400)
    const sources = (c.req.query('sources') ?? SOURCES.join(',')).split(',').filter(Boolean) as SearchSource[]
    if (sources.some((s) => !SOURCES.includes(s))) return c.json({ error: `来源应为 ${SOURCES.join(' / ')} 的组合` }, 400)
    const page = Number(c.req.query('page') ?? 1)
    if (!Number.isInteger(page) || page < 1) return c.json({ error: '页码应为正整数' }, 400)
    const mine = c.req.query('mine') !== '0'
    return c.json(search(ctx, { q, range, sources, mine, page }))
  })
}
