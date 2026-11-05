// 定时任务的时间规则：文案、编辑后的规则、前端校验（spec 第 2 节的允许范围）。
// 后端仍是最终裁判，400 的 error 直接显示在浮层里。
import type { JobName, ScheduleRule } from '../../src/api-types'
import { WEEKDAY_ZH } from '../../src/time'

const pad2 = (n: number) => String(n).padStart(2, '0')

export const RULE_TYPE: Record<JobName, ScheduleRule['type']> = {
  hourly: 'hourly',
  daily: 'daily',
  catchup: 'daily',
  yearly: 'monthly',
  backup_im: 'daily',
  backup_calendar: 'daily',
  backup_mail: 'weekly',
}

export function scheduleText(rule: ScheduleRule): string {
  switch (rule.type) {
    case 'hourly':
      return `每小时 :${pad2(rule.minute)}`
    case 'daily':
      return `每天 ${pad2(rule.hour)}:${pad2(rule.minute)}`
    case 'weekly':
      return `每周${WEEKDAY_ZH[rule.weekday].slice(1)} ${pad2(rule.hour)}:${pad2(rule.minute)}`
    case 'monthly':
      return `每月 ${rule.day} 日 ${pad2(rule.hour)}:${pad2(rule.minute)}`
  }
}

/** 24 小时刻度尺上每小时那个点的时间（小时摘要的 :05） */
export function hourlyMinute(rules: ScheduleRule[]): number {
  const hourly = rules.find((rule) => rule.type === 'hourly')
  return hourly && hourly.type === 'hourly' ? hourly.minute : 5
}

/** 覆盖条 pending 天悬停用：只写时间点，不带“每天/每周”前缀。02:00 / 周日 03:00 / 1 日 03:00 / :05 */
export function ruleTimeText(rule: ScheduleRule): string {
  switch (rule.type) {
    case 'hourly':
      return `:${pad2(rule.minute)}`
    case 'daily':
      return `${pad2(rule.hour)}:${pad2(rule.minute)}`
    case 'weekly':
      return `${WEEKDAY_ZH[rule.weekday].slice(1)} ${pad2(rule.hour)}:${pad2(rule.minute)}`
    case 'monthly':
      return `${rule.day} 日 ${pad2(rule.hour)}:${pad2(rule.minute)}`
  }
}

function minutes(rule: { hour: number; minute: number }): number {
  return rule.hour * 60 + rule.minute
}

/** 前端先按 spec 第 2 节的允许范围校验；不合法时返回提示文案 */
export function validateRule(job: JobName, rule: ScheduleRule): string | null {
  switch (rule.type) {
    case 'hourly':
      return rule.minute >= 1 && rule.minute <= 30 ? null : '小时摘要需在每小时第 1 到 30 分之间'
    case 'daily':
      if (job === 'daily') {
        const at = minutes(rule)
        return at >= 12 * 60 && at <= 23 * 60 + 59 ? null : '日结时间需在 12:00 到 23:59 之间'
      }
      if (job === 'catchup') {
        const at = minutes(rule)
        return at >= 0 && at <= 5 * 60 + 59 ? null : '补跑时间需在 00:00 到 05:59 之间'
      }
      return null
    case 'monthly':
      if (job === 'yearly') return rule.day >= 1 && rule.day <= 28 ? null : '年摘要需在每月 1 到 28 日之间'
      return null
    case 'weekly':
      return rule.weekday >= 1 && rule.weekday <= 7 ? null : '请选择周一到周日'
  }
}
