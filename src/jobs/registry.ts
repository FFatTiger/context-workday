// 7 个任务的名字、标题、说明、执行函数（spec 第 2 节）。调度器的定时触发和任务页的"立即运行"都走 JobRunner：
// 同一任务同一时刻只跑一个实例；摘要类任务之间共用一个串行队列（同一摘要系列的生成必须串行）。
// 每次执行都写一条任务级的 task_runs 记录；小时摘要另外还有每个小时一条（runHour 自己写）。
import type { BackupSource, JobName, TaskRun } from '../api-types.js'
import type { Ctx } from '../context.js'
import { runBackup } from '../backup/run.js'
import { pendingHours, runHour } from '../summary/hourly.js'
import { runCatchup, runDaily, runYearly, startRun, backfillMissingDailies } from '../summary/rollup.js'
import { DAY_MS, dayKey, monthKey, periodRange } from '../time.js'
import { JOB_TITLES, recordJobRan } from './rules.js'

export interface JobDef {
  name: JobName
  title: string
  description: string
  kind: 'summary' | 'backup'
  /** kind=backup 时对应的备份来源 */
  source?: BackupSource
  execute(ctx: Ctx, trigger: TaskRun['trigger']): Promise<TaskRun>
}

/** runHour 接受的小时触发方式（不含 retry：只有备份会自动重试） */
const toHourTrigger = (trigger: TaskRun['trigger']): 'scheduled' | 'startup' | 'manual' | 'late' | 'catchup' =>
  trigger === 'retry' ? 'scheduled' : trigger

/** 小时摘要：把待处理清单（过去 7 天没有 success/skipped 记录的小时）逐个跑完 */
const hourlyDef: JobDef = {
  name: 'hourly',
  title: JOB_TITLES.hourly,
  description: '逐个处理待处理小时：过去 7 天内还没有摘要的小时，按时间从早到晚生成',
  kind: 'summary',
  async execute(ctx, trigger) {
    const pending = pendingHours(ctx)
    // 目标写成"N 个小时"：绝不和小时周期键同形，避免被 pendingHours 误认成已处理
    const run = startRun(ctx, 'hourly', `${pending.length} 个小时`, trigger)
    if (pending.length === 0) return run.finish('skipped', '没有待处理小时')
    let failed = 0
    for (const key of pending) {
      const r = await runHour(ctx, key, toHourTrigger(trigger))
      if (r.result === 'failed') failed++
    }
    const note = failed > 0 ? `处理 ${pending.length} 个小时 · ${failed} 个失败` : `处理 ${pending.length} 个小时`
    return run.finish(failed === pending.length ? 'failed' : 'success', note)
  },
}

/** 日结：处理今天（核对迟到消息、生成日结、更新本周本月） */
const dailyDef: JobDef = {
  name: 'daily',
  title: JOB_TITLES.daily,
  description: '核对迟到消息，生成今天的日结，并增量更新本周、本月',
  kind: 'summary',
  execute(ctx, trigger) {
    return runDaily(ctx, dayKey(ctx.clock.now()), trigger === 'retry' ? 'scheduled' : trigger)
  },
}

/** 补跑：先补过去 7 天里只有小时摘要、没有日结的日子（票 11），再对昨天补跑；周日、月末收尾 */
const catchupDef: JobDef = {
  name: 'catchup',
  title: JOB_TITLES.catchup,
  description: '日结跑完后又有新内容时，次日凌晨对前一天补跑；顺带补齐只有小时摘要的日子；周日收尾上周，月末收尾上月',
  kind: 'summary',
  async execute(ctx, trigger) {
    await backfillMissingDailies(ctx)
    return runCatchup(ctx, dayKey(ctx.clock.now() - DAY_MS), trigger === 'retry' ? 'scheduled' : trigger)
  },
}

/** 年摘要：把上个月的最终版月摘要并入本年 */
const yearlyDef: JobDef = {
  name: 'yearly',
  title: JOB_TITLES.yearly,
  description: '每月一次：先收尾上个月，再把上个月最终版月摘要并入本年',
  kind: 'summary',
  execute(ctx, trigger) {
    const prevMonth = monthKey(periodRange('month', monthKey(ctx.clock.now())).from - 1)
    return runYearly(ctx, prevMonth, trigger === 'retry' ? 'scheduled' : trigger)
  },
}

/** 备份任务：task_runs 记任务级运行，backup_runs 由 runBackup 记（部分成功也算失败，等每小时重试） */
function backupDef(name: JobName, source: BackupSource, title: string, description: string): JobDef {
  return {
    name,
    title,
    description,
    kind: 'backup',
    source,
    async execute(ctx, trigger) {
      const run = startRun(ctx, name, source, trigger)
      const res = await runBackup(ctx, source, trigger)
      if (res.result === 'success') return run.finish('success', `新增 ${res.added} 条`)
      if (res.result === 'partial') return run.finish('failed', `部分成功：${res.note}`)
      return run.finish('failed', res.error ?? '备份失败')
    },
  }
}

export const JOB_DEFS: JobDef[] = [
  hourlyDef,
  dailyDef,
  catchupDef,
  yearlyDef,
  backupDef('backup_im', 'im', JOB_TITLES.backup_im, '备份全部会话的新消息（客户端 IM 只保留 7 天）'),
  backupDef('backup_calendar', 'calendar', JOB_TITLES.backup_calendar, '备份新增和有变更的日程'),
  backupDef('backup_mail', 'mail', JOB_TITLES.backup_mail, '备份新邮件，含已发送（客户端邮件只保留 3 个月）'),
]

export const JOB_DEFS_BY_NAME: Record<JobName, JobDef> = Object.fromEntries(JOB_DEFS.map((d) => [d.name, d])) as Record<JobName, JobDef>

// ───────── 执行器 ─────────

/**
 * 每个Ctx一个实例（WeakMap 保证调度器和路由拿到同一个）。
 * inflight 按 JobName 互斥；摘要类任务额外过一个串行队列。
 */
export class JobRunner {
  private inflight = new Map<JobName, Promise<TaskRun | undefined>>()
  /** 摘要类任务的串行队列：后一个等前一个跑完 */
  private gate: Promise<void> = Promise.resolve()

  constructor(private ctx: Ctx) {}

  isRunning(name: JobName): boolean {
    return this.inflight.has(name)
  }

  /** 已在运行返回 undefined（调用方按 409 处理） */
  run(name: JobName, trigger: TaskRun['trigger']): Promise<TaskRun | undefined> {
    const def = JOB_DEFS_BY_NAME[name]
    if (!def) return Promise.resolve(undefined)
    if (this.inflight.has(name)) return Promise.resolve(undefined)
    let release: (() => void) | undefined
    let gate = Promise.resolve()
    if (def.kind === 'summary') {
      gate = this.gate
      this.gate = new Promise((r) => {
        release = r
      })
    }
    const ctx = this.ctx
    const p = (async () => {
      if (release) await gate
      let out: TaskRun | undefined
      try {
        out = await def.execute(ctx, trigger)
      } catch (e) {
        ctx.log(`任务 ${def.title} 异常：${e instanceof Error ? e.message : e}`)
      } finally {
        try {
          recordJobRan(ctx.db, name, ctx.clock.now())
        } catch {
          // 任务表缺行时（如测试里直接建库）忽略
        }
        release?.()
      }
      return out
    })()
    this.inflight.set(name, p)
    void p.finally(() => {
      if (this.inflight.get(name) === p) this.inflight.delete(name)
    })
    return p
  }
}

const runners = new WeakMap<Ctx, JobRunner>()

export function getJobRunner(ctx: Ctx): JobRunner {
  let r = runners.get(ctx)
  if (!r) {
    r = new JobRunner(ctx)
    runners.set(ctx, r)
  }
  return r
}
