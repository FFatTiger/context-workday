// 摘要卡片、版本列表、版本对比、下层输入、重新生成、立即生成日结（api-types 第 2、5、6、7、8、9 节）。
import type { CardResponse, ChildPeriod, ChildrenResponse, Level, VersionListResponse } from '../../api-types.js'
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { inputNote, diffVersions, versionChanges } from '../../summary/diff.js'
import { PERIOD_RE, RegenerateError, dayStats, nextDailyRunAt, regenerate, scheduledAtFor } from '../../summary/rollup.js'
import { runDaily } from '../../summary/rollup.js'
import { getSeries, getVersion, listVersions, type VersionBundle } from '../../summary/store.js'
import { failureText } from '../errors.js'
import { itemViews } from '../../summary/evidence.js'
import { DAY_MS, WEEKDAY_ZH, dayKey, fmt, local, pad, periodKey, periodRange, startOfDay } from '../../time.js'

const LEVELS: Level[] = ['hour', 'day', 'week', 'month', 'year']
function versionMeta(bundle: VersionBundle): CardResponse['version'] {
  const m = bundle.meta
  return { version: m.version, createdAt: m.created_at, trigger: m.trigger, mode: m.mode, isFinal: m.is_final === 1, model: m.model }
}

function rangeLabel(level: Level, period: string, now: number): string {
  const { from, to } = periodRange(level, period)
  if (level === 'hour') return fmt(from, 'MM/DD HH:00')
  if (level === 'day') return `${fmt(from, 'MM/DD')} ${WEEKDAY_ZH[local(from).wd]}`
  if (level === 'week' || level === 'month') {
    const end = from > now || to <= now ? to - DAY_MS : startOfDay(now)
    return `${fmt(from, 'MM/DD')} – ${fmt(end, 'MM/DD')}`
  }
  return period
}

/** "依据 N 份日结"：本版条目直接引用的下层系列数 */
function inputCountOf(ctx: Ctx, versionId: number): number {
  const r = ctx.db
    .prepare(`SELECT COUNT(DISTINCT tv.series_id) AS n FROM refs r JOIN versions tv ON tv.id = r.target_version WHERE r.version_id = ? AND r.target_type = 'item'`)
    .get(versionId) as { n: number }
  return r.n
}

/** 该子系列被并入到本系列（参数）的哪个版本 */
function mergedInOf(ctx: Ctx, parentSeriesId: number, childSeriesId: number): number | undefined {
  const rows = ctx.db.prepare('SELECT version, inputs FROM versions WHERE series_id = ? ORDER BY version DESC').all(parentSeriesId) as unknown as Array<{ version: number; inputs: string }>
  for (const r of rows) {
    if ((JSON.parse(r.inputs) as Array<{ seriesId: number }>).some((i) => i.seriesId === childSeriesId)) return r.version
  }
  return undefined
}

export function registerSummary(api: Hono, ctx: Ctx) {
  // ── 2. 摘要卡片 ──
  api.get('/card', (c) => {
    const level = c.req.query('level') as Level
    if (!LEVELS.includes(level)) return c.json({ error: `未知层级 ${level}` }, 400)
    const date = c.req.query('date')
    let period = c.req.query('period') ?? ''
    if (!period && date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: '日期格式应为 YYYY-MM-DD' }, 400)
      if (level === 'hour') return c.json({ error: '小时层级需指定 period' }, 400)
      period = periodKey(level, periodRange('day', date).from)
    }
    if (!period) return c.json({ error: '缺少 period 或 date' }, 400)
    if (!PERIOD_RE[level].test(period)) return c.json({ error: '周期键格式不合法' }, 400)

    const now = ctx.clock.now()
    const s = getSeries(ctx.db, level, period)
    const versionParam = c.req.query('version')

    let state: CardResponse['state']
    let error: string | undefined
    let bundle: VersionBundle | undefined
    if (versionParam !== undefined) {
      const v = Number(versionParam)
      if (!Number.isInteger(v) || v < 1) return c.json({ error: 'version 应为正整数' }, 400)
      if (!s || v > s.current_version) return c.json({ error: `版本不存在：v${v}` }, 404)
      bundle = getVersion(ctx.db, s.id, v)
      if (!bundle) return c.json({ error: `版本不存在：v${v}` }, 404)
      state = 'ok'
    } else if (s?.state === 'generating') {
      state = 'generating'
    } else if (s && s.current_version > 0) {
      bundle = getVersion(ctx.db, s.id, s.current_version)
      state = bundle ? 'ok' : 'failed'
    } else if (s?.state === 'failed') {
      state = 'failed'
      error = failureText(s.last_error ?? '生成失败')
    } else {
      state = periodRange(level, period).to <= now ? 'empty' : 'none'
    }

    const res: CardResponse = {
      level,
      period,
      rangeLabel: rangeLabel(level, period, now),
      state,
      upstreamChanged: s?.upstream_changed === 1,
      items: bundle ? itemViews(ctx, bundle.meta.id) : [],
      inputCount: bundle ? inputCountOf(ctx, bundle.meta.id) : 0,
    }
    if (error !== undefined) res.error = error
    if (state === 'none') res.scheduledAt = scheduledAtFor(ctx.db, level, period, now) ?? undefined
    if (bundle) res.version = versionMeta(bundle)
    if (level === 'day') res.dayStats = dayStats(ctx, period)
    return c.json(res)
  })

  // ── 5. 版本列表 ──
  api.get('/series/:level/:period/versions', (c) => {
    const level = c.req.param('level') as Level
    if (!LEVELS.includes(level)) return c.json({ error: `未知层级 ${level}` }, 400)
    const period = c.req.param('period')
    if (!PERIOD_RE[level].test(period)) return c.json({ error: '周期键格式不合法' }, 400)
    const s = getSeries(ctx.db, level, period)
    const res: VersionListResponse = {
      level,
      period,
      upstreamChanged: s?.upstream_changed === 1,
      versions: s
        ? listVersions(ctx.db, s.id)
            .reverse() // 新 → 旧
            .map((m) => ({ version: m.version, createdAt: m.created_at, trigger: m.trigger, mode: m.mode, isFinal: m.is_final === 1, model: m.model, changes: versionChanges(ctx.db, s.id, m.version), inputNote: inputNote(ctx.db, m) }))
        : [],
    }
    return c.json(res)
  })

  // ── 6. 版本对比 ──
  api.get('/series/:level/:period/diff', (c) => {
    const level = c.req.param('level') as Level
    if (!LEVELS.includes(level)) return c.json({ error: `未知层级 ${level}` }, 400)
    const period = c.req.param('period')
    if (!PERIOD_RE[level].test(period)) return c.json({ error: '周期键格式不合法' }, 400)
    const a = Number(c.req.query('a'))
    const b = Number(c.req.query('b'))
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < 1) return c.json({ error: 'a、b 应为版本号' }, 400)
    if (a === b) return c.json({ error: '两个版本不能相同' }, 400)
    const s = getSeries(ctx.db, level, period)
    if (!s) return c.json({ error: '摘要不存在' }, 404)
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (hi > s.current_version || lo < 1) return c.json({ error: `版本不存在：v${hi > s.current_version ? hi : lo}` }, 404)
    try {
      return c.json(diffVersions(ctx.db, s.id, lo, hi))
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
    }
  })

  // ── 7. 周期的下层输入 ──
  api.get('/series/:level/:period/children', (c) => {
    const level = c.req.param('level') as Level
    if (level !== 'week' && level !== 'month' && level !== 'year') return c.json({ error: '只支持周、月、年' }, 400)
    const period = c.req.param('period')
    if (!PERIOD_RE[level].test(period)) return c.json({ error: '周期键格式不合法' }, 400)
    const now = ctx.clock.now()
    const s = getSeries(ctx.db, level, period)
    const childLevel: Level = level === 'year' ? 'month' : 'day'
    const lowerLevel: Level = childLevel === 'day' ? 'hour' : 'day'

    const childPeriods: string[] = []
    if (level === 'week' || level === 'month') {
      const { from, to } = periodRange(level, period)
      for (let t = from; t < to; t += DAY_MS) childPeriods.push(dayKey(t))
    } else {
      const y = Number(period)
      for (let m = 1; m <= 12; m++) childPeriods.push(`${y}-${pad(m)}`)
    }

    const children: ChildPeriod[] = childPeriods.map((cp) => {
      const range = periodRange(childLevel, cp)
      const cs = getSeries(ctx.db, childLevel, cp)
      const label = childLabel(childLevel, cp)
      if (cs && cs.current_version > 0) {
        const bundle = getVersion(ctx.db, cs.id, cs.current_version)!
        return {
          period: cp,
          label,
          state: 'ok' as const,
          preview: bundle.items.slice(0, 2).map((i) => i.text),
          mergedIn: s ? mergedInOf(ctx, s.id, cs.id) : undefined,
        }
      }
      if (range.from > now) return { period: cp, label, state: 'future' as const, preview: [] }
      // 有下层内容但未生成 → none；完全无记录 → empty
      const hasLower = ctx.db
        .prepare('SELECT 1 FROM series WHERE level = ? AND period LIKE ? AND current_version > 0 LIMIT 1')
        .get(lowerLevel, childLevel === 'day' ? `${cp}T_` : `${cp}-%`) !== undefined
      const out: ChildPeriod = { period: cp, label, state: hasLower ? 'none' : 'empty', preview: [] }
      if (hasLower && childLevel === 'day' && cp === dayKey(now)) out.scheduledAt = nextDailyRunAt(ctx.db, now)
      return out
    })
    const res: ChildrenResponse = { children }
    return c.json(res)
  })

  // ── 8. 重新生成（小时级从原文生成，其余全量重建） ──
  api.post('/series/:level/:period/regenerate', async (c) => {
    const level = c.req.param('level') as Level
    if (!LEVELS.includes(level)) return c.json({ error: `未知层级 ${level}` }, 400)
    try {
      const version = await regenerate(ctx, level, c.req.param('period'))
      return c.json({ version })
    } catch (e) {
      if (e instanceof RegenerateError) return c.json({ error: e.message }, e.status)
      throw e
    }
  })

  // ── 9. 立即生成日结 ──
  let dailyRunning = false
  api.post('/daily/run', async (c) => {
    if (dailyRunning) return c.json({ error: '日结正在运行' }, 409)
    dailyRunning = true
    try {
      return c.json(await runDaily(ctx, dayKey(ctx.clock.now()), 'manual'))
    } finally {
      dailyRunning = false
    }
  })
}

function childLabel(level: Level, period: string): string {
  if (level === 'month') return `${Number(period.slice(5))} 月`
  const { from } = periodRange('day', period)
  return `${WEEKDAY_ZH[local(from).wd]} ${fmt(from, 'MM/DD')}`
}
