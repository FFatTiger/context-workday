// 覆盖状态与告警（spec 第 9 节）：逐日 ok / gap_recoverable / gap_expired / no_data / pending。
// pending（票 11）：某一天在“该天结束后的第一次备份计划时间”之前不判缺口——
// 那次备份才会把整天核对完；核对记录只覆盖了当天一部分时，也只算等待备份。
// degradedItems 由证据链模块按便宜规则统计（不调客户端）。
import type { CoverageResponse, CoverageState, BackupSource, RawType } from '../api-types.js'
import type { Ctx } from '../context.js'
import { getMeta } from '../db/db.js'
import type { Db } from '../db/db.js'
import { getJobRule, nextRun } from '../jobs/rules.js'
import { degradedItemCount } from '../summary/evidence.js'
import { DAY_MS, dayKey, startOfDay } from '../time.js'

interface DayRow {
  day: string
  client_count: number
  local_count: number
  /** 写下这条核对记录的运行开始时间：晚于当天结束时才算覆盖了整天 */
  run_at: number
}

function dayRow(db: Db, source: BackupSource, day: string): DayRow | undefined {
  return db
    .prepare('SELECT bd.day, bd.client_count, bd.local_count, br.started_at AS run_at FROM backup_days bd JOIN backup_runs br ON br.id = bd.run_id WHERE bd.source = ? AND bd.day = ?')
    .get(source, day) as DayRow | undefined
}

/** 某一天的数据是否还能从客户端补回来（整天都还在保留期内才算过期） */
function stillRecoverable(dayStart: number, now: number, retentionDays: number): boolean {
  return dayStart + DAY_MS > now - retentionDays * DAY_MS
}

const RAW_TYPE_OF: Record<BackupSource, RawType> = { im: 'im', mail: 'mail', calendar: 'event' }
const JOB_OF_SOURCE: Record<BackupSource, 'backup_im' | 'backup_calendar' | 'backup_mail'> = { im: 'backup_im', calendar: 'backup_calendar', mail: 'backup_mail' }

/** 某天的“该天结束后的第一次备份计划时间”：在此之前不判缺口（票 11 规则） */
function firstRunAfterDayEnd(db: Db, source: BackupSource, dayStart: number): number {
  return nextRun(getJobRule(db, JOB_OF_SOURCE[source]), dayStart + DAY_MS - 1)
}

export function dayState(db: Db, source: BackupSource, dayStart: number, now: number, retentionDays: number, installedAt: number | undefined, pendingBefore: number): { state: CoverageState; row?: DayRow } {
  const row = dayRow(db, source, dayKey(dayStart))
  const coversFullDay = row !== undefined && row.run_at >= dayStart + DAY_MS
  // 核对一致且覆盖了整天（或就是今天：今天只能核对一部分，一致就算 ok）→ ok
  if (row && row.local_count >= row.client_count && (coversFullDay || dayStart === startOfDay(now))) return { state: 'ok', row }
  // 没有核对记录：安装之前（或从未安装）一律算无数据
  if (!row && (installedAt === undefined || dayStart < startOfDay(installedAt))) return { state: 'no_data' }
  // 核对出过不一致：真缺口，不等计划时间
  if (row && row.local_count < row.client_count) return { state: stillRecoverable(dayStart, now, retentionDays) ? 'gap_recoverable' : 'gap_expired', row }
  // 还没到该天的备份计划时间：等待备份，不判缺口
  if (now < pendingBefore) return { state: 'pending', row }
  return { state: stillRecoverable(dayStart, now, retentionDays) ? 'gap_recoverable' : 'gap_expired', row }
}

export function coverage(ctx: Ctx, source: BackupSource, days: number): CoverageResponse {
  const db = ctx.db
  const now = ctx.clock.now()
  const retentionDays = ctx.source.retentionDays[source]
  const installedAt = getMeta<number>(db, 'installed_at')
  const out: CoverageResponse = { source, days: [], unbackedInWindow: 0, degradedItems: 0, rule: getJobRule(db, JOB_OF_SOURCE[source]) }
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = startOfDay(now) - i * DAY_MS
    const { state, row } = dayState(db, source, dayStart, now, retentionDays, installedAt, firstRunAfterDayEnd(db, source, dayStart))
    out.days.push({ day: dayKey(dayStart), state, clientCount: row?.client_count, localCount: row?.local_count })
    if (state === 'gap_recoverable') out.unbackedInWindow++
  }
  out.degradedItems = degradedItemCount(ctx, RAW_TYPE_OF[source])
  return out
}

/** 告警：IM 有可补救缺口就告；邮件剩余 ≤ 14 天才告。日程不告警。 */
export function alerts(ctx: Ctx): Array<{ source: 'im' | 'mail'; daysLeft: number }> {
  const db = ctx.db
  const now = ctx.clock.now()
  const installedAt = getMeta<number>(db, 'installed_at')
  const out: Array<{ source: 'im' | 'mail'; daysLeft: number }> = []
  for (const source of ['im', 'mail'] as const) {
    const retentionDays = ctx.source.retentionDays[source]
    // 找最早的可补救缺口
    let earliest: number | null = null
    for (let i = retentionDays - 1; i >= 0; i--) {
      const dayStart = startOfDay(now) - i * DAY_MS
      if (dayState(db, source, dayStart, now, retentionDays, installedAt, firstRunAfterDayEnd(db, source, dayStart)).state === 'gap_recoverable') {
        earliest = dayStart
        break
      }
    }
    if (earliest === null) continue
    // 该天距离超过保留期（D + retention 天）就是不可补救，daysLeft = 距离该时点还剩的天数（向上取整）
    const deadline = earliest + retentionDays * DAY_MS
    const daysLeft = Math.max(1, Math.ceil((deadline - now) / DAY_MS))
    if (source === 'im' || daysLeft <= 14) out.push({ source, daysLeft })
  }
  return out
}
