// 时间与周期。所有周期按 Asia/Shanghai 划分。
// ponytail: 固定 UTC+8（中国无夏令时）；要支持其他时区再换成 Intl 计算。

export const TZ_OFFSET_MS = 8 * 3600_000
export const HOUR_MS = 3600_000
export const DAY_MS = 24 * HOUR_MS

export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** 可拨动的时钟：测试和 sim 用 */
export class ManualClock implements Clock {
  constructor(private t: number) {}
  now() {
    return this.t
  }
  set(t: number) {
    this.t = t
  }
  advance(ms: number) {
    this.t += ms
  }
}

export type Level = 'hour' | 'day' | 'week' | 'month' | 'year'

/** 上海本地时间的各个字段 */
export function local(t: number) {
  const d = new Date(t + TZ_OFFSET_MS)
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    /** 1=周一 … 7=周日 */
    wd: d.getUTCDay() || 7,
  }
}

/** 上海本地时间 → epoch ms */
export function fromLocal(y: number, mo: number, d = 1, h = 0, mi = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi) - TZ_OFFSET_MS
}

const pad = (n: number) => String(n).padStart(2, '0')

export { pad }

export function dayKey(t: number): string {
  const l = local(t)
  return `${l.y}-${pad(l.mo)}-${pad(l.d)}`
}

export function hourKey(t: number): string {
  return `${dayKey(t)}T${pad(local(t).h)}`
}

export function monthKey(t: number): string {
  const l = local(t)
  return `${l.y}-${pad(l.mo)}`
}

export function yearKey(t: number): string {
  return String(local(t).y)
}

/** ISO 周：周一开始，周四所在的年份即周年 */
export function weekKey(t: number): string {
  const start = startOfDay(t) - (local(t).wd - 1) * DAY_MS
  const thursday = start + 3 * DAY_MS
  const y = local(thursday).y
  const jan4 = fromLocal(y, 1, 4)
  const week1 = startOfDay(jan4) - (local(jan4).wd - 1) * DAY_MS
  return `${y}-W${pad(Math.round((start - week1) / (7 * DAY_MS)) + 1)}`
}

export function periodKey(level: Level, t: number): string {
  switch (level) {
    case 'hour':
      return hourKey(t)
    case 'day':
      return dayKey(t)
    case 'week':
      return weekKey(t)
    case 'month':
      return monthKey(t)
    case 'year':
      return yearKey(t)
  }
}

export function startOfHour(t: number): number {
  return Math.floor(t / HOUR_MS) * HOUR_MS
}

export function startOfDay(t: number): number {
  return Math.floor((t + TZ_OFFSET_MS) / DAY_MS) * DAY_MS - TZ_OFFSET_MS
}

/** 周期键 → [起, 止) */
export function periodRange(level: Level, key: string): { from: number; to: number } {
  switch (level) {
    case 'hour': {
      const [d, h] = key.split('T')
      const from = periodRange('day', d).from + Number(h) * HOUR_MS
      return { from, to: from + HOUR_MS }
    }
    case 'day': {
      const [y, mo, d] = key.split('-').map(Number)
      const from = fromLocal(y, mo, d)
      return { from, to: from + DAY_MS }
    }
    case 'week': {
      const [y, w] = key.split('-W').map(Number)
      const jan4 = fromLocal(y, 1, 4)
      const from = startOfDay(jan4) - (local(jan4).wd - 1) * DAY_MS + (w - 1) * 7 * DAY_MS
      return { from, to: from + 7 * DAY_MS }
    }
    case 'month': {
      const [y, mo] = key.split('-').map(Number)
      return { from: fromLocal(y, mo), to: mo === 12 ? fromLocal(y + 1, 1) : fromLocal(y, mo + 1) }
    }
    case 'year': {
      const y = Number(key)
      return { from: fromLocal(y, 1), to: fromLocal(y + 1, 1) }
    }
  }
}

/** 上海本地时间格式化，例如 fmt(t, 'MM/DD HH:mm') */
export function fmt(t: number, pattern: string): string {
  const l = local(t)
  return pattern
    .replace('YYYY', String(l.y))
    .replace('MM', pad(l.mo))
    .replace('DD', pad(l.d))
    .replace('HH', pad(l.h))
    .replace('mm', pad(l.mi))
}

export const WEEKDAY_ZH = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']
