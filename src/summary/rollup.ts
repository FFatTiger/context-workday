// 日结、周月年增量更新、补跑、收尾、年摘要、手动重建（spec 第 4、5、6、8 节）。
// 增量落库规则（日、周、月、年通用）在 applyIncrementalOps：
//   keep 原样带旧引用；edit 换文本、保留旧引用并追加本次输入的新引用；delete 不写入新版本；
//   add 分配新编号、必须引用本次输入否则丢弃；不在本次输入里的引用去掉；超上限带提示重试一次，仍超按顺序截断。
// 版本的 inputs 记录"本版条目引用到的全部下层版本"（spec 12"用了哪些下层版本"），
// 这样 store.saveVersion 才能对任何被引用的下层系列正确标"上游已变更"。
import type { Level, StatusResponse, TaskRun, Trigger } from '../api-types.js'
import type { Ctx } from '../context.js'
import { tx } from '../db/db.js'
import type { Db } from '../db/db.js'
import type { DraftItem, LowerItem, RollupInput, RollupOp } from '../llm/types.js'
import { SummarizerFormatError } from '../llm/types.js'
import { DAY_MS, WEEKDAY_ZH, dayKey, fmt, local, monthKey, periodRange, startOfDay, weekKey, yearKey } from '../time.js'
import { getJobRule, nextRun } from '../jobs/rules.js'
import { gatherHourInput, pendingHours, runHour } from './hourly.js'
import { beginGeneration, failGeneration, getCurrentVersion, getSeries, getVersion, releaseGeneration, saveVersion } from './store.js'
import type { ItemRow, RefRow, RefSpec, SaveItem, SeriesRow, VersionBundle, VersionMetaRow } from './store.js'

export type RollupLevel = 'day' | 'week' | 'month' | 'year'

/** 条目上限（spec 第 4、5 节：日 6、周 8、月 10、年 12） */
export const MAX_ITEMS: Record<RollupLevel, number> = { day: 6, week: 8, month: 10, year: 12 }

export const PERIOD_RE: Record<Level, RegExp> = {
  hour: /^\d{4}-\d{2}-\d{2}T\d{2}$/,
  day: /^\d{4}-\d{2}-\d{2}$/,
  week: /^\d{4}-W\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

// ───────── 任务运行记录 ─────────

interface RunHandle {
  finish(result: 'success' | 'skipped' | 'failed', note: string, outputs?: Array<{ level: Level; period: string; version: number }>): TaskRun
}

export function startRun(ctx: Ctx, job: string, target: string, trigger: TaskRun['trigger']): RunHandle {
  const db = ctx.db
  const id = tx(db, () => {
    const r = db.prepare('INSERT INTO task_runs (job, target, scheduled_at, started_at, result, trigger) VALUES (?,?,?,?,?,?)').run(job, target, null, ctx.clock.now(), 'running', trigger)
    return Number(r.lastInsertRowid)
  })
  return {
    finish(result, note, outputs = []) {
      tx(db, () => {
        db.prepare('UPDATE task_runs SET ended_at = ?, result = ?, note = ?, outputs = ? WHERE id = ?').run(ctx.clock.now(), result, note, JSON.stringify(outputs), id)
      })
      return toTaskRun(db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as Record<string, unknown>)
    },
  }
}

export function toTaskRun(row: Record<string, unknown>): TaskRun {
  return {
    id: row.id as number,
    job: row.job as TaskRun['job'],
    target: row.target as string,
    scheduledAt: (row.scheduled_at as number | null) ?? null,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number | null) ?? null,
    result: row.result as TaskRun['result'],
    trigger: row.trigger as TaskRun['trigger'],
    note: (row.note as string) ?? '',
    outputs: JSON.parse((row.outputs as string) ?? '[]') as TaskRun['outputs'],
  }
}

// ───────── 下层版本的收集 ─────────

export interface LowerVersion {
  seriesId: number
  level: Level
  period: string
  version: number
  bundle: VersionBundle
}

/** 区间内的下层系列当前版本（周期完整落在 [from, to) 内），按周期升序 */
export function lowerVersionsInRange(db: Db, level: Level, from: number, to: number): LowerVersion[] {
  const rows = db
    .prepare('SELECT s.id AS sid, s.period AS period, s.current_version AS cv FROM series s WHERE s.level = ? AND s.current_version > 0 ORDER BY s.period')
    .all(level) as unknown as Array<{ sid: number; period: string; cv: number }>
  const out: LowerVersion[] = []
  for (const r of rows) {
    const p = periodRange(level, r.period)
    if (p.from < from || p.to > to) continue
    const bundle = getVersion(db, r.sid, r.cv)
    if (bundle) out.push({ seriesId: r.sid, level, period: r.period, version: r.cv, bundle })
  }
  return out
}

function loadLower(db: Db, sv: { seriesId: number; version: number }): LowerVersion | undefined {
  const row = db.prepare('SELECT level, period FROM series WHERE id = ?').get(sv.seriesId) as { level: Level; period: string } | undefined
  const bundle = row ? getVersion(db, sv.seriesId, sv.version) : undefined
  if (!row || !bundle) return undefined
  return { seriesId: sv.seriesId, level: row.level, period: row.period, version: sv.version, bundle }
}

/** 上层当前版本 inputs 之后新出的下层版本：inputs 里没有该系列，或记录的版本号更低 */
export function newLowerSince(upper: VersionMetaRow | undefined, lowers: LowerVersion[]): LowerVersion[] {
  if (!upper) return lowers
  return lowers.filter((lv) => !upper.inputs.some((i) => i.seriesId === lv.seriesId && i.version >= lv.version))
}

// ───────── 标签 ─────────

function fromLabel(level: Level, period: string): string {
  if (level === 'hour') return `${period.slice(11)}:00`
  if (level === 'day') {
    const { from } = periodRange('day', period)
    return `${WEEKDAY_ZH[local(from).wd]} ${fmt(from, 'MM/DD')}`
  }
  if (level === 'month') return `${Number(period.slice(5))} 月`
  return `${period} 年`
}

export function rollupLabel(level: RollupLevel, period: string): string {
  if (level === 'day') {
    const { from } = periodRange('day', period)
    return `${fmt(from, 'MM/DD')} ${WEEKDAY_ZH[local(from).wd]}`
  }
  if (level === 'week') {
    const { from, to } = periodRange('week', period)
    return `第 ${Number(period.split('W')[1])} 周（${fmt(from, 'MM/DD')}–${fmt(to - DAY_MS, 'MM/DD')}）`
  }
  if (level === 'month') return `${period.slice(0, 4)} 年 ${Number(period.slice(5))} 月`
  return `${period} 年`
}

function partLabel(level: 'week' | 'month', period: string, now: number): string {
  if (level === 'week') return period === weekKey(now) ? '本周' : `第 ${Number(period.split('W')[1])} 周`
  return period === monthKey(now) ? '本月' : `${Number(period.slice(5))} 月`
}

// ───────── 生成核心 ─────────

const REF_PREFIX: Record<Level, string> = { hour: 'h', day: 'd', week: 'w', month: 'm', year: 'y' }

interface BuiltInputs {
  inputs: LowerItem[]
  /** 模型 ref → 下层条目 */
  refMap: Map<string, RefSpec>
}

function buildInputs(lowers: LowerVersion[]): BuiltInputs {
  const inputs: LowerItem[] = []
  const refMap = new Map<string, RefSpec>()
  let n = 0
  for (const lv of lowers) {
    for (const it of lv.bundle.items) {
      const ref = `${REF_PREFIX[lv.level]}${++n}`
      inputs.push({ ref, from: fromLabel(lv.level, lv.period), text: it.text })
      refMap.set(ref, { type: 'item', versionId: lv.bundle.meta.id, itemId: it.item_id })
    }
  }
  return { inputs, refMap }
}

/** 版本 inputs：本版条目引用到的全部下层版本（去重） */
function inputsOfItems(db: Db, items: SaveItem[]): Array<{ seriesId: number; version: number }> {
  const out = new Map<number, { seriesId: number; version: number }>()
  for (const it of items) {
    for (const r of it.refs) {
      if (r.type !== 'item') continue
      const row = db.prepare('SELECT series_id, version FROM versions WHERE id = ?').get(r.versionId) as { series_id: number; version: number } | undefined
      if (row) out.set(r.versionId, { seriesId: row.series_id, version: row.version })
    }
  }
  return [...out.values()]
}

/** 输出格式不对带 feedback 重试一次（spec 14） */
async function withFormatRetry<T>(fn: (feedback?: string) => Promise<T>): Promise<T> {
  let feedback: string | undefined
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(feedback)
    } catch (e) {
      if (e instanceof SummarizerFormatError && attempt === 0) {
        feedback = e.message
        continue
      }
      throw e
    }
  }
}

export interface GenResult {
  result: 'success' | 'skipped' | 'failed'
  version?: number
  note?: string
}

/** 全量生成：收尾、日结首次、手动重建 */
async function generateFull(
  ctx: Ctx,
  level: RollupLevel,
  period: string,
  trigger: Trigger,
  lowers: LowerVersion[],
  opts: { isFinal?: boolean } = {},
): Promise<GenResult> {
  const db = ctx.db
  const series = beginGeneration(db, level, period)
  try {
    if (lowers.length === 0) {
      releaseGeneration(db, series.id)
      return { result: 'skipped', note: '没有下层摘要' }
    }
    const { inputs, refMap } = buildInputs(lowers)
    const rollupInput: RollupInput = { level, label: rollupLabel(level, period), maxItems: MAX_ITEMS[level], previous: [], inputs }
    const validate = (ds: DraftItem[]) =>
      ds
        .map((d) => ({ text: d.text.trim(), refs: [...new Set(d.refs)].filter((r) => refMap.has(r)) }))
        .filter((d) => d.text.length > 0 && d.refs.length > 0)
    let drafts = validate(await withFormatRetry((fb) => ctx.summarizer.rollupFull(rollupInput, fb)))
    if (drafts.length === 0) throw new Error('模型输出没有引用下层条目的有效条目')
    if (drafts.length > MAX_ITEMS[level]) {
      try {
        const retry = validate(await ctx.summarizer.rollupFull(rollupInput, `条目数 ${drafts.length} 超过上限，请最多输出 ${MAX_ITEMS[level]} 条`))
        if (retry.length > 0) drafts = retry
      } catch {
        // 重试失败就用第一次的结果截断
      }
      if (drafts.length > MAX_ITEMS[level]) drafts = drafts.slice(0, MAX_ITEMS[level])
    }
    const items: SaveItem[] = drafts.map((d) => ({ text: d.text, op: 'add', refs: d.refs.map((r) => refMap.get(r)!) }))
    const version = saveVersion(db, {
      level,
      period,
      createdAt: ctx.clock.now(),
      trigger,
      mode: 'full',
      model: ctx.summarizer.model,
      inputs: inputsOfItems(db, items),
      isFinal: opts.isFinal,
      items,
    })
    return { result: 'success', version }
  } catch (e) {
    failGeneration(db, series.id, errorMessage(e))
    return { result: 'failed', note: errorMessage(e) }
  }
}

function refSpecOf(row: RefRow): RefSpec {
  return row.target_type === 'item'
    ? { type: 'item', versionId: row.target_version!, itemId: row.target_item! }
    : { type: row.target_type, rawId: row.raw_id! }
}

/** 增量落库规则（日、周、月、年通用，见文件头注释） */
export function applyIncrementalOps(
  prevItems: ItemRow[],
  prevRefs: Map<number, RefRow[]>,
  ops: RollupOp[],
  refMap: Map<string, RefSpec>,
): { items: SaveItem[]; droppedAdd: number } {
  const prevById = new Map(prevItems.map((i) => [i.item_id, i]))
  const result = new Map<number, SaveItem>()
  const order: number[] = []
  const adds: SaveItem[] = []
  let droppedAdd = 0
  const prevRefSpecs = (id: number): RefSpec[] => (prevRefs.get(id) ?? []).map(refSpecOf)
  const refKey = (r: RefSpec): string => (r.type === 'item' ? `i:${r.versionId}:${r.itemId}` : `${r.type}:${r.rawId}`)
  for (const op of ops) {
    if (op.op === 'keep' || op.op === 'edit' || op.op === 'delete') {
      const prev = prevById.get(op.id)
      if (!prev || result.has(op.id)) continue
      if (op.op === 'delete') continue
      if (op.op === 'keep' || op.text.trim().length === 0) {
        result.set(op.id, { itemId: op.id, text: prev.text, op: 'keep', refs: prevRefSpecs(op.id) })
      } else {
        const oldRefs = prevRefSpecs(op.id)
        const oldKeys = new Set(oldRefs.map(refKey))
        const newRefs = op.refs.filter((r) => refMap.has(r)).map((r) => refMap.get(r)!).filter((r) => !oldKeys.has(refKey(r)))
        result.set(op.id, { itemId: op.id, text: op.text.trim(), op: 'edit', refs: [...oldRefs, ...newRefs] })
      }
      order.push(op.id)
    } else {
      const text = op.text.trim()
      const newRefs = op.refs.filter((r) => refMap.has(r)).map((r) => refMap.get(r)!)
      if (text.length === 0 || newRefs.length === 0) {
        droppedAdd++ // add 必须引用本次输入，否则丢弃
        continue
      }
      adds.push({ text, op: 'add', refs: newRefs })
    }
  }
  return { items: [...order.map((id) => result.get(id)!), ...adds], droppedAdd }
}

/** 增量生成：日结并入新小时版本、周月并入新日结、年并入最终版月摘要 */
async function generateIncremental(ctx: Ctx, level: RollupLevel, period: string, trigger: Trigger, lowers: LowerVersion[], opts: { isFinal?: boolean } = {}): Promise<GenResult> {
  const db = ctx.db
  const series = beginGeneration(db, level, period)
  try {
    if (lowers.length === 0) {
      releaseGeneration(db, series.id)
      return { result: 'skipped', note: '没有新输入' }
    }
    const prevBundle = getCurrentVersion(db, series.id)
    const previous = prevBundle ? prevBundle.items.map((i) => ({ id: i.item_id, text: i.text })) : []
    const prevRefs = new Map<number, RefRow[]>()
    if (prevBundle) for (const r of prevBundle.refs) prevRefs.set(r.item_id, [...(prevRefs.get(r.item_id) ?? []), r])

    const { inputs, refMap } = buildInputs(lowers)
    const rollupInput: RollupInput = { level, label: rollupLabel(level, period), maxItems: MAX_ITEMS[level], previous, inputs }
    const apply = (ops: RollupOp[]) => applyIncrementalOps(prevBundle?.items ?? [], prevRefs, ops, refMap)
    let { items } = apply(await withFormatRetry((fb) => ctx.summarizer.rollupIncremental(rollupInput, fb)))
    if (items.length === 0) throw new Error('模型输出没有有效条目')
    if (items.length > MAX_ITEMS[level]) {
      try {
        const retry = apply(await ctx.summarizer.rollupIncremental(rollupInput, `条目数 ${items.length} 超过上限 ${MAX_ITEMS[level]}，请用 delete 减少条目`))
        if (retry.items.length > 0) items = retry.items
      } catch {
        // 重试失败就用第一次的结果截断
      }
      if (items.length > MAX_ITEMS[level]) items = items.slice(0, MAX_ITEMS[level])
    }
    const version = saveVersion(db, {
      level,
      period,
      createdAt: ctx.clock.now(),
      trigger,
      mode: 'incremental',
      model: ctx.summarizer.model,
      inputs: inputsOfItems(db, items),
      isFinal: opts.isFinal,
      items,
    })
    return { result: 'success', version }
  } catch (e) {
    failGeneration(db, series.id, errorMessage(e))
    return { result: 'failed', note: errorMessage(e) }
  }
}

// ───────── 日结（spec 第 4 节） ─────────

export type DailyRunTrigger = 'scheduled' | 'catchup' | 'manual' | 'startup'

/** "立即生成日结"按钮 = runDaily(ctx, 今天, 'manual')；trigger='catchup' 是补跑任务补历史日（票 11），版本记补跑、任务记录记定时 */
export async function runDaily(ctx: Ctx, day: string, trigger: DailyRunTrigger): Promise<TaskRun> {
  const db = ctx.db
  const run = startRun(ctx, 'daily', day, trigger === 'catchup' ? 'scheduled' : trigger)
  const { from, to } = periodRange('day', day)
  try {
    // 1. 当天所有待处理小时
    let hourFails = 0
    for (const key of pendingHours(ctx).filter((k) => k.startsWith(`${day}T`))) {
      const r = await runHour(ctx, key, 'scheduled')
      if (r.result === 'failed') hourFails++
    }

    // 2. 迟到核对：对当天每个已有版本的小时重新数与我有关的原文，多了就重跑
    let lateReruns = 0
    for (const lv of lowerVersionsInRange(db, 'hour', from, to)) {
      const { relatedCount } = await gatherHourInput(ctx, lv.period)
      if (relatedCount > (lv.bundle.meta.related_msgs ?? 0)) {
        const r = await runHour(ctx, lv.period, 'late')
        if (r.result === 'success') lateReruns++
      }
    }

    // 3–5. 全量 / 增量生成日结
    const outputs: TaskRun['outputs'] = []
    const parts: string[] = []
    const hours = lowerVersionsInRange(db, 'hour', from, to) // 重跑后重新取
    const daySeries = getSeries(db, 'day', day)
    const prev = daySeries && daySeries.current_version > 0 ? getVersion(db, daySeries.id, daySeries.current_version) : undefined
    const gen = prev
      ? await generateIncremental(ctx, 'day', day, trigger, newLowerSince(prev.meta, hours))
      : await generateFull(ctx, 'day', day, trigger, hours)
    if (gen.result === 'failed') return run.finish('failed', gen.note ?? '日结生成失败', outputs)

    if (gen.result === 'success') {
      outputs.push({ level: 'day', period: day, version: gen.version! })
      parts.push(`日结 v${gen.version}`)

      // 6. 增量更新本周、本月
      const daySid = getSeries(db, 'day', day)!.id
      for (const level of ['week', 'month'] as const) {
        const period = level === 'week' ? weekKey(from) : monthKey(from)
        const up = await updatePeriod(ctx, level, period, [{ seriesId: daySid, version: gen.version! }], trigger)
        if (up.result === 'success') {
          outputs.push({ level, period, version: up.version! })
          parts.push(`${partLabel(level, period, ctx.clock.now())} v${up.version}`)
        } else {
          parts.push(`${partLabel(level, period, ctx.clock.now())}${up.result === 'failed' ? '生成失败' : up.reason === '已收尾' ? '已收尾' : '未变'}`)
        }
      }
    }

    // 7. 运行记录
    const prefixes = [hourFails > 0 && `${hourFails} 个小时生成失败`, lateReruns > 0 && `迟到重跑 ${lateReruns} 个小时`].filter(Boolean) as string[]
    const note = gen.result === 'skipped' ? `${prefixes.join(' · ')}${prefixes.length ? ' · ' : ''}${gen.note === '没有下层摘要' ? '当天没有小时摘要' : gen.note}` : [...prefixes, `生成 ${parts.join(' · ')}`].join(' · ')
    return run.finish(gen.result === 'success' ? 'success' : 'skipped', note, outputs)
  } catch (e) {
    ctx.log(`日结失败 [${day}]：${errorMessage(e)}`)
    return run.finish('failed', errorMessage(e))
  }
}

// ───────── 周、月：增量更新、收尾（spec 第 5 节） ─────────

export interface PeriodUpdate {
  result: 'success' | 'skipped' | 'failed'
  version?: number
  reason?: string
}

/** 已收尾的周期不再增量，只标上游已变更（spec 第 5 节）：周期内出了新版本的日结系列就标（票 11：改为按周期包含判断，补日结补出来的新系列也算） */
function flagUpstreamIfChanged(db: Db, s: SeriesRow, level: 'week' | 'month', newDayVersions: Array<{ seriesId: number; version: number }>): void {
  const current = getCurrentVersion(db, s.id)
  if (!current) return
  const ids = [...new Set(newDayVersions.map((v) => v.seriesId))]
  if (ids.length === 0) return
  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT period FROM series WHERE id IN (${ph})`).all(...ids) as unknown as Array<{ period: string }>
  const { from, to } = periodRange(level, s.period)
  const hit = rows.some((r) => {
    const p = periodRange('day', r.period)
    return p.from >= from && p.to <= to
  })
  if (hit) db.prepare('UPDATE series SET upstream_changed = 1 WHERE id = ?').run(s.id)
}

/** 用新的日结版本增量更新周或月摘要 */
export async function updatePeriod(
  ctx: Ctx,
  level: 'week' | 'month',
  period: string,
  newDayVersions: Array<{ seriesId: number; version: number }>,
  trigger: Trigger,
): Promise<PeriodUpdate> {
  const db = ctx.db
  const s = getSeries(db, level, period)
  if (s?.is_final) {
    flagUpstreamIfChanged(db, s, level, newDayVersions)
    return { result: 'skipped', reason: '已收尾' }
  }
  if (newDayVersions.length === 0) return { result: 'skipped', reason: '没有新输入' }
  const lowers = newDayVersions.map((v) => loadLower(db, v)).filter((v): v is LowerVersion => v !== undefined)
  const gen = await generateIncremental(ctx, level, period, trigger, lowers)
  return gen.result === 'success' ? { result: 'success', version: gen.version } : { result: gen.result, reason: gen.note }
}

export interface CloseResult {
  result: 'success' | 'skipped' | 'failed'
  version?: number
  reason?: string
}

/** 收尾：用周期内全部日结的最新版本全量生成，标最终版 */
export async function closePeriod(ctx: Ctx, level: 'week' | 'month', period: string): Promise<CloseResult> {
  const db = ctx.db
  const s = getSeries(db, level, period)
  if (s?.is_final) return { result: 'skipped', reason: '已收尾' }
  const { from, to } = periodRange(level, period)
  const days = lowerVersionsInRange(db, 'day', from, to)
  if (days.length === 0) return { result: 'skipped', reason: '周期内没有日结' }
  const gen = await generateFull(ctx, level, period, 'close', days, { isFinal: true })
  return gen.result === 'success' ? { result: 'success', version: gen.version } : { result: gen.result, reason: gen.note }
}

// ───────── 补跑前置：只有小时摘要、没有日结的日子（票 11） ─────────

/**
 * 过去 7 天里（不含今天、昨天）有小时摘要版本、但日结系列没有成功版本的日子，按时间先后补日结。
 * 客户端断窗后恢复会留下这样一批日子；runDaily 会顺带增量更新那一周、那一月，
 * 已收尾的周期按现有规则只标上游已变更。返回补了哪几天。
 */
export async function backfillMissingDailies(ctx: Ctx): Promise<string[]> {
  const db = ctx.db
  const today = startOfDay(ctx.clock.now())
  const days: string[] = []
  for (let i = 7; i >= 2; i--) {
    const day = dayKey(today - i * DAY_MS)
    const hasHours = db.prepare("SELECT 1 FROM series WHERE level = 'hour' AND current_version > 0 AND substr(period, 1, 10) = ? LIMIT 1").get(day)
    if (!hasHours) continue
    const daySeries = getSeries(db, 'day', day)
    if (daySeries && daySeries.current_version > 0) continue
    days.push(day)
  }
  for (const day of days) await runDaily(ctx, day, 'catchup')
  return days
}

/** 补跑（spec 第 5 节）：前一天日结之后有新小时版本 → 日结增量 + 周月增量；周期结束就收尾 */
export async function runCatchup(ctx: Ctx, day: string, trigger: 'scheduled' | 'startup' | 'manual' = 'scheduled'): Promise<TaskRun> {
  const db = ctx.db
  const run = startRun(ctx, 'catchup', day, trigger)
  const { from, to } = periodRange('day', day)
  try {
    const outputs: TaskRun['outputs'] = []
    const parts: string[] = []

    const hours = lowerVersionsInRange(db, 'hour', from, to)
    const daySeries = getSeries(db, 'day', day)
    const prev = daySeries && daySeries.current_version > 0 ? getVersion(db, daySeries.id, daySeries.current_version) : undefined
    const newHours = newLowerSince(prev?.meta, hours)
    if (newHours.length > 0) {
      const gen = prev
        ? await generateIncremental(ctx, 'day', day, 'catchup', newHours)
        : await generateFull(ctx, 'day', day, 'catchup', hours)
      if (gen.result === 'failed') return run.finish('failed', gen.note ?? '补跑失败', outputs)
      if (gen.result === 'success') {
        outputs.push({ level: 'day', period: day, version: gen.version! })
        parts.push(`日结 v${gen.version}`)
        const daySid = getSeries(db, 'day', day)!.id
        for (const level of ['week', 'month'] as const) {
          const period = level === 'week' ? weekKey(from) : monthKey(from)
          const up = await updatePeriod(ctx, level, period, [{ seriesId: daySid, version: gen.version! }], 'catchup')
          if (up.result === 'success') {
            outputs.push({ level, period, version: up.version! })
            parts.push(`${partLabel(level, period, ctx.clock.now())} v${up.version}`)
          }
        }
      }
    }

    // 前一天是周日 → 收尾上周；月末 → 收尾上月
    if (local(from).wd === 7) {
      const period = weekKey(from)
      const closed = await closePeriod(ctx, 'week', period)
      if (closed.result === 'success') {
        outputs.push({ level: 'week', period, version: closed.version! })
        parts.push(`收尾${partLabel('week', period, ctx.clock.now())} v${closed.version}`)
      }
    }
    if (monthKey(from + DAY_MS) !== monthKey(from)) {
      const period = monthKey(from)
      const closed = await closePeriod(ctx, 'month', period)
      if (closed.result === 'success') {
        outputs.push({ level: 'month', period, version: closed.version! })
        parts.push(`收尾${partLabel('month', period, ctx.clock.now())} v${closed.version}`)
      }
    }

    if (outputs.length === 0) return run.finish('skipped', '没有新内容')
    return run.finish('success', parts.join(' · '), outputs)
  } catch (e) {
    ctx.log(`补跑失败 [${day}]：${errorMessage(e)}`)
    return run.finish('failed', errorMessage(e))
  }
}

// ───────── 年摘要（spec 第 6 节） ─────────

/** 每月 1 日：上个月没收尾先收尾，然后用上个月最终版条目对本年增量；1 月并入 12 月后那版标最终版 */
export async function runYearly(ctx: Ctx, month: string, trigger: 'scheduled' | 'startup' | 'manual' = 'scheduled'): Promise<TaskRun> {
  const db = ctx.db
  const run = startRun(ctx, 'yearly', month, trigger)
  try {
    const { from } = periodRange('month', month)
    const year = yearKey(from)
    const outputs: TaskRun['outputs'] = []
    const parts: string[] = []

    const mSeries = getSeries(db, 'month', month)
    if (mSeries && mSeries.current_version > 0 && !mSeries.is_final) {
      const closed = await closePeriod(ctx, 'month', month)
      if (closed.result === 'failed') return run.finish('failed', closed.reason ?? '收尾失败', outputs)
      if (closed.result === 'success') {
        outputs.push({ level: 'month', period: month, version: closed.version! })
        parts.push(`收尾 ${fromLabel('month', month)} v${closed.version}`)
      }
    }

    const mNow = getSeries(db, 'month', month)
    if (mNow && mNow.current_version > 0) {
      const lower = loadLower(db, { seriesId: mNow.id, version: mNow.current_version })
      if (lower) {
        const ySeries = getSeries(db, 'year', year)
        const yPrev = ySeries && ySeries.current_version > 0 ? getVersion(db, ySeries.id, ySeries.current_version) : undefined
        const merged = yPrev?.meta.inputs.some((i) => i.seriesId === mNow.id && i.version >= mNow.current_version) ?? false
        if (!merged) {
          // 1 月 1 日并入 12 月之后，那一版就是上一年的最终版
          const isFinal = Number(month.slice(5)) === 12
          const gen = await generateIncremental(ctx, 'year', year, trigger, [lower], { isFinal })
          if (gen.result === 'failed') return run.finish('failed', gen.note ?? '年摘要生成失败', outputs)
          if (gen.result === 'success') {
            outputs.push({ level: 'year', period: year, version: gen.version! })
            parts.push(`${year} 年 v${gen.version}${isFinal ? '（最终版）' : ''}`)
          }
        }
      }
    }

    if (outputs.length === 0) return run.finish('skipped', '没有新内容')
    return run.finish('success', parts.join(' · '), outputs)
  } catch (e) {
    ctx.log(`年摘要失败 [${month}]：${errorMessage(e)}`)
    return run.finish('failed', errorMessage(e))
  }
}

// ───────── 手动重建（spec 第 8、13.8 节） ─────────

export class RegenerateError extends Error {
  constructor(message: string, public status: 400 | 404 | 409 | 500) {
    super(message)
    this.name = 'RegenerateError'
  }
}

/** 任何层级都可以，一律全量，用最新的下层版本；小时级从原文生成 */
export async function regenerate(ctx: Ctx, level: Level, period: string): Promise<number> {
  const db = ctx.db
  if (!PERIOD_RE[level].test(period)) throw new RegenerateError(`周期键格式不合法：${period}`, 400)
  const { from, to } = periodRange(level, period)
  const now = ctx.clock.now()
  if (level === 'hour') {
    if (to > now) throw new RegenerateError('该小时还没有结束，不能生成', 400)
  } else if (from > now) {
    throw new RegenerateError('该周期还没有开始，不能生成', 400)
  }
  const s = getSeries(db, level, period)
  if (s?.state === 'generating') throw new RegenerateError('正在生成', 409)

  if (level === 'hour') {
    const r = await runHour(ctx, period, 'manual')
    if (r.result === 'success') return r.version!
    throw new RegenerateError(r.note, r.result === 'skipped' ? 400 : 500)
  }

  const lowers =
    level === 'day'
      ? lowerVersionsInRange(db, 'hour', from, to)
      : level === 'year'
        ? lowerVersionsInRange(db, 'month', from, to)
        : lowerVersionsInRange(db, 'day', from, to)
  if (lowers.length === 0) {
    throw new RegenerateError(level === 'day' ? '该日还没有小时摘要' : '该周期还没有下层摘要', 400)
  }
  // 已收尾的周期手动重建，会再生成一个最终版（spec 第 5 节）
  const gen = await generateFull(ctx, level, period, 'manual', lowers, { isFinal: s?.is_final === 1 })
  if (gen.result === 'success') return gen.version!
  throw new RegenerateError(gen.note ?? '生成失败', 500)
}

// ───────── 状态与计划时间（/api/status、卡片共用；时间读任务配置） ─────────

/** daily 规则的当天分钟数 */
function ruleMinuteOfDay(db: Db, name: 'daily' | 'catchup' | 'hourly'): number {
  const r = getJobRule(db, name)
  return r.type === 'hourly' ? r.minute : r.hour * 60 + r.minute
}

/** 下一次日结或补跑的时间：补跑时间前是补跑，日结时间前是日结，之后是明天补跑 */
export function nextDailyRunAt(db: Db, now: number): number {
  const today = startOfDay(now)
  const catchup = today + ruleMinuteOfDay(db, 'catchup') * 60_000
  const daily = today + ruleMinuteOfDay(db, 'daily') * 60_000
  if (now < catchup) return catchup
  if (now < daily) return daily
  return catchup + DAY_MS
}

/** 下次年摘要时间 */
export function nextYearlyRunAt(db: Db, now: number): number {
  return nextRun(getJobRule(db, 'yearly'), now)
}

/** 未生成时的计划生成时间；已完全过去的周期返回 null */
export function scheduledAtFor(db: Db, level: Level, period: string, now: number): number | null {
  const { from, to } = periodRange(level, period)
  if (level === 'hour') return to + ruleMinuteOfDay(db, 'hourly') * 60_000
  if (level === 'year') return nextYearlyRunAt(db, now)
  return from > now ? from + ruleMinuteOfDay(db, 'daily') * 60_000 : nextDailyRunAt(db, now)
}

/** 今天日结的状态（/api/status 的 daily 部分） */
export function dailyStatus(ctx: Ctx): StatusResponse['daily'] {
  const db = ctx.db
  const now = ctx.clock.now()
  const s = getSeries(db, 'day', dayKey(now))
  if (s?.state === 'generating') return { state: 'generating', at: null, scheduledAt: null }
  if (s && s.current_version > 0) {
    const v = getVersion(db, s.id, s.current_version)
    return { state: 'ok', at: v?.meta.created_at ?? null, scheduledAt: null }
  }
  if (s?.state === 'failed') return { state: 'failed', at: null, scheduledAt: nextDailyRunAt(db, now) }
  return { state: 'none', at: null, scheduledAt: nextDailyRunAt(db, now) }
}

/** 日结卡片的当天消息统计：当天各小时当前版本统计之和 */
export function dayStats(ctx: Ctx, day: string): { totalMsgs: number; relatedMsgs: number; hours: number } {
  const { from, to } = periodRange('day', day)
  const hours = lowerVersionsInRange(ctx.db, 'hour', from, to)
  let totalMsgs = 0
  let relatedMsgs = 0
  for (const h of hours) {
    totalMsgs += h.bundle.meta.total_msgs ?? 0
    relatedMsgs += h.bundle.meta.related_msgs ?? 0
  }
  return { totalMsgs, relatedMsgs, hours: hours.length }
}
