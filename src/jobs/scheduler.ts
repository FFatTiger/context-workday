// 调度器（spec 第 2 节）。定时器只负责周期性调 tick()，到期判断都在 tick 里，
// 所以 sim 和测试可以不起定时器：拨 ManualClock 后直接 await tick()。
// 启动时（构造 startScheduler）先做一次"启动补跑"：每个启用的任务立即检查一次待处理清单，trigger='startup'。
import type { JobName } from '../api-types.js'
import type { Ctx } from '../context.js'
import { lastRun as lastBackupRun, needsRetry } from '../backup/run.js'
import { pendingHours } from '../summary/hourly.js'
import { getSeries } from '../summary/store.js'
import { DAY_MS, dayKey, hourKey, monthKey, periodRange, startOfDay } from '../time.js'
import { getJobRunner } from './registry.js'
import { type JobRow, ensureJobs, listJobs, minuteOfDay, prevRun } from './rules.js'

export interface Scheduler {
  stop(): void
  tick(): Promise<void>
}

/** 上次进程退出时还在跑的运行记为中断（spec 第 2 节），由待处理清单重新处理 */
export function markInterrupted(ctx: Ctx): void {
  const now = ctx.clock.now()
  ctx.db
    .prepare("UPDATE task_runs SET result = 'interrupted', ended_at = ?, note = CASE WHEN note = '' THEN '程序退出时中断' ELSE note END WHERE result = 'running'")
    .run(now)
  ctx.db
    .prepare("UPDATE backup_runs SET result = 'failed', ended_at = ?, error = COALESCE(error, '程序退出时中断') WHERE result = 'running'")
    .run(now)
}

/** 备份任务名 → 备份来源 */
const BACKUP_SOURCES: Array<[JobName, 'im' | 'calendar' | 'mail']> = [
  ['backup_im', 'im'],
  ['backup_calendar', 'calendar'],
  ['backup_mail', 'mail'],
]

export function startScheduler(ctx: Ctx, opts: { intervalMs?: number } = {}): Scheduler {
  const db = ctx.db
  ensureJobs(db, ctx.clock.now())
  markInterrupted(ctx)
  const runner = getJobRunner(ctx)

  const runJob = (name: JobName, trigger: 'scheduled' | 'startup' | 'retry') =>
    runner.run(name, trigger).then(
      () => undefined,
      () => undefined,
    )

  /** 启动补跑：错过的小时按时间顺序补齐；日结/补跑/年摘要按"计划时间已过且没跑过"；备份按"最近一次计划运行没有记录" */
  async function startupPass(): Promise<void> {
    const now = ctx.clock.now()
    const due: Array<Promise<void>> = []
    for (const j of listJobs(db)) {
      if (!j.enabled || runner.isRunning(j.name)) continue
      switch (j.name) {
        case 'hourly':
          if (pendingHours(ctx).length > 0) due.push(runJob('hourly', 'startup'))
          break
        case 'daily': {
          const s = getSeries(db, 'day', dayKey(now))
          const past = now >= startOfDay(now) + minuteOfDay(j.rule) * 60_000
          if (past && (!s || (s.current_version === 0 && s.state !== 'generating'))) due.push(runJob('daily', 'startup'))
          break
        }
        case 'catchup': {
          const yesterday = dayKey(now - DAY_MS)
          const ran = db
            .prepare("SELECT 1 FROM task_runs WHERE job = 'catchup' AND target = ? AND result IN ('success','skipped') LIMIT 1")
            .get(yesterday)
          const past = now >= startOfDay(now) + minuteOfDay(j.rule) * 60_000
          if (past && !ran) due.push(runJob('catchup', 'startup'))
          break
        }
        case 'yearly': {
          // 最近一次计划运行要处理的月份，和"现在该处理的月份"（上个月）一致才算错过
          const occ = prevRun(j.rule, now)
          const occTarget = monthKey(occ - DAY_MS)
          const curTarget = monthKey(periodRange('month', monthKey(now)).from - 1)
          const ran = db.prepare("SELECT 1 FROM task_runs WHERE job = 'yearly' AND target = ? AND started_at >= ? LIMIT 1").get(occTarget, occ)
          if (occTarget === curTarget && !ran) due.push(runJob('yearly', 'startup'))
          break
        }
        default: {
          const source = BACKUP_SOURCES.find(([n]) => n === j.name)?.[1]
          if (!source) break
          const occ = prevRun(j.rule, now)
          const ran = db.prepare('SELECT 1 FROM backup_runs WHERE source = ? AND started_at >= ? LIMIT 1').get(source, occ)
          if (!ran) due.push(runJob(j.name, 'startup'))
          break
        }
      }
    }
    await Promise.all(due)
  }

  let startupPromise: Promise<void> | null = startupPass()

  async function tick(): Promise<void> {
    if (startupPromise) {
      const p = startupPromise
      startupPromise = null
      await p
    }
    const now = ctx.clock.now()
    const jobs = new Map<JobName, JobRow>(listJobs(db).map((j) => [j.name, j]))
    const due: Array<Promise<void>> = []
    for (const j of jobs.values()) {
      if (!j.enabled || j.nextRunAt === null || runner.isRunning(j.name)) continue
      if (now >= j.nextRunAt) due.push(runJob(j.name, 'scheduled'))
    }
    // 备份失败或部分成功：进入新的小时后自动重试（trigger='retry'），直到成功（spec 第 9 节）
    for (const [name, source] of BACKUP_SOURCES) {
      const j = jobs.get(name)
      if (!j?.enabled || runner.isRunning(name)) continue
      if (!needsRetry(db, source)) continue
      const last = lastBackupRun(db, source)
      const lastAt = last ? (last.endedAt ?? last.startedAt) : null
      if (lastAt !== null && hourKey(now) === hourKey(lastAt)) continue
      due.push(runJob(name, 'retry'))
    }
    await Promise.all(due)
  }

  const timer = setInterval(() => {
    void tick().catch((e) => ctx.log(`调度异常：${e instanceof Error ? e.message : e}`))
  }, opts.intervalMs ?? 60_000)
  timer.unref?.()

  return {
    stop() {
      clearInterval(timer)
    },
    tick,
  }
}
