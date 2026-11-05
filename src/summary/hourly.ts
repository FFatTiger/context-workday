// 小时摘要流水线（spec 第 3 节，逐步照做）：
// 读客户端 → 口径筛选 + 降噪 + 附上下文 → 无与我有关原文则跳过 → 摘要器（上限 3，格式错带 feedback 重试一次）
// → 校验引用（只留本小时可引用原文，无引用条目丢弃；超上限重试一次，仍超保留前 3）→ saveVersion。
// 本函数自己写 task_runs 记录（job='hourly'），票 04 的调度直接调用它。
import type { Ctx } from '../context.js'
import { tx } from '../db/db.js'
import type { DraftItem, HourlyInput, SourceLine } from '../llm/types.js'
import { SummarizerFormatError } from '../llm/types.js'
import { denoise, isRelatedEvent, isRelatedMail, myEmailAddress, participatingSessions } from '../participation.js'
import { getSettings } from '../settings.js'
import type { CalendarEvent, ImMessage, Mail } from '../source/types.js'
import { DAY_MS, HOUR_MS, fmt, hourKey, periodRange, startOfHour } from '../time.js'
import { beginGeneration, failGeneration, releaseGeneration, saveVersion } from './store.js'

export type HourlyTrigger = 'scheduled' | 'catchup' | 'manual' | 'late' | 'startup'

/** 小时摘要条目上限（spec 第 3 节：最多 3 个条目） */
export const MAX_HOURLY_ITEMS = 3

/** 只追 7 天：客户端 IM 原文只保留 7 天（spec 第 3 节） */
export const HOURLY_LOOKBACK_DAYS = 7

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

/** 待处理小时：过去 7 天内已结束、还没有 success/skipped 记录的小时，按时间升序 */
export function pendingHours(ctx: Ctx): string[] {
  const now = ctx.clock.now()
  const from = startOfHour(now - HOURLY_LOOKBACK_DAYS * DAY_MS)
  const to = startOfHour(now) // 当前小时未结束，不处理
  const done = new Set(
    (ctx.db.prepare("SELECT DISTINCT target FROM task_runs WHERE job = 'hourly' AND result IN ('success','skipped')").all() as Array<{ target: string }>).map((r) => r.target),
  )
  const out: string[] = []
  for (let t = from; t < to; t += HOUR_MS) {
    const key = hourKey(t)
    if (!done.has(key)) out.push(key)
  }
  return out
}

function imLine(ref: string, m: ImMessage, where: string, contextOnly: boolean): SourceLine {
  return { ref, type: 'im', time: m.time, where, who: m.senderName, text: m.text, contextOnly }
}

function eventLine(ref: string, e: CalendarEvent): SourceLine {
  const detail = [e.location && `地点 ${e.location}`, e.notes && `备注 ${e.notes}`].filter(Boolean).join('，')
  return { ref, type: 'event', time: e.start, where: e.title, who: e.organizer.name, text: detail || e.title, contextOnly: false }
}

function mailLine(ref: string, m: Mail, mine: boolean): SourceLine {
  const to = m.to.map((a) => a.name || a.address).join('、') || '（无收件人）'
  const who = mine ? `我 → ${to}` : `${m.from.name || m.from.address} → 我`
  return { ref, type: 'mail', time: m.time, where: m.subject, who, text: m.text, contextOnly: false }
}

export interface HourGather {
  /** 送给模型的输入（含上下文行） */
  input: HourlyInput
  /** 可引用 ref → 原文 */
  refRaw: Map<string, { type: 'im' | 'mail' | 'event'; rawId: string }>
  totalMsgs: number
  /** 与我有关的原文数（参与会话降噪后的消息 + 日程 + 邮件） */
  relatedCount: number
}

/**
 * 读取并筛出一个小时的输入（口径 + 降噪 + 上下文）。runHour 和日结的迟到核对共用，
 * 保证“重新数与我有关的原文”和生成时完全同一套口径。
 */
export async function gatherHourInput(ctx: Ctx, key: string): Promise<HourGather> {
  const db = ctx.db
  const { from, to } = periodRange('hour', key)
  const settings = getSettings(db)
  const [me, contacts, sessions, msgs, events, mails, beforeHour] = await Promise.all([
    ctx.source.me(),
    ctx.source.contacts(),
    ctx.source.sessions(),
    ctx.source.messages({ from, to }),
    ctx.source.events({ from, to }),
    ctx.source.mails({ from, to }),
    // 每个参与会话“本小时之前最近 10 条”的取数窗口：往前 24 小时足够覆盖，客户端只回窗口内的
    ctx.source.messages({ from: from - 24 * HOUR_MS, to: from }),
  ])
  const meEmail = myEmailAddress(me, contacts)
  const flags = settings.participation
  const sessionTypes = new Map(sessions.map((s) => [s.id, s.type]))
  const sessionNames = new Map(sessions.map((s) => [s.id, s.name]))
  const partSessions = participatingSessions(msgs, me.id, sessionTypes, flags)

  const lines: SourceLine[] = []
  const refRaw = new Map<string, { type: 'im' | 'mail' | 'event'; rawId: string }>()
  let imN = 0
  let evN = 0
  let mailN = 0
  let ctxN = 0
  for (const sessionId of partSessions) {
    const where = sessionNames.get(sessionId) ?? sessionId
    for (const m of beforeHour.filter((m) => m.sessionId === sessionId && !m.isSystem).slice(-10)) {
      lines.push(imLine(`x${++ctxN}`, m, where, true))
    }
    for (const m of denoise(msgs.filter((m) => m.sessionId === sessionId))) {
      const ref = `m${++imN}`
      lines.push(imLine(ref, m, where, false))
      refRaw.set(ref, { type: 'im', rawId: m.id })
    }
  }
  for (const e of events.filter((e) => isRelatedEvent(e, me.id, flags))) {
    const ref = `e${++evN}`
    lines.push(eventLine(ref, e))
    refRaw.set(ref, { type: 'event', rawId: e.id })
  }
  const relatedMails: Array<{ m: Mail; mine: boolean }> = []
  if (meEmail !== null) {
    for (const m of mails) {
      if (isRelatedMail(m, meEmail, flags)) relatedMails.push({ m, mine: m.from.address === meEmail })
    }
  }
  for (const { m, mine } of relatedMails) {
    const ref = `c${++mailN}`
    lines.push(mailLine(ref, m, mine))
    refRaw.set(ref, { type: 'mail', rawId: m.id })
  }

  return {
    input: {
      label: `${fmt(from, 'YYYY-MM-DD HH:mm')}–${fmt(to, 'HH:mm')}`,
      me: me.name,
      lines,
      maxItems: MAX_HOURLY_ITEMS,
    },
    refRaw,
    totalMsgs: msgs.length,
    relatedCount: lines.filter((l) => !l.contextOnly).length,
  }
}

export interface RunHourResult {
  result: 'success' | 'skipped' | 'failed'
  version?: number
  note: string
}

/** 处理一个小时。手动重新生成 = runHour(ctx, key, 'manual')。 */
export async function runHour(ctx: Ctx, key: string, trigger: HourlyTrigger): Promise<RunHourResult> {
  const db = ctx.db
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key)) return { result: 'failed', note: `小时周期键不合法：${key}` }
  const { from, to } = periodRange('hour', key)

  const runTrigger = trigger === 'manual' ? 'manual' : trigger === 'startup' ? 'startup' : 'scheduled'
  const runId = tx(db, () => {
    const r = db.prepare('INSERT INTO task_runs (job, target, scheduled_at, started_at, result, trigger) VALUES (?,?,?,?,?,?)').run('hourly', key, null, ctx.clock.now(), 'running', runTrigger)
    return Number(r.lastInsertRowid)
  })
  const finishRun = (result: 'success' | 'skipped' | 'failed', note: string, outputs: Array<{ level: 'hour'; period: string; version: number }> = []) => {
    tx(db, () => {
      db.prepare('UPDATE task_runs SET ended_at = ?, result = ?, note = ?, outputs = ? WHERE id = ?').run(ctx.clock.now(), result, note, JSON.stringify(outputs), runId)
    })
  }

  try {
    if (to > ctx.clock.now()) throw new Error('该小时还没有结束')
    const series = beginGeneration(db, 'hour', key)
    try {
      const { input, refRaw, totalMsgs, relatedCount } = await gatherHourInput(ctx, key)

      if (relatedCount === 0) {
        releaseGeneration(db, series.id)
        finishRun('skipped', '没有与我有关的原文')
        return { result: 'skipped', note: '没有与我有关的原文' }
      }

      // 调摘要器；输出格式不对带 feedback 重试一次（spec 14）
      let drafts: DraftItem[] = []
      let feedback: string | undefined
      for (let attempt = 0; ; attempt++) {
        try {
          drafts = await ctx.summarizer.hourly(input, feedback)
          break
        } catch (e) {
          if (e instanceof SummarizerFormatError && attempt === 0) {
            feedback = e.message
            continue
          }
          throw e
        }
      }

      // 校验引用：只保留指向本小时可引用原文（上下文消息和不存在的编号都去掉）；去掉后没有引用的条目丢弃
      const validate = (ds: DraftItem[]) =>
        ds
          .map((d) => ({ text: d.text.trim(), refs: [...new Set(d.refs)].filter((r) => refRaw.has(r)) }))
          .filter((d) => d.refs.length > 0)
      let items = validate(drafts)
      if (items.length === 0) throw new Error('模型输出没有引用本小时原文的有效条目')

      // 条目超上限：带着提示重试一次；仍然超出按顺序保留前 3（spec 3 第 6 步）
      if (items.length > MAX_HOURLY_ITEMS) {
        try {
          const retry = validate(await ctx.summarizer.hourly(input, `条目数 ${items.length} 超过上限，请最多输出 ${MAX_HOURLY_ITEMS} 条`))
          if (retry.length > 0) items = retry
        } catch {
          // 重试失败就用第一次的结果截断
        }
        if (items.length > MAX_HOURLY_ITEMS) items = items.slice(0, MAX_HOURLY_ITEMS)
      }

      const version = saveVersion(db, {
        level: 'hour',
        period: key,
        createdAt: ctx.clock.now(),
        trigger,
        mode: 'full',
        model: ctx.summarizer.model,
        inputs: [],
        totalMsgs,
        relatedMsgs: relatedCount,
        items: items.map((it) => ({
          text: it.text,
          op: 'add' as const,
          refs: it.refs.map((r) => {
            const t = refRaw.get(r)!
            return { type: t.type, rawId: t.rawId }
          }),
        })),
      })
      finishRun('success', `小时摘要 v${version}（${items.length} 条）`, [{ level: 'hour', period: key, version }])
      return { result: 'success', version, note: `小时摘要 v${version}（${items.length} 条）` }
    } catch (e) {
      failGeneration(db, series.id, errorMessage(e))
      throw e
    }
  } catch (e) {
    const note = errorMessage(e)
    ctx.log(`小时摘要失败 [${key}]：${note}`)
    finishRun('failed', note)
    return { result: 'failed', note }
  }
}
