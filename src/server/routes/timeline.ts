// 时间线（api-types 第 1 节）。重新生成移到了 summary.ts（本票起支持全部层级）。
// nextHourlyAt 从任务配置读（小时摘要规则）。
// 活动条：有小时版本的小时用版本里的 related_msgs，没有版本的才用本机备份计数。
import type { HourBlock, TimelineResponse, VersionMeta } from '../../api-types.js'
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { getJobRule, nextRun } from '../../jobs/rules.js'
import { failureText } from '../errors.js'
import { itemViews } from '../../summary/evidence.js'
import { getVersion } from '../../summary/store.js'
import { dayKey, hourKey, local, periodRange } from '../../time.js'

export function registerTimeline(api: Hono, ctx: Ctx) {
  api.get('/timeline', (c) => {
    const now = ctx.clock.now()
    const date = c.req.query('date') ?? dayKey(now)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: '日期格式应为 YYYY-MM-DD' }, 400)
    const { from, to } = periodRange('day', date)

    const rows = ctx.db
      .prepare("SELECT id, period, current_version, state, last_error FROM series WHERE level = 'hour' AND period >= ? AND period <= ? ORDER BY period")
      .all(`${date}T00`, `${date}T23`) as unknown as Array<{ id: number; period: string; current_version: number; state: 'idle' | 'generating' | 'failed'; last_error: string | null }>

    const hours: HourBlock[] = []
    const recorded: number[] = []
    /** 有版本的小时 → 版本里的 related_msgs（活动条优先用它） */
    const hourStat = new Map<string, number>()
    for (const row of rows) {
      const hour = Number(row.period.slice(11))
      if (row.current_version === 0 && row.state !== 'failed') continue // 跳过的小时没有卡片
      recorded.push(hour)
      if (row.state === 'generating') {
        hours.push({ period: row.period, hour, state: 'generating', items: [], related: 0 })
        continue
      }
      if (row.current_version === 0) {
        hours.push({ period: row.period, hour, state: 'failed', error: failureText(row.last_error ?? '生成失败'), items: [], related: 0 })
        continue
      }
      const bundle = getVersion(ctx.db, row.id, row.current_version)
      if (!bundle) continue
      hourStat.set(row.period, bundle.meta.related_msgs ?? 0)
      hours.push({
        period: row.period,
        hour,
        state: row.state === 'failed' ? 'failed' : 'ok',
        error: row.state === 'failed' ? failureText(row.last_error ?? '生成失败') : undefined,
        version: versionMeta(bundle.meta),
        items: itemViews(ctx, bundle.meta.id),
        related: bundle.meta.related_msgs ?? 0,
      })
    }

    // 活动条：0–23 每小时与我有关的原文数。没有版本的小时才用本机备份计数
    const activity = new Array<number>(24).fill(0)
    // 还没发生的（例如今天稍后的日程）不计入
    const hasVersion = (t: number) => t > now || hourStat.has(hourKey(t))
    for (const r of ctx.db.prepare('SELECT time FROM im_messages WHERE related_to_me = 1 AND time >= ? AND time < ?').all(from, to) as unknown as Array<{ time: number }>) {
      if (!hasVersion(r.time)) activity[local(r.time).h]++
    }
    for (const r of ctx.db.prepare('SELECT start FROM events WHERE related_to_me = 1 AND start >= ? AND start < ?').all(from, to) as unknown as Array<{ start: number }>) {
      if (!hasVersion(r.start)) activity[local(r.start).h]++
    }
    for (const r of ctx.db.prepare('SELECT time FROM mails WHERE related_to_me = 1 AND time >= ? AND time < ?').all(from, to) as unknown as Array<{ time: number }>) {
      if (!hasVersion(r.time)) activity[local(r.time).h]++
    }
    for (const [period, related] of hourStat) activity[Number(period.slice(11))] = related

    // 空档：有记录的小时之间的连续无记录区间
    const gaps: Array<{ from: number; to: number }> = []
    for (let i = 1; i < recorded.length; i++) {
      if (recorded[i] > recorded[i - 1] + 1) gaps.push({ from: recorded[i - 1] + 1, to: recorded[i] })
    }

    const isToday = date === dayKey(now)
    const res: TimelineResponse = { date, isToday, now, nextHourlyAt: isToday ? nextRun(getJobRule(ctx.db, 'hourly'), now) : null, hours, gaps, activity }
    return c.json(res)
  })
}

function versionMeta(row: { version: number; created_at: number; trigger: VersionMeta['trigger']; mode: VersionMeta['mode']; is_final: number; model: string }): VersionMeta {
  return { version: row.version, createdAt: row.created_at, trigger: row.trigger, mode: row.mode, isFinal: row.is_final === 1, model: row.model }
}
