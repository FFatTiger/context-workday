// 任务规则（spec 第 2 节）：默认规则、按任务允许范围的校验、上海时区的下次/上次运行时间、jobs 表读写。
// 02/03 票里写死的"下一个 :05""20:30""00:30""每月 1 日 03:00"都改从这里读任务配置。
import type { JobName, ScheduleRule } from '../api-types.js'
import type { Db } from '../db/db.js'
import { tx } from '../db/db.js'
import { DAY_MS, HOUR_MS, fromLocal, local, startOfDay, startOfHour } from '../time.js'

export const JOB_TITLES: Record<JobName, string> = {
  hourly: '小时摘要',
  daily: '日结',
  catchup: '补跑',
  yearly: '年摘要',
  backup_im: 'IM 备份',
  backup_calendar: '日程备份',
  backup_mail: '邮件备份',
}

/** spec 第 2 节的默认规则表 */
export const DEFAULT_RULES: Record<JobName, ScheduleRule> = {
  hourly: { type: 'hourly', minute: 5 },
  daily: { type: 'daily', hour: 20, minute: 30 },
  catchup: { type: 'daily', hour: 0, minute: 30 },
  yearly: { type: 'monthly', day: 1, hour: 3, minute: 0 },
  backup_im: { type: 'daily', hour: 2, minute: 0 },
  backup_calendar: { type: 'daily', hour: 2, minute: 0 },
  backup_mail: { type: 'weekly', weekday: 7, hour: 3, minute: 0 },
}

export const JOB_NAMES = Object.keys(DEFAULT_RULES) as JobName[]

export function isJobName(v: string): v is JobName {
  return (JOB_NAMES as string[]).includes(v)
}

// ───────── 下次 / 上次运行时间（上海时区） ─────────

/** 严格晚于 now 的下一次运行时间 */
export function nextRun(rule: ScheduleRule, now: number): number {
  if (rule.type === 'hourly') {
    const t = startOfHour(now) + rule.minute * 60_000
    return t > now ? t : t + HOUR_MS
  }
  if (rule.type === 'daily') {
    const t = startOfDay(now) + rule.hour * HOUR_MS + rule.minute * 60_000
    return t > now ? t : t + DAY_MS
  }
  if (rule.type === 'weekly') {
    for (let i = 0; i < 8; i++) {
      const day = startOfDay(now) + i * DAY_MS
      if (local(day).wd === rule.weekday) {
        const t = day + rule.hour * HOUR_MS + rule.minute * 60_000
        if (t > now) return t
      }
    }
    return now + 7 * DAY_MS // 到不了：8 天内必有一个工作日匹配
  }
  // monthly：日期上限 28，任何月份都存在
  const l = local(now)
  let y = l.y
  let mo = l.mo
  for (let i = 0; i < 4; i++) {
    const t = fromLocal(y, mo, rule.day, rule.hour, rule.minute)
    if (t > now) return t
    mo++
    if (mo > 12) {
      mo = 1
      y++
    }
  }
  return now + 366 * DAY_MS // 到不了
}

/** 不晚于 now 的最近一次运行时间（启动时判断"上一次计划运行有没有错过"用） */
export function prevRun(rule: ScheduleRule, now: number): number {
  if (rule.type === 'hourly') {
    const t = startOfHour(now) + rule.minute * 60_000
    return t <= now ? t : t - HOUR_MS
  }
  if (rule.type === 'daily') {
    const t = startOfDay(now) + rule.hour * HOUR_MS + rule.minute * 60_000
    return t <= now ? t : t - DAY_MS
  }
  if (rule.type === 'weekly') {
    const weekStart = startOfDay(now) - (local(now).wd - 1) * DAY_MS
    const t = weekStart + (rule.weekday - 1) * DAY_MS + rule.hour * HOUR_MS + rule.minute * 60_000
    return t <= now ? t : t - 7 * DAY_MS
  }
  const l = local(now)
  const t = fromLocal(l.y, l.mo, rule.day, rule.hour, rule.minute)
  if (t <= now) return t
  const prevMonthStart = l.mo === 1 ? fromLocal(l.y - 1, 12) : fromLocal(l.y, l.mo - 1)
  return prevMonthStart + (rule.day - 1) * DAY_MS + rule.hour * HOUR_MS + rule.minute * 60_000
}

/** daily 规则在一天内的分钟数（hourly 规则就是它的分钟数） */
export function minuteOfDay(rule: ScheduleRule): number {
  return rule.type === 'hourly' ? rule.minute : rule.hour * 60 + rule.minute
}

// ───────── 校验（spec 第 2 节允许范围；不合法抛中文提示） ─────────

const isInt = (v: unknown): v is number => Number.isInteger(v)
const checkMinute = (v: unknown, msg = '分钟需在 0 到 59 之间'): number => {
  if (!isInt(v) || v < 0 || v > 59) throw new Error(msg)
  return v
}
const checkHour = (v: unknown): number => {
  if (!isInt(v) || v < 0 || v > 23) throw new Error('小时需在 0 到 23 之间')
  return v
}

/** 按任务允许范围校验时间规则，合法就返回规整后的规则；不合法抛带中文提示的 Error */
export function validateRule(name: JobName, input: unknown): ScheduleRule {
  if (typeof input !== 'object' || input === null) throw new Error('时间规则不合法')
  const r = input as Record<string, unknown>
  switch (name) {
    case 'hourly':
      if (r.type !== 'hourly') throw new Error('小时摘要需为每小时的时间规则')
      if (!isInt(r.minute) || r.minute < 1 || r.minute > 30) throw new Error('小时摘要时间需在第 1 到 30 分之间')
      return { type: 'hourly', minute: r.minute }
    case 'daily':
    case 'catchup': {
      if (r.type !== 'daily') throw new Error(`${JOB_TITLES[name]}需为每天的时间规则`)
      if (name === 'daily') {
        if (!isInt(r.hour) || r.hour < 12 || r.hour > 23) throw new Error('日结时间需在 12:00 到 23:59 之间')
      } else if (!isInt(r.hour) || r.hour < 0 || r.hour > 5) {
        throw new Error('补跑时间需在 00:00 到 05:59 之间')
      }
      return { type: 'daily', hour: r.hour, minute: checkMinute(r.minute) }
    }
    case 'yearly':
      if (r.type !== 'monthly') throw new Error('年摘要需为每月的时间规则')
      if (!isInt(r.day) || r.day < 1 || r.day > 28) throw new Error('年摘要日期需在 1 到 28 日之间')
      return { type: 'monthly', day: r.day, hour: checkHour(r.hour), minute: checkMinute(r.minute) }
    default: {
      // 备份任务：时间任意（spec 第 2 节），只做格式校验
      if (r.type === 'hourly') return { type: 'hourly', minute: checkMinute(r.minute) }
      if (r.type === 'daily') return { type: 'daily', hour: checkHour(r.hour), minute: checkMinute(r.minute) }
      if (r.type === 'weekly') {
        if (!isInt(r.weekday) || r.weekday < 1 || r.weekday > 7) throw new Error('星期需在 1 到 7 之间（1=周一）')
        return { type: 'weekly', weekday: r.weekday, hour: checkHour(r.hour), minute: checkMinute(r.minute) }
      }
      if (r.type === 'monthly') {
        if (!isInt(r.day) || r.day < 1 || r.day > 28) throw new Error('日期需在 1 到 28 日之间')
        return { type: 'monthly', day: r.day, hour: checkHour(r.hour), minute: checkMinute(r.minute) }
      }
      throw new Error('时间规则不合法')
    }
  }
}

// ───────── jobs 表读写 ─────────

export interface JobRow {
  name: JobName
  enabled: boolean
  rule: ScheduleRule
  lastRunAt: number | null
  nextRunAt: number | null
}

function rowToJob(row: { name: string; enabled: number; rule: string; last_run_at: number | null; next_run_at: number | null }): JobRow {
  return {
    name: row.name as JobName,
    enabled: row.enabled === 1,
    rule: JSON.parse(row.rule) as ScheduleRule,
    lastRunAt: row.last_run_at ?? null,
    nextRunAt: row.next_run_at ?? null,
  }
}

/** 首次启动写入默认规则（spec 第 2 节）。已存在的行不动 */
export function ensureJobs(db: Db, now: number): void {
  for (const name of JOB_NAMES) {
    db.prepare('INSERT INTO jobs (name, enabled, rule, last_run_at, next_run_at) VALUES (?, 1, ?, NULL, ?) ON CONFLICT(name) DO NOTHING').run(
      name,
      JSON.stringify(DEFAULT_RULES[name]),
      nextRun(DEFAULT_RULES[name], now),
    )
  }
}

/** 按 spec 第 2 节的顺序 */
export function listJobs(db: Db): JobRow[] {
  const rows = db.prepare('SELECT name, enabled, rule, last_run_at, next_run_at FROM jobs').all() as unknown as Array<{ name: string; enabled: number; rule: string; last_run_at: number | null; next_run_at: number | null }>
  const byName = new Map(rows.map((r) => [r.name, rowToJob(r)]))
  return JOB_NAMES.map((n) => byName.get(n)).filter((j): j is JobRow => j !== undefined)
}

export function getJob(db: Db, name: JobName): JobRow | undefined {
  const row = db.prepare('SELECT name, enabled, rule, last_run_at, next_run_at FROM jobs WHERE name = ?').get(name) as { name: string; enabled: number; rule: string; last_run_at: number | null; next_run_at: number | null } | undefined
  return row ? rowToJob(row) : undefined
}

/** 读规则；任务表还没写默认值时（如路由先于调度器被调用）回落默认规则 */
export function getJobRule(db: Db, name: JobName): ScheduleRule {
  return getJob(db, name)?.rule ?? DEFAULT_RULES[name]
}

/** 保存修改（调用前已用 validateRule 校验），重算下次运行；停用后 nextRunAt=null */
export function saveJob(db: Db, name: JobName, patch: { enabled?: boolean; rule?: ScheduleRule }, now: number): JobRow {
  const cur = getJob(db, name)
  if (!cur) throw new Error(`未知任务 ${name}`)
  const enabled = patch.enabled ?? cur.enabled
  const rule = patch.rule ?? cur.rule
  const nextRunAt = enabled ? nextRun(rule, now) : null
  tx(db, () => {
    db.prepare('UPDATE jobs SET enabled = ?, rule = ?, next_run_at = ? WHERE name = ?').run(enabled ? 1 : 0, JSON.stringify(rule), nextRunAt, name)
  })
  return getJob(db, name)!
}

/** 任务跑完（无论成败）后更新 last/next；停用的任务保持 nextRunAt=null */
export function recordJobRan(db: Db, name: JobName, now: number): void {
  const cur = getJob(db, name)
  if (!cur) return
  db.prepare('UPDATE jobs SET last_run_at = ?, next_run_at = ? WHERE name = ?').run(now, cur.enabled ? nextRun(cur.rule, now) : null, name)
}
