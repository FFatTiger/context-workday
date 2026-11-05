// 任务页假数据：7 个定时任务和运行记录，时间照 docs/design/prototype/tasks.png。
import type { Job, JobName, Page, ScheduleRule, TaskRun } from '../../../src/api-types'
import { fromLocal, local } from '../../../src/time'
import { NOW } from './core'
import { currentScenario } from './scenario'

const HOUR = 3_600_000
const DAY = 86_400_000

function nextRunAt(rule: ScheduleRule, from: number): number {
  const l = local(from)
  switch (rule.type) {
    case 'hourly': {
      const at = fromLocal(l.y, l.mo, l.d, l.h, rule.minute)
      return at > from ? at : at + HOUR
    }
    case 'daily': {
      const at = fromLocal(l.y, l.mo, l.d, rule.hour, rule.minute)
      return at > from ? at : at + DAY
    }
    case 'weekly': {
      const at = fromLocal(l.y, l.mo, l.d, rule.hour, rule.minute) + ((rule.weekday - l.wd + 7) % 7) * DAY
      return at > from ? at : at + 7 * DAY
    }
    case 'monthly': {
      const at = fromLocal(l.y, l.mo, rule.day, rule.hour, rule.minute)
      if (at > from) return at
      return l.mo === 12
        ? fromLocal(l.y + 1, 1, rule.day, rule.hour, rule.minute)
        : fromLocal(l.y, l.mo + 1, rule.day, rule.hour, rule.minute)
    }
  }
}

function job(
  name: JobName,
  title: string,
  description: string,
  rule: ScheduleRule,
  lastRun: Job['lastRun'],
): Job {
  return { name, title, description, enabled: true, rule, running: false, lastRun, nextRunAt: nextRunAt(rule, NOW) }
}

let jobs: Job[] = [
  job('hourly', '小时摘要', '只更新刚结束的那个小时', { type: 'hourly', minute: 5 }, {
    at: fromLocal(2026, 10, 29, 20, 5),
    result: 'success',
  }),
  job('daily', '日结', '生成日结，增量更新本周和本月', { type: 'daily', hour: 20, minute: 30 }, {
    at: fromLocal(2026, 10, 29, 20, 30),
    result: 'success',
  }),
  job('catchup', '补跑', '日结后又有工作时次日补上，周期结束时收尾', { type: 'daily', hour: 0, minute: 30 }, {
    at: fromLocal(2026, 10, 29, 0, 30),
    result: 'skipped',
  }),
  job('yearly', '年摘要', '并入上个月', { type: 'monthly', day: 1, hour: 3, minute: 0 }, {
    at: fromLocal(2026, 10, 1, 3, 0),
    result: 'success',
  }),
  job('backup_im', 'IM 备份', '客户端只留 7 天', { type: 'daily', hour: 2, minute: 0 }, {
    at: fromLocal(2026, 10, 29, 2, 0),
    result: 'success',
  }),
  job('backup_calendar', '日程备份', '全部日程', { type: 'daily', hour: 2, minute: 0 }, {
    at: fromLocal(2026, 10, 29, 2, 0),
    result: 'success',
  }),
  job('backup_mail', '邮件备份', '客户端留 3 个月', { type: 'weekly', weekday: 7, hour: 3, minute: 0 }, {
    at: fromLocal(2026, 10, 25, 3, 0),
    result: 'success',
  }),
]

function clone(job: Job): Job {
  return { ...job, rule: { ...job.rule } }
}

export function fixtureJobs(): Job[] {
  const scenario = currentScenario()
  if (scenario === 'empty') return []
  const running = scenario === 'generating' ? 'hourly' : null
  return jobs.map((entry) => ({
    ...clone(entry),
    running: entry.name === running,
  }))
}

export function fixturePatchJob(name: JobName, patch: { enabled?: boolean; rule?: ScheduleRule }): Job {
  const found = jobs.find((entry) => entry.name === name)
  if (!found) throw new Error('没有这个任务')
  if (patch.enabled !== undefined) found.enabled = patch.enabled
  if (patch.rule) found.rule = { ...patch.rule }
  found.nextRunAt = found.enabled ? nextRunAt(found.rule, NOW) : null
  return clone(found)
}

export function fixtureRunJob(name: JobName): { runId: number } {
  const found = jobs.find((entry) => entry.name === name)
  if (!found) throw new Error('没有这个任务')
  if (found.running) throw new Error('任务正在运行，稍后再试')
  found.running = true
  if (currentScenario() !== 'empty') {
    runs = [
      {
        id: 100 + runs.length,
        job: name,
        target: found.title,
        scheduledAt: null,
        startedAt: NOW,
        endedAt: null,
        result: 'running',
        trigger: 'manual',
        note: '手动触发',
        outputs: [],
      },
      ...runs,
    ]
  }
  return { runId: runs[0]?.id ?? 0 }
}

function run(
  id: number,
  job: JobName,
  target: string,
  startedAt: number,
  endedAt: number | null,
  result: TaskRun['result'],
  trigger: TaskRun['trigger'],
  note: string,
  outputs: TaskRun['outputs'] = [],
  scheduledAt: number | null = null,
): TaskRun {
  return { id, job, target, scheduledAt, startedAt, endedAt, result, trigger, note, outputs }
}

let runs: TaskRun[] = [
  run(9, 'hourly', '小时摘要 · 20:00', fromLocal(2026, 10, 29, 20, 5), fromLocal(2026, 10, 29, 20, 5) + 21_000, 'success', 'scheduled', '生成 小时摘要 v1 · 2 条', [
    { level: 'hour', period: '2026-10-29T20', version: 1 },
  ], fromLocal(2026, 10, 29, 20, 5)),
  run(8, 'daily', '日结 · 10/29', fromLocal(2026, 10, 29, 20, 30), fromLocal(2026, 10, 29, 20, 30) + 48_000, 'success', 'scheduled', '生成 日结 v1 · 本周 v4 · 本月 v16', [
    { level: 'day', period: '2026-10-29', version: 1 },
    { level: 'week', period: '2026-W44', version: 4 },
    { level: 'month', period: '2026-10', version: 16 },
  ], fromLocal(2026, 10, 29, 20, 30)),
  run(7, 'hourly', '小时摘要 · 19:00', fromLocal(2026, 10, 29, 19, 5), fromLocal(2026, 10, 29, 19, 5) + 18_000, 'success', 'scheduled', '生成 小时摘要 v1 · 1 条', [
    { level: 'hour', period: '2026-10-29T19', version: 1 },
  ], fromLocal(2026, 10, 29, 19, 5)),
  run(6, 'backup_im', 'IM 消息', fromLocal(2026, 10, 29, 2, 0), fromLocal(2026, 10, 29, 2, 0) + 38_000, 'success', 'scheduled', '新增 1,284 条', [], fromLocal(2026, 10, 29, 2, 0)),
  run(5, 'catchup', '补跑 · 10/28', fromLocal(2026, 10, 29, 0, 30), fromLocal(2026, 10, 29, 0, 30) + 3_000, 'skipped', 'scheduled', '前一天日结之后没有新的小时摘要', [], fromLocal(2026, 10, 29, 0, 30)),
  run(4, 'backup_mail', '邮件', fromLocal(2026, 10, 25, 3, 0), fromLocal(2026, 10, 25, 3, 0) + 130_000, 'success', 'scheduled', '新增 46 封', [], fromLocal(2026, 10, 25, 3, 0)),
  run(3, 'daily', '日结 · 10/28', fromLocal(2026, 10, 28, 20, 30), fromLocal(2026, 10, 28, 20, 30) + 96_000, 'failed', 'scheduled', '模型调用超时，重试 3 次后仍失败', [], fromLocal(2026, 10, 28, 20, 30)),
  run(2, 'yearly', '年摘要 · 2026', fromLocal(2026, 10, 1, 3, 0), fromLocal(2026, 10, 1, 3, 0) + 64_000, 'success', 'scheduled', '生成 年摘要 v3', [
    { level: 'year', period: '2026', version: 3 },
  ], fromLocal(2026, 10, 1, 3, 0)),
  run(1, 'hourly', '小时摘要 · 14:00', fromLocal(2026, 10, 27, 14, 5), null, 'interrupted', 'scheduled', '程序退出时正在运行', [], fromLocal(2026, 10, 27, 14, 5)),
  run(0, 'catchup', '补跑 · 10/26', fromLocal(2026, 10, 27, 0, 30), fromLocal(2026, 10, 27, 0, 30) + 52_000, 'success', 'startup', '生成 日结 v2 · 本周 v2 · 本月 v13', [
    { level: 'day', period: '2026-10-26', version: 2 },
    { level: 'week', period: '2026-W44', version: 2 },
    { level: 'month', period: '2026-10', version: 13 },
  ], fromLocal(2026, 10, 27, 0, 30)),
]

const PAGE_SIZE = 6

export function fixtureRuns(query: { job?: string; result?: string; page?: number }): Page<TaskRun> {
  if (currentScenario() === 'empty') return { items: [], total: 0, page: 1, pageSize: PAGE_SIZE }
  const filtered = runs.filter(
    (entry) => (!query.job || entry.job === query.job) && (!query.result || entry.result === query.result),
  )
  const page = Math.max(1, query.page ?? 1)
  const start = (page - 1) * PAGE_SIZE
  return {
    items: filtered.slice(start, start + PAGE_SIZE),
    total: filtered.length,
    page,
    pageSize: PAGE_SIZE,
  }
}
