// 证据链（api-types 第 3 节）+ 原文上下文与详情（第 4 节）。
import type { Level } from '../../api-types.js'
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { evidenceTree, eventDetail, imContext, mailDetail } from '../../summary/evidence.js'

const LEVELS: Level[] = ['hour', 'day', 'week', 'month', 'year']

export function registerEvidence(api: Hono, ctx: Ctx) {
  api.get('/evidence', async (c) => {
    const level = c.req.query('level') as Level
    const period = c.req.query('period') ?? ''
    const itemId = Number(c.req.query('itemId'))
    const version = c.req.query('version')
    if (!LEVELS.includes(level)) return c.json({ error: `未知层级 ${level}` }, 400)
    if (!Number.isInteger(itemId) || itemId < 1) return c.json({ error: 'itemId 应为正整数' }, 400)
    try {
      const res = await evidenceTree(
        ctx,
        { level, period, version: version !== undefined && version !== '' ? Number(version) : undefined, itemId },
        c.req.query('expand') === 'raw',
      )
      return c.json(res)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 404)
    }
  })

  api.get('/raw/im/:id/context', async (c) => {
    const res = await imContext(ctx, c.req.param('id'))
    if (!res) return c.json({ error: '消息不存在' }, 404)
    return c.json(res)
  })

  api.get('/raw/mail/:id', async (c) => {
    const res = await mailDetail(ctx, c.req.param('id'))
    if (!res) return c.json({ error: '邮件不存在' }, 404)
    return c.json(res)
  })

  api.get('/raw/event/:id', async (c) => {
    const res = await eventDetail(ctx, c.req.param('id'))
    if (!res) return c.json({ error: '日程不存在' }, 404)
    return c.json(res)
  })
}
