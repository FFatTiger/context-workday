// 备份接口（api-types 13–18）+ 全局状态（21）。
// rule / nextRunAt 从任务配置（jobs 表）读；备份中显示内存进度计数。
import type { BackupRun, BackupSource, BackupSourceStatus, CoverageResponse, Page, ScheduleRule, StatusResponse } from '../../api-types.js'
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { alerts, coverage } from '../../backup/coverage.js'
import { backupProgress, getWatermark, toApiRunFull, type RunRow } from '../../backup/run.js'
import { storage } from '../../backup/storage.js'
import { getJobRunner } from '../../jobs/registry.js'
import { ensureJobs, getJob, getJobRule } from '../../jobs/rules.js'
import { nextRun } from '../../jobs/rules.js'
import { affectedItems } from '../../summary/evidence.js'
import { dailyStatus } from '../../summary/rollup.js'
import { getSettings } from '../../settings.js'

const SOURCES: BackupSource[] = ['im', 'mail', 'calendar']

export function registerBackup(api: Hono, ctx: Ctx) {
  let batchRunning = false

  api.get('/backup/status', (c) => {
    const now = ctx.clock.now()
    ensureJobs(ctx.db, now)
    const statuses: BackupSourceStatus[] = SOURCES.map((source) => {
      const row = ctx.db
        .prepare('SELECT id, source, trigger, started_at, ended_at, result, error, added, watermark_after FROM backup_runs WHERE source = ? ORDER BY id DESC LIMIT 1')
        .get(source) as unknown as RunRow | undefined
      const retentionDays = ctx.source.retentionDays[source]
      let total: number
      if (source === 'im') {
        const r = ctx.db.prepare('SELECT COUNT(*) AS n FROM backup_days WHERE source = ? AND local_count >= client_count').get(source) as { n: number }
        total = r.n
      } else if (source === 'mail') {
        const r = ctx.db.prepare('SELECT COUNT(*) AS n FROM mails').get() as { n: number }
        total = r.n
      } else {
        const r = ctx.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
        total = r.n
      }
      const job = getJob(ctx.db, `backup_${source}`)
      const rule: ScheduleRule = job?.rule ?? getJobRule(ctx.db, `backup_${source}`)
      const state: BackupSourceStatus['state'] =
        !row || row.result === null ? 'never' : row.result === 'running' ? 'running' : row.result === 'success' ? 'ok' : (row.result as 'failed' | 'partial')
      return {
        source,
        state,
        total,
        retentionDays,
        rule,
        lastRun: row && row.result !== null ? { at: row.ended_at ?? row.started_at, result: row.result, error: row.error ?? undefined, added: row.added } : undefined,
        nextRunAt: job && !job.enabled ? null : nextRun(rule, now),
        watermark: getWatermark(ctx.db, source) ?? null,
        progress: row?.result === 'running' ? { read: backupProgress(source) } : undefined,
      }
    })
    return c.json(statuses)
  })

  api.get('/backup/coverage', (c) => {
    const source = (c.req.query('source') ?? 'im') as BackupSource
    if (!SOURCES.includes(source)) return c.json({ error: `未知来源 ${source}` }, 400)
    const defaultDays = source === 'mail' ? 120 : 60
    const days = Math.max(1, Math.min(365, Number(c.req.query('days') ?? defaultDays)))
    const res: CoverageResponse = coverage(ctx, source, days)
    return c.json(res)
  })

  api.get('/backup/affected', (c) => {
    return c.json({ items: affectedItems(ctx) })
  })

  api.get('/backup/runs', (c) => {
    const source = c.req.query('source')
    const result = c.req.query('result')
    const page = Math.max(1, Number(c.req.query('page') ?? 1))
    const pageSize = 20
    const where: string[] = []
    const args: Array<string | number> = []
    if (source) {
      where.push('source = ?')
      args.push(source)
    }
    if (result) {
      where.push('result = ?')
      args.push(result)
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM backup_runs ${cond}`).get(...args) as { n: number }).n
    const rows = ctx.db
      .prepare(`SELECT id, source, trigger, started_at, ended_at, result, error, added, watermark_after FROM backup_runs ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, (page - 1) * pageSize) as unknown as RunRow[]
    const out: Page<BackupRun> = { items: rows.map((r) => toApiRunFull(ctx.db, r)), total, page, pageSize }
    return c.json(out)
  })

  api.get('/backup/storage', (c) => c.json(storage(ctx)))

  api.post('/backup/run', async (c) => {
    if (!batchRunning) {
      batchRunning = true
      const runner = getJobRunner(ctx)
      void (async () => {
        for (const source of SOURCES) {
          try {
            await runner.run(`backup_${source}`, 'manual')
          } catch (e) {
            ctx.log(`立即备份异常 [${source}]：${e instanceof Error ? e.message : e}`)
          }
        }
        batchRunning = false
      })()
    }
    return c.json({ started: true })
  })

  // ── 21. 全局状态 ──
  api.get('/status', (c) => {
    const now = ctx.clock.now()
    const lastIm = ctx.db.prepare("SELECT id, source, trigger, started_at, ended_at, result, error, added, watermark_after FROM backup_runs WHERE source = 'im' ORDER BY id DESC LIMIT 1").get() as unknown as RunRow | undefined
    const backedUpDays = (ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_days WHERE source = 'im' AND local_count >= client_count").get() as { n: number }).n
    const res: StatusResponse = {
      now,
      im: { lastAt: lastIm?.ended_at ?? null, result: lastIm?.result ?? null, backedUpDays },
      daily: dailyStatus(ctx),
      alerts: alerts(ctx),
      redact: getSettings(ctx.db).redact,
      demo: ctx.config.demo,
    }
    return c.json(res)
  })
}
