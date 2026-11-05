// 界面上的日期、时间、数量、版本和触发方式文案（ui.md 第 6 节）。
// 时间一律按 Asia/Shanghai，走 src/time.ts，不在前端自己算时区。
import type { BackupSource, Level, LostReason, RawType, Trigger, VersionMeta } from '../../src/api-types'
import { dayKey, fmt, fromLocal, local, periodKey, periodRange, WEEKDAY_ZH } from '../../src/time'

export const LEVEL_NAME: Record<Level, string> = {
  hour: '小时摘要',
  day: '日结',
  week: '周摘要',
  month: '月摘要',
  year: '年摘要',
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function hhmm(t: number): string {
  return fmt(t, 'HH:mm')
}

/** 10/29 */
export function md(t: number): string {
  return fmt(t, 'MM/DD')
}

/** 10/29 20:30 */
export function mdhm(t: number): string {
  return `${md(t)} ${hhmm(t)}`
}

/** 今天 02:00 / 昨天 03:00 / 10/25 03:00 */
export function relTime(t: number, now: number): string {
  const day = dayKey(t)
  if (day === dayKey(now)) return `今天 ${hhmm(t)}`
  if (day === dayKey(now - 86_400_000)) return `昨天 ${hhmm(t)}`
  return mdhm(t)
}

/** 2026-10-29 → 10月29日 */
export function dayTitle(date: string): string {
  const [, mo, d] = date.split('-').map(Number)
  return `${mo}月${d}日`
}

/** 2026-10-29 → 周四 */
export function weekdayOf(date: string): string {
  const [y, mo, d] = date.split('-').map(Number)
  return WEEKDAY_ZH[local(fromLocal(y, mo, d)).wd]
}

export function dateStart(date: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  return fromLocal(y, mo, d)
}

export function shiftDate(date: string, days: number): string {
  return dayKey(dateStart(date) + days * 86_400_000)
}

/** 1,284 */
export function num(n: number): string {
  return n.toLocaleString('en-US')
}

export function sourceUnit(source: BackupSource): string {
  return source === 'im' ? '条' : source === 'mail' ? '封' : '场'
}

const TRIGGER: Record<Trigger | 'retry', string> = {
  scheduled: '定时',
  catchup: '补跑',
  close: '收尾',
  manual: '手动',
  late: '迟到重跑',
  startup: '启动补跑',
  retry: '重试',
}

export function triggerText(trigger: Trigger | 'retry'): string {
  return TRIGGER[trigger]
}

const HOUR_TRIGGER: Record<Trigger, string> = {
  ...TRIGGER,
  manual: '手动重跑',
}

/** 版本徽标文案（ui.md 第 4 节"版本徽标"） */
export function versionText(version: VersionMeta, level: Level): string {
  if (level === 'hour') {
    if (version.version === 1) return `${hhmm(version.createdAt)} 生成`
    return `v${version.version} · ${HOUR_TRIGGER[version.trigger]}`
  }
  if (level === 'day') return `v${version.version} · ${hhmm(version.createdAt)}`
  if (version.isFinal) return `v${version.version} · 最终版`
  return `v${version.version} · ${version.mode === 'incremental' ? '增量' : '全量'}`
}

const LOST_REASON: Record<LostReason, { im: string; mail: string }> = {
  backup_gap: { im: 'IM 备份失败，原消息已过 7 天保留期', mail: '邮件备份失败，已超过 3 个月保留期' },
  gone_at_backup: { im: '备份时原消息已不存在', mail: '备份时原邮件已不存在' },
  expired_unbacked: { im: 'IM 备份失败，原消息已过 7 天保留期', mail: '邮件超过 3 个月未备份' },
}

export function lostReasonText(reason: LostReason, rawType: RawType = 'im'): string {
  return LOST_REASON[reason][rawType === 'mail' ? 'mail' : 'im']
}

/** 今天 / 本周至今 / 本月至今 / 本年至今，或已结束周期的名字 */
export function periodTitle(level: Level, period: string, todayKey: string): string {
  const now = dateStart(todayKey)
  switch (level) {
    case 'hour':
      return `${pad2(Number(period.split('T')[1]))}:00`
    case 'day':
      return period === todayKey ? '今天' : dayTitle(period)
    case 'week':
      return period === periodKey('week', now) ? '本周至今' : `第 ${Number(period.split('-W')[1])} 周`
    case 'month': {
      if (period === periodKey('month', now)) return '本月至今'
      const [, mo] = period.split('-').map(Number)
      return `${mo} 月`
    }
    case 'year':
      return period === periodKey('year', now) ? '本年至今' : `${period} 年`
  }
}

/** 摘要卡头部的小字：日 / 周 · 10/26 – 10/29 / 月 · 10/1 – 10/29 */
export function levelLine(level: Level, rangeLabel: string): string {
  switch (level) {
    case 'day':
      return '日'
    case 'week':
      return `周 · ${rangeLabel}`
    case 'month':
      return `月 · ${rangeLabel}`
    case 'year':
      return `年 · ${rangeLabel}`
    case 'hour':
      return '小时'
  }
}

/** 摘要卡页脚（ui.md 5.1 的表） */
export function dayFooter(inputCount: number, stats?: { totalMsgs: number; relatedMsgs: number; hours: number }): string {
  if (stats) {
    return `${num(stats.totalMsgs)} 条消息 · 与我有关 ${num(stats.relatedMsgs)} 条 · ${stats.hours} 个小时摘要`
  }
  return `依据 ${inputCount} 个小时摘要`
}

export function upperFooter(inputCount: number, unit = '日结'): string {
  return `依据 ${inputCount} 份${unit}`
}

/** 10月26日 */
export function longDate(t: number): string {
  const l = local(t)
  return `${l.mo}月${l.d}日`
}

/** 回顾页标题：第 44 周 / 10 月 / 2026 年 / 10月29日 / 15:00 */
export function periodName(level: Level, period: string): string {
  switch (level) {
    case 'hour':
      return `${period.split('T')[1]?.slice(0, 2) ?? '00'}:00`
    case 'day':
      return dayTitle(period)
    case 'week':
      return `第 ${Number(period.split('-W')[1])} 周`
    case 'month':
      return `${Number(period.split('-')[1])} 月`
    case 'year':
      return `${period} 年`
  }
}

/** 回顾页标题后面的小字：10月26日 – 11月1日 */
export function periodRangeLabel(level: Level, period: string): string {
  if (level === 'day') return weekdayOf(period)
  if (level === 'hour') return `${longDate(dateStart(period.slice(0, 10)))} ${weekdayOf(period.slice(0, 10))}`
  const range = periodRange(level, period)
  return `${longDate(range.from)} – ${longDate(range.to - 1)}`
}

/** 周期前后切换（小时层级以天为单位） */
export function shiftPeriod(level: Level, period: string, delta: number): string {
  switch (level) {
    case 'hour':
      return shiftDate(period.slice(0, 10), delta)
    case 'day':
      return shiftDate(period, delta)
    case 'week':
      return periodKey('week', periodRange('week', period).from + delta * 7 * 86_400_000)
    case 'month': {
      const [y, mo] = period.split('-').map(Number)
      const next = fromLocal(y, mo + delta)
      return fmt(next, 'YYYY-MM')
    }
    case 'year':
      return String(Number(period) + delta)
  }
}

/** 1.24 GB */
export function bytes(n: number): string {
  const gb = 1024 ** 3
  const mb = 1024 ** 2
  const kb = 1024
  if (n >= 100 * mb) return `${(n / gb).toFixed(2)} GB`
  if (n >= mb) return `${Math.round(n / mb)} MB`
  if (n >= kb) return `${Math.round(n / kb)} KB`
  return `${n} B`
}

/** 38 秒 / 2 分 10 秒 */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
}

/** 运行记录的处理对象：小时键 2026-11-01T22 → 11/01 22:00，日期 → 11/01，月 → 10 月，备份来源 → 中文名 */
export function runTarget(target: string): string {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(target)) return `${md(dateStart(target.slice(0, 10)))} ${target.slice(11)}:00`
  if (/^\d{4}-\d{2}-\d{2}$/.test(target)) return md(dateStart(target))
  if (/^\d{4}-\d{2}$/.test(target)) return `${Number(target.slice(5))} 月`
  if (/^\d{4}$/.test(target)) return `${target} 年`
  const backup: Record<string, string> = { im: 'IM 消息', mail: '邮件', calendar: '日程' }
  return backup[target] ?? target
}

/** 逐条对比时把两段文本共同的开头切出来，只对比剩下的部分 */
export function commonPrefix(before: string, after: string): { prefix: string; before: string; after: string } {
  const max = Math.min(before.length, after.length)
  let index = 0
  while (index < max && before[index] === after[index]) index++
  // 只在标点或空格处切开，避免把词切一半
  let cut = 0
  for (let i = index; i > 0; i--) {
    if ('：:，,。；;／/ '.includes(before[i - 1])) {
      cut = i
      break
    }
  }
  return { prefix: before.slice(0, cut), before: before.slice(cut), after: after.slice(cut) }
}
