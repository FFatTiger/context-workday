// 备份运行（spec 第 9 节）：读水位之后的数据 → 去重写入 → 逐日核对 → 推进水位 → 写运行记录。
// 失败（含 SourceUnavailableError）记为失败，水位不动。
import type { BackupRun, BackupSource } from '../api-types.js'
import type { Ctx } from '../context.js'
import { getMeta, setMeta, tx } from '../db/db.js'
import type { Db } from '../db/db.js'
import { myEmailAddress, participatingSessions, isRelatedEvent, isRelatedMail } from '../participation.js'
import { getSettings } from '../settings.js'
import type { ImMessage, Mail, CalendarEvent } from '../source/types.js'
import { DAY_MS, HOUR_MS, TZ_OFFSET_MS, dayKey, fmt, hourKey, startOfDay } from '../time.js'

export type BackupTrigger = BackupRun['trigger']

export function watermarkKey(source: BackupSource): string {
  return `watermark_${source}`
}
export function getWatermark(db: Db, source: BackupSource): number | undefined {
  return getMeta<number>(db, watermarkKey(source))
}

export interface RunRow {
  id: number
  source: string
  trigger: string
  started_at: number
  ended_at: number | null
  result: string | null
  error: string | null
  added: number
  watermark_after: number | null
}

export const SELECT_RUN = 'SELECT id, source, trigger, started_at, ended_at, result, error, added, watermark_after FROM backup_runs'

export function toApiRun(row: RunRow): BackupRun {
  return {
    id: row.id,
    source: row.source as BackupSource,
    trigger: row.trigger as BackupRun['trigger'],
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: (row.result ?? 'running') as BackupRun['result'],
    error: row.error,
    added: row.added,
    note: row.error ?? '',
  }
}

/** API 返回用：部分成功时 note 写明哪几天核对不一致 */
export function toApiRunFull(db: Db, row: RunRow): BackupRun {
  const api = toApiRun(row)
  if (api.result === 'partial') {
    const days = db.prepare('SELECT day FROM backup_days WHERE run_id = ? AND local_count < client_count ORDER BY day').all(row.id) as Array<{ day: string }>
    api.note = `${days.map((d) => fmt(periodRangeOf(d.day).from, 'MM/DD')).join('、')} 核对不一致`
  } else if (api.result === 'success') {
    api.note = `新增 ${api.added} 条`
  }
  return api
}

export function getRun(db: Db, id: number): BackupRun | undefined {
  const row = db.prepare(`${SELECT_RUN} WHERE id = ?`).get(id) as unknown as RunRow | undefined
  return row ? toApiRunFull(db, row) : undefined
}

export function lastRun(db: Db, source: BackupSource): BackupRun | undefined {
  const row = db.prepare(`${SELECT_RUN} WHERE source = ? ORDER BY id DESC LIMIT 1`).get(source) as unknown as RunRow | undefined
  return row ? toApiRunFull(db, row) : undefined
}

/** 调度每小时调用（票 04）：最近一次失败或部分成功就需要重试 */
export function needsRetry(db: Db, source: BackupSource): boolean {
  const last = lastRun(db, source)
  return !!last && (last.result === 'failed' || last.result === 'partial' || last.result === 'running')
}

// 备份进度（内存计数）：状态接口显示“备份中 · 已读取 N 条”。只在运行中有意义，每次运行重置
const progressRead = new Map<BackupSource, number>()
export function backupProgress(source: BackupSource): number {
  return progressRead.get(source) ?? 0
}

function eachDay(from: number, to: number, fn: (dayStart: number) => void) {
  for (let t = startOfDay(from); t < to; t += DAY_MS) fn(t)
}

/** 库里存的 im 行 → 合同对象（mentions 是 JSON） */
function rowToIm(row: Record<string, unknown>): ImMessage {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    senderId: row.sender_id as string,
    senderName: row.sender_name as string,
    time: row.time as number,
    text: row.text as string,
    kind: row.kind as string,
    isSystem: row.is_system === 1,
    mentions: JSON.parse(row.mentions as string) as string[],
    mentionAll: row.mention_all === 1,
    replyToId: (row.reply_to_id as string | null) ?? null,
    directedToMe: row.directed_to_me === 1,
  }
}

export async function runBackup(ctx: Ctx, source: BackupSource, trigger: BackupTrigger): Promise<BackupRun> {
  const db = ctx.db
  const startedAt = ctx.clock.now()
  const now = () => ctx.clock.now()
  const retention = ctx.source.retentionDays[source]

  const runId = tx(db, () => {
    if (!getMeta(db, 'installed_at')) setMeta(db, 'installed_at', startedAt)
    const r = db.prepare('INSERT INTO backup_runs (source, trigger, started_at, result) VALUES (?, ?, ?, ?)').run(source, trigger, startedAt, 'running')
    return Number(r.lastInsertRowid)
  })
  progressRead.set(source, 0)

  const finish = (result: 'success' | 'partial' | 'failed', opts: { error?: string; added: number; watermark: number | null; note?: string }): BackupRun => {
    return tx(db, () => {
      db.prepare('UPDATE backup_runs SET ended_at = ?, result = ?, error = ?, added = ?, watermark_after = ? WHERE id = ?').run(now(), result, opts.error ?? null, opts.added, opts.watermark, runId)
      const row = db.prepare(`${SELECT_RUN} WHERE id = ?`).get(runId) as unknown as RunRow
      return toApiRun(row)
    })
  }

  try {
    const settings = getSettings(db)
    const prevWatermark = getWatermark(db, source)
    const me = await ctx.source.me()
    setMeta(db, 'me', me)
    const contacts = await ctx.source.contacts()
    const meEmail = myEmailAddress(me, contacts)

    // ── 1. 读水位之后、客户端仍保留的全部数据 ──
    // im/mail：从 max(水位, now-保留期) 起；calendar：客户端整个可见窗口（日程按 updatedAt 变更，老日程也可能改）
    let readFrom: number
    let readTo: number
    if (source === 'calendar') {
      readFrom = now() - retention * DAY_MS
      readTo = now() + 30 * DAY_MS
    } else {
      readFrom = Math.max(prevWatermark ?? now() - retention * DAY_MS, now() - retention * DAY_MS)
      readTo = now()
    }

    let added = 0
    if (source === 'im') {
      const [sessions, msgs] = await Promise.all([ctx.source.sessions(), ctx.source.messages({ from: readFrom, to: readTo })])
      progressRead.set(source, (progressRead.get(source) ?? 0) + msgs.length)
      const sessionTypes = new Map(sessions.map((s) => [s.id, s.type]))
      tx(db, () => {
        const upSession = db.prepare('INSERT INTO sessions (id, name, type) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
        for (const s of sessions) upSession.run(s.id, s.name, s.type)
        const upContact = db.prepare('INSERT INTO contacts (id, name, email) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
        for (const c of contacts) upContact.run(c.id, c.name, c.email ?? null)

        const ins = db.prepare(`INSERT INTO im_messages
          (id, session_id, sender_id, sender_name, time, text, kind, is_system, mentions, mention_all, reply_to_id, directed_to_me, related_to_me, backed_up_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING`)
        const touched = new Set<string>()
        for (const m of msgs) {
          const r = ins.run(m.id, m.sessionId, m.senderId, m.senderName, m.time, m.text, m.kind, m.isSystem ? 1 : 0, JSON.stringify(m.mentions), m.mentionAll ? 1 : 0, m.replyToId, m.directedToMe ? 1 : 0, now())
          added += Number(r.changes)
          touched.add(`${m.sessionId}|${hourKey(m.time)}`)
        }
        // 跨水位边界的小时：和本机已有消息一起，按"会话×小时"整体重判参与（ADR-0003）
        const flags = settings.participation
        for (const key of touched) {
          const [sessionId, hk] = key.split('|')
          const [d, h] = hk.split('T')
          const hourStart = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), Number(h)) - TZ_OFFSET_MS
          const rows = db.prepare('SELECT * FROM im_messages WHERE session_id = ? AND time >= ? AND time < ?').all(sessionId, hourStart, hourStart + HOUR_MS) as Array<Record<string, unknown>>
          const participated = participatingSessions(rows.map(rowToIm), me.id, sessionTypes, flags).has(sessionId)
          db.prepare('UPDATE im_messages SET related_to_me = ? WHERE session_id = ? AND time >= ? AND time < ?').run(participated ? 1 : 0, sessionId, hourStart, hourStart + HOUR_MS)
        }
      })
    } else if (source === 'mail') {
      const mails = await ctx.source.mails({ from: readFrom, to: readTo })
      progressRead.set(source, (progressRead.get(source) ?? 0) + mails.length)
      tx(db, () => {
        const ins = db.prepare(`INSERT INTO mails
          (id, subject, sender, recipients, cc, time, text, folder, related_to_me, backed_up_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
        for (const m of mails) {
          const related = meEmail !== null && isRelatedMail(m, meEmail, settings.participation)
          const r = ins.run(m.id, m.subject, JSON.stringify(m.from), JSON.stringify(m.to), JSON.stringify(m.cc), m.time, m.text, m.folder, related ? 1 : 0, now())
          added += Number(r.changes)
        }
      })
    } else {
      const events = await ctx.source.events({ from: readFrom, to: readTo })
      progressRead.set(source, (progressRead.get(source) ?? 0) + events.length)
      tx(db, () => {
        // 日程按 updatedAt 有变化就更新
        const ins = db.prepare(`INSERT INTO events
          (id, title, start, end, all_day, organizer, attendees, location, notes, updated_at, related_to_me, backed_up_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, start=excluded.start, end=excluded.end, all_day=excluded.all_day,
            organizer=excluded.organizer, attendees=excluded.attendees, location=excluded.location, notes=excluded.notes,
            updated_at=excluded.updated_at, related_to_me=excluded.related_to_me, backed_up_at=excluded.backed_up_at
          WHERE excluded.updated_at > updated_at`)
        for (const e of events) {
          const related = isRelatedEvent(e, me.id, settings.participation)
          const r = ins.run(e.id, e.title, e.start, e.end, e.allDay ? 1 : 0, JSON.stringify(e.organizer), JSON.stringify(e.attendees), e.location, e.notes, e.updatedAt, related ? 1 : 0, now())
          added += Number(r.changes)
        }
      })
    }

    // ── 2. 逐日核对：对涉及的每一天比较客户端条数和本机条数（客户端按天重查） ──
    const verifyFrom = readFrom
    const dayRows: Array<{ day: string; client: number; local: number }> = []
    const dayStarts: number[] = []
    eachDay(verifyFrom, now(), (dayStart) => dayStarts.push(dayStart))
    for (const dayStart of dayStarts) {
      const dayEnd = Math.min(dayStart + DAY_MS, now())
      const range = { from: dayStart, to: dayEnd }
      let client = 0
      if (source === 'im') client = (await ctx.source.messages(range)).length
      else if (source === 'mail') client = (await ctx.source.mails(range)).length
      else client = (await ctx.source.events(range)).length
      progressRead.set(source, (progressRead.get(source) ?? 0) + client)
      const local = countLocal(db, source, dayStart, dayEnd)
      dayRows.push({ day: dayKey(dayStart), client, local })
    }

    const mismatches = dayRows.filter((d) => d.local < d.client)
    const result: 'success' | 'partial' = mismatches.length > 0 ? 'partial' : 'success'
    const newWatermark = result === 'success' ? readTo : periodDayStart(mismatches[0].day)

    return tx(db, () => {
      const upDay = db.prepare(`INSERT INTO backup_days (source, day, client_count, local_count, run_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(source, day) DO UPDATE SET client_count=excluded.client_count, local_count=excluded.local_count, run_id=excluded.run_id`)
      for (const d of dayRows) upDay.run(source, d.day, d.client, d.local, runId)
      setMeta(db, watermarkKey(source), newWatermark)
      db.prepare('UPDATE backup_runs SET ended_at = ?, result = ?, error = NULL, added = ?, watermark_after = ? WHERE id = ?').run(now(), result, added, newWatermark, runId)
      const row = db.prepare(`${SELECT_RUN} WHERE id = ?`).get(runId) as unknown as RunRow
      return toApiRunFull(db, row)
    })
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    ctx.log(`备份失败 [${source}]：${message}`)
    return finish('failed', { error: message, added: 0, watermark: prevWatermarkOf(db, source) })
  }
}

function prevWatermarkOf(db: Db, source: BackupSource): number | null {
  return getWatermark(db, source) ?? null
}

function countLocal(db: Db, source: BackupSource, from: number, to: number): number {
  const table = source === 'im' ? 'im_messages' : source === 'mail' ? 'mails' : 'events'
  const col = source === 'calendar' ? 'start' : 'time'
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} >= ? AND ${col} < ?`).get(from, to) as { n: number }
  return row.n
}

/** YYYY-MM-DD → 当天 0 点 */
function periodDayStart(day: string): number {
  const { from } = periodRangeOf(day)
  return from
}
function periodRangeOf(day: string): { from: number; to: number } {
  const [y, mo, d] = day.split('-').map(Number)
  const from = Date.UTC(y, mo - 1, d) - 8 * HOUR_MS
  return { from, to: from + DAY_MS }
}
