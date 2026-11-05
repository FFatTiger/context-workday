// 设置（spec 第 11 节）：读 meta 'settings'，默认全开；保存入口在票 05。
import type { Settings } from './api-types.js'
import type { Db } from './db/db.js'
import { getMeta, setMeta } from './db/db.js'

export const DEFAULT_SETTINGS: Settings = {
  participation: {
    speak: true,
    mention: true,
    reply: true,
    private: true,
    directed: true,
    events: true,
    sentMail: true,
    toMail: true,
  },
  redact: false,
}

/** 每次运行开始时读取；只影响之后的生成（spec 第 1 节） */
export function getSettings(db: Db): Settings {
  const stored = getMeta<Partial<Settings>>(db, 'settings')
  if (!stored) return structuredClone(DEFAULT_SETTINGS)
  return {
    participation: { ...DEFAULT_SETTINGS.participation, ...stored.participation },
    redact: stored.redact ?? false,
  }
}

const FLAGS = Object.keys(DEFAULT_SETTINGS.participation) as Array<keyof Settings['participation']>

/** 保存口径开关和演示脱敏开关（api-types 20）。只收布尔值，别的类型直接拒绝 */
export function saveSettings(db: Db, input: unknown): Settings {
  if (typeof input !== 'object' || input === null) throw new Error('设置格式不对')
  const raw = input as { participation?: unknown; redact?: unknown }
  const current = getSettings(db)
  const next: Settings = { participation: { ...current.participation }, redact: current.redact }
  if (raw.participation !== undefined) {
    if (typeof raw.participation !== 'object' || raw.participation === null) throw new Error('participation 应是 8 个开关的对象')
    const p = raw.participation as Record<string, unknown>
    for (const key of FLAGS) {
      if (p[key] !== undefined) {
        if (typeof p[key] !== 'boolean') throw new Error(`开关 ${key} 应是布尔值`)
        next.participation[key] = p[key]
      }
    }
  }
  if (raw.redact !== undefined) {
    if (typeof raw.redact !== 'boolean') throw new Error('redact 应是布尔值')
    next.redact = raw.redact
  }
  setMeta(db, 'settings', next)
  return next
}
