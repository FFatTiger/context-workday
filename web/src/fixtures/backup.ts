// 备份页假数据：三个来源状态、覆盖条、受影响的摘要、备份记录、存储。
// 内容照 docs/design/prototype/index.html（IM 55 天、10/12–10/14 缺口、1.24 GB）。
import type {
  AffectedResponse,
  BackupRun,
  BackupSource,
  BackupSourceStatus,
  CoverageResponse,
  CoverageState,
  Page,
  ScheduleRule,
  StorageResponse,
} from '../../../src/api-types'
import { fmt, fromLocal } from '../../../src/time'
import { currentScenario } from './scenario'

const DAY_MS = 86_400_000

function daysBefore(count: number): string[] {
  const end = fromLocal(2026, 10, 29)
  return Array.from({ length: count }, (_, index) => fmt(end - (count - 1 - index) * DAY_MS, 'YYYY-MM-DD'))
}

const EXPIRED_GAP = ['2026-10-12', '2026-10-13', '2026-10-14']

const RULES: Record<BackupSource, ScheduleRule> = {
  im: { type: 'daily', hour: 2, minute: 0 },
  mail: { type: 'weekly', weekday: 7, hour: 3, minute: 0 },
  calendar: { type: 'daily', hour: 2, minute: 0 },
}

export function fixtureBackupStatus(): BackupSourceStatus[] {
  const scenario = currentScenario()
  const base: Record<BackupSource, BackupSourceStatus> = {
    im: {
      source: 'im',
      state: 'ok',
      total: 55,
      retentionDays: 7,
      rule: { type: 'daily', hour: 2, minute: 0 },
      lastRun: { at: fromLocal(2026, 10, 29, 2, 0), result: 'success', added: 1284 },
      nextRunAt: fromLocal(2026, 10, 30, 2, 0),
      watermark: fromLocal(2026, 10, 29, 2, 0),
    },
    mail: {
      source: 'mail',
      state: 'ok',
      total: 412,
      retentionDays: 90,
      rule: { type: 'weekly', weekday: 7, hour: 3, minute: 0 },
      lastRun: { at: fromLocal(2026, 10, 25, 3, 0), result: 'success', added: 12 },
      nextRunAt: fromLocal(2026, 11, 1, 3, 0),
      watermark: fromLocal(2026, 10, 25, 3, 0),
    },
    calendar: {
      source: 'calendar',
      state: 'ok',
      total: 138,
      retentionDays: 0,
      rule: { type: 'daily', hour: 2, minute: 0 },
      lastRun: { at: fromLocal(2026, 10, 29, 2, 0), result: 'success', added: 6 },
      nextRunAt: fromLocal(2026, 10, 30, 2, 0),
      watermark: fromLocal(2026, 10, 29, 2, 0),
    },
  }
  const order: BackupSource[] = ['im', 'mail', 'calendar']
  if (scenario === 'empty') {
    return order.map((source) => ({
      ...base[source],
      state: 'never',
      total: 0,
      lastRun: undefined,
    }))
  }
  if (scenario === 'generating') {
    return order.map((source) =>
      source === 'im'
        ? {
            ...base[source],
            state: 'running',
            lastRun: { at: fromLocal(2026, 10, 29, 2, 0), result: 'success', added: 1284 },
            progress: { read: 1024 },
          }
        : base[source],
    )
  }
  return order.map((source) => base[source])
}

export function fixtureCoverage(source: BackupSource, days: number): CoverageResponse {
  const scenario = currentScenario()
  const list = daysBefore(days)
  const states = new Map<string, CoverageState>()
  if (scenario === 'empty') {
    for (const day of list) states.set(day, 'no_data')
  } else {
    for (const day of list) states.set(day, 'ok')
    if (source === 'im') {
      for (const day of EXPIRED_GAP) if (states.has(day)) states.set(day, 'gap_expired')
      if (scenario === 'generating') {
        for (const day of list.slice(-2)) states.set(day, 'gap_recoverable')
      }
    }
  }

  const daysOut = list.map((day, index) => {
    const state = states.get(day) ?? 'no_data'
    const seed = 900 + index * 7
    if (state === 'ok') return { day, state, clientCount: seed + 84, localCount: seed + 84 }
    if (state === 'gap_expired' || state === 'gap_recoverable') {
      return { day, state, clientCount: undefined, localCount: 0 }
    }
    return { day, state }
  })

  return {
    source,
    days: daysOut,
    unbackedInWindow: daysOut.slice(-7).filter((day) => day.state === 'gap_recoverable').length,
    degradedItems: source === 'im' && scenario !== 'empty' ? AFFECTED.length : 0,
    rule: RULES[source],
  }
}

const AFFECTED_TEXTS = [
  '与供应商确认切换前置检查清单',
  '数据中台周会：预算按季度重新排',
  '跟进智能客服灰度指标',
  '回滚演练脚本第一版评审',
  '与陈工对齐值班表',
  '整理迁移风险清单',
]

const AFFECTED: AffectedResponse['items'] = EXPIRED_GAP.flatMap((day) =>
  [9, 10, 11, 14, 15, 16].map((hour, index) => ({
    ref: { level: 'hour' as const, period: `${day}T${String(hour).padStart(2, '0')}`, version: 1, itemId: 1 },
    text: AFFECTED_TEXTS[index],
    reason: 'backup_gap' as const,
    usedBy: [
      {
        ref: { level: 'week' as const, period: '2026-W42', version: 1, itemId: index + 1 },
        text: `第 42 周：${AFFECTED_TEXTS[index]}`,
      },
    ],
  })),
)

export function fixtureAffected(): AffectedResponse {
  if (currentScenario() === 'empty') return { items: [] }
  return { items: AFFECTED }
}

const RUN_ROWS: BackupRun[] = [
  {
    id: 12,
    source: 'im',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 29, 2, 0),
    endedAt: fromLocal(2026, 10, 29, 2, 0) + 38_000,
    result: 'success',
    error: null,
    added: 1284,
    note: '',
  },
  {
    id: 13,
    source: 'calendar',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 29, 2, 1),
    endedAt: fromLocal(2026, 10, 29, 2, 1) + 4_000,
    result: 'success',
    error: null,
    added: 3,
    note: '',
  },
  {
    id: 11,
    source: 'im',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 28, 2, 0),
    endedAt: fromLocal(2026, 10, 28, 2, 0) + 35_000,
    result: 'success',
    error: null,
    added: 1102,
    note: '',
  },
  {
    id: 10,
    source: 'mail',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 25, 3, 0),
    endedAt: fromLocal(2026, 10, 25, 3, 0) + 130_000,
    result: 'success',
    error: null,
    added: 46,
    note: '',
  },
  {
    id: 9,
    source: 'im',
    trigger: 'retry',
    startedAt: fromLocal(2026, 10, 15, 3, 0),
    endedAt: fromLocal(2026, 10, 15, 3, 0) + 21_000,
    result: 'partial',
    error: null,
    added: 842,
    note: '10/27、10/28 核对不一致',
  },
  {
    id: 8,
    source: 'im',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 15, 2, 0),
    endedAt: fromLocal(2026, 10, 15, 2, 0) + 9_000,
    result: 'failed',
    error: '客户端接口超时',
    added: 0,
    note: '',
  },
  {
    id: 7,
    source: 'mail',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 18, 3, 0),
    endedAt: fromLocal(2026, 10, 18, 3, 0) + 96_000,
    result: 'success',
    error: null,
    added: 38,
    note: '',
  },
  {
    id: 6,
    source: 'calendar',
    trigger: 'manual',
    startedAt: fromLocal(2026, 10, 16, 9, 30),
    endedAt: fromLocal(2026, 10, 16, 9, 30) + 5_000,
    result: 'success',
    error: null,
    added: 12,
    note: '',
  },
  {
    id: 5,
    source: 'im',
    trigger: 'scheduled',
    startedAt: fromLocal(2026, 10, 14, 2, 0),
    endedAt: fromLocal(2026, 10, 14, 2, 0) + 11_000,
    result: 'failed',
    error: '客户端接口超时',
    added: 0,
    note: '',
  },
]

const PAGE_SIZE = 5

export function fixtureBackupRuns(query: { source?: string; result?: string; page?: number }): Page<BackupRun> {
  if (currentScenario() === 'empty') return { items: [], total: 0, page: 1, pageSize: PAGE_SIZE }
  const filtered = RUN_ROWS.filter(
    (run) => (!query.source || run.source === query.source) && (!query.result || run.result === query.result),
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

export function fixtureStorage(): StorageResponse {
  if (currentScenario() === 'empty') {
    return { totalBytes: 0, rawBytes: 0, summaryBytes: 0, integrity: null }
  }
  return {
    totalBytes: 1_331_439_861,
    rawBytes: 1_159_641_169,
    summaryBytes: 171_798_692,
    integrity: { at: fromLocal(2026, 10, 29, 2, 5), ok: true, note: '通过' },
  }
}

export function fixtureRunBackup(): { started: boolean } {
  return { started: true }
}
