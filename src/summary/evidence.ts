// 证据链与原文可用性（spec 第 7 节、ADR-0002）：条目 → 下层条目 → 原文。
// 可用性两级：
//  - 便宜计数（时间线、卡片、/affected）：只查本机和 raw_lost，不调客户端；
//  - 精确判定（证据抽屉）：本机没有且未判定过时才查客户端，查不到写 raw_lost，以后不再反复查。
import type {
  AffectedResponse,
  EventDetail,
  EvidenceNode,
  EvidenceResponse,
  ImContextResponse,
  ItemRef,
  ItemView,
  LostReason,
  MailDetail,
  RawType,
} from '../api-types.js'
import type { Ctx } from '../context.js'
import { getMeta } from '../db/db.js'
import type { Db } from '../db/db.js'
import type { CalendarEvent, Contact, ImMessage, Mail, MailAddress, Person } from '../source/types.js'
import { SourceUnavailableError } from '../source/types.js'
import { DAY_MS, dayKey, fmt, local, periodRange, startOfDay, type Level } from '../time.js'
import { getSeries, getVersion, type RefRow, type VersionBundle } from './store.js'

export const LEVEL_NAME: Record<Level, string> = { hour: '小时摘要', day: '日结', week: '周摘要', month: '月摘要', year: '年摘要' }

const RAW_TABLE: Record<'im' | 'mail' | 'event', string> = { im: 'im_messages', mail: 'mails', event: 'events' }
/** 原文类型 → 备份来源 / 客户端保留期字段 */
const SOURCE_OF: Record<RawType, 'im' | 'mail' | 'calendar'> = { im: 'im', mail: 'mail', event: 'calendar' }

function localHas(db: Db, type: RawType, rawId: string): boolean {
  return db.prepare(`SELECT 1 FROM ${RAW_TABLE[type]} WHERE id = ?`).get(rawId) !== undefined
}

async function meId(ctx: Ctx): Promise<string> {
  const me = getMeta<Contact>(ctx.db, 'me')
  if (me) return me.id
  try {
    return (await ctx.source.me()).id
  } catch (e) {
    if (e instanceof SourceUnavailableError) return '' // 客户端不可用：只影响 isMine 标记，不该 500
    throw e
  }
}

// ───────── 便宜的丢失判定（不调客户端） ─────────

// ponytail: 计数要便宜——时间线、卡片、/affected 上的 degraded 计数不调客户端：
// 本机有或在客户端保留期内视为可用；raw_lost 有记录或超保留期且本机没有视为丢失。
export function isRawLostCheap(db: Db, type: RawType, rawId: string, approxTime: number, now: number, retentionDays: number): boolean {
  if (localHas(db, type, rawId)) return false
  if (db.prepare('SELECT 1 FROM raw_lost WHERE raw_type = ? AND raw_id = ?').get(type, rawId)) return true
  return approxTime < now - retentionDays * DAY_MS
}

/**
 * 丢失原因（spec 第 7 节）：那天备份覆盖 ok → gone_at_backup（备份时客户端里已经没有，例如撤回）；
 * 邮件且从未备份覆盖 → expired_unbacked；其他 → backup_gap。
 */
function lostReasonFor(db: Db, type: RawType, rawTime: number): LostReason {
  const day = dayKey(startOfDay(rawTime))
  const row = db.prepare('SELECT client_count, local_count FROM backup_days WHERE source = ? AND day = ?').get(SOURCE_OF[type], day) as
    | { client_count: number; local_count: number }
    | undefined
  if (row && row.local_count >= row.client_count) return 'gone_at_backup'
  if (type === 'mail' && !row) return 'expired_unbacked'
  return 'backup_gap'
}

function recordLost(db: Db, type: RawType, rawId: string, reason: LostReason, now: number): void {
  db.prepare('INSERT INTO raw_lost (raw_type, raw_id, reason, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(raw_type, raw_id) DO NOTHING').run(type, rawId, reason, now)
}

// ───────── 精确可用性（证据抽屉） ─────────

export type Availability =
  | { available: true; raw?: ImMessage | Mail | CalendarEvent }
  | { available: true; clientUnavailable: true } // 保留期内但客户端反查失败：按可用处理，展示为“原文暂不可读”
  | { available: false; reason: LostReason }

async function findRaw(ctx: Ctx, type: RawType, rawId: string): Promise<ImMessage | Mail | CalendarEvent | null> {
  // 没实现 findX 就视为客户端里没有
  if (type === 'im') return (await ctx.source.findMessage?.(rawId)) ?? null
  if (type === 'mail') return (await ctx.source.findMail?.(rawId)) ?? null
  return (await ctx.source.findEvent?.(rawId)) ?? null
}

/** 原文可用性：先本机，再 raw_lost，保留期内查一次客户端；查不到判定丢失并写 raw_lost */
export async function rawAvailability(ctx: Ctx, cache: Map<string, Availability>, type: RawType, rawId: string, approxTime: number): Promise<Availability> {
  const key = `${type}:${rawId}`
  const hit = cache.get(key)
  if (hit) return hit
  const db = ctx.db
  const now = ctx.clock.now()
  let out: Availability
  if (localHas(db, type, rawId)) {
    out = { available: true }
  } else {
    const lost = db.prepare('SELECT reason FROM raw_lost WHERE raw_type = ? AND raw_id = ?').get(type, rawId) as { reason: LostReason } | undefined
    if (lost) {
      out = { available: false, reason: lost.reason }
    } else if (approxTime >= now - ctx.source.retentionDays[SOURCE_OF[type]] * DAY_MS) {
      // 还在客户端保留期内：查一次，查到的对象缓存在本次请求里复用
      // 客户端反查抛 SourceUnavailableError 时不判丢失、不写 raw_lost（便宜规则：保留期内视为可用）
      let raw: ImMessage | Mail | CalendarEvent | null
      try {
        raw = await findRaw(ctx, type, rawId)
      } catch (e) {
        if (e instanceof SourceUnavailableError) {
          out = { available: true, clientUnavailable: true }
          cache.set(key, out)
          return out
        }
        throw e
      }
      if (raw) {
        out = { available: true, raw }
      } else {
        const reason = lostReasonFor(db, type, approxTime)
        recordLost(db, type, rawId, reason, now)
        out = { available: false, reason }
      }
    } else {
      out = { available: false, reason: lostReasonFor(db, type, approxTime) }
      recordLost(db, type, rawId, out.reason, now)
    }
  }
  cache.set(key, out)
  return out
}

// ───────── 条目视图（时间线 / 卡片共用） ─────────

function refsOf(db: Db, versionId: number, itemId: number): RefRow[] {
  return db.prepare('SELECT item_id, target_type, target_version, target_item, raw_id, is_new FROM refs WHERE version_id = ? AND item_id = ?').all(versionId, itemId) as unknown as RefRow[]
}

function versionInfo(db: Db, versionId: number): { vid: number; level: Level; period: string } | undefined {
  return db.prepare('SELECT v.id AS vid, s.level AS level, s.period AS period FROM versions v JOIN series s ON s.id = v.series_id WHERE v.id = ?').get(versionId) as unknown as
    | { vid: number; level: Level; period: string }
    | undefined
}

function hourItemDegraded(db: Db, versionId: number, itemId: number, hourStart: number, now: number, ret: Ctx['source']['retentionDays']): boolean {
  return refsOf(db, versionId, itemId).some((r) => {
    if (r.target_type === 'item') return false
    const type = r.target_type as RawType
    return isRawLostCheap(db, type, r.raw_id!, hourStart, now, ret[SOURCE_OF[type]])
  })
}

/** 一个条目证据链下已降级的小时条目个数（便宜规则，不调客户端；小时条目自己是 0/1） */
function degradedUnder(db: Db, versionId: number, itemId: number, now: number, ret: Ctx['source']['retentionDays'], seen: Set<string>): number {
  const key = `${versionId}:${itemId}`
  if (seen.has(key)) return 0
  seen.add(key)
  const info = versionInfo(db, versionId)
  if (!info) return 0
  if (info.level === 'hour') {
    return hourItemDegraded(db, versionId, itemId, periodRange('hour', info.period).from, now, ret) ? 1 : 0
  }
  let n = 0
  for (const r of refsOf(db, versionId, itemId)) {
    if (r.target_type === 'item' && r.target_version !== null) n += degradedUnder(db, r.target_version, r.target_item!, now, ret, seen)
  }
  return n
}

/** 某版本全部条目的视图（counts + degraded），时间线和摘要卡片复用 */
export function itemViews(ctx: Ctx, versionId: number): ItemView[] {
  const db = ctx.db
  const now = ctx.clock.now()
  const ret = ctx.source.retentionDays
  const info = versionInfo(db, versionId)
  const items = db.prepare('SELECT item_id, position, text, op FROM items WHERE version_id = ? ORDER BY position').all(versionId) as unknown as Array<{ item_id: number; text: string; op: ItemView['op'] }>
  return items.map((it) => {
    const refs = refsOf(db, versionId, it.item_id)
    if (info?.level === 'hour') {
      const hourStart = periodRange('hour', info.period).from
      const raws = refs.filter((r) => r.target_type !== 'item') as Array<RefRow & { target_type: 'im' | 'mail' | 'event'; raw_id: string }>
      return {
        itemId: it.item_id,
        text: it.text,
        op: it.op,
        counts: {
          evidence: refs.length,
          im: raws.filter((r) => r.target_type === 'im').length,
          mail: raws.filter((r) => r.target_type === 'mail').length,
          event: raws.filter((r) => r.target_type === 'event').length,
        },
        degraded: hourItemDegraded(db, versionId, it.item_id, hourStart, now, ret) ? 1 : 0,
      }
    }
    return {
      itemId: it.item_id,
      text: it.text,
      op: it.op,
      counts: { evidence: refs.filter((r) => r.target_type === 'item').length },
      degraded: degradedUnder(db, versionId, it.item_id, now, ret, new Set()),
    }
  })
}

// ───────── 证据树 ─────────

function whenLabel(level: Level, period: string): string {
  if (level === 'hour') return `${period.slice(11)}:00`
  const { from, to } = periodRange(level, period)
  if (level === 'day') return fmt(from, 'MM/DD')
  if (level === 'week') return `${fmt(from, 'MM/DD')}–${fmt(to - DAY_MS, 'MM/DD')}`
  if (level === 'month') return fmt(from, 'YYYY-MM')
  return period
}

function pathLabel(level: Level, period: string, now: number): string {
  if (level === 'hour') return `${period.slice(11)}:00`
  if (level === 'day') return period === dayKey(now) ? '今天' : fmt(periodRange('day', period).from, 'MM/DD')
  if (level === 'week') return `第 ${Number(period.split('W')[1])} 周`
  if (level === 'month') return `${Number(period.slice(5))} 月`
  return `${period} 年`
}

/** 祖先路径：当前版本里引用了本条的上层条目，最上层在前，末尾是本条自己的标签 */
function buildPath(ctx: Ctx, versionId: number, itemId: number, selfLevel: Level, selfPeriod: string): EvidenceResponse['path'] {
  const db = ctx.db
  const now = ctx.clock.now()
  const out: EvidenceResponse['path'] = []
  let curV = versionId
  let curI = itemId
  for (let depth = 0; depth < 10; depth++) {
    const up = db
      .prepare(
        `SELECT s.level AS level, s.period AS period, v.version AS version, v.id AS vid, r.item_id AS upper_item
         FROM refs r
         JOIN versions v ON v.id = r.version_id
         JOIN series s ON s.id = v.series_id AND s.current_version = v.version
         JOIN items i ON i.version_id = v.id AND i.item_id = r.item_id
         WHERE r.target_type = 'item' AND r.target_version = ? AND r.target_item = ?
         ORDER BY v.created_at DESC LIMIT 1`,
      )
      .get(curV, curI) as unknown as { level: Level; period: string; version: number; vid: number; upper_item: number } | undefined
    if (!up) break
    out.unshift({ label: `${pathLabel(up.level, up.period, now)} v${up.version}`, ref: { level: up.level, period: up.period, version: up.version, itemId: up.upper_item } })
    curV = up.vid
    curI = up.upper_item
  }
  out.push({ label: pathLabel(selfLevel, selfPeriod, now) })
  return out
}

interface ImRaw {
  id: string
  sessionId: string
  senderId: string
  senderName: string
  time: number
  text: string
}
interface MailRaw {
  id: string
  subject: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  time: number
  text: string
  folder: string
}
interface EventRaw {
  id: string
  title: string
  start: number
  end: number
  organizer: Person
  attendees: Array<Person & { response: string }>
  location: string
  notes: string
}

async function loadRaw(ctx: Ctx, type: RawType, rawId: string): Promise<ImRaw | MailRaw | EventRaw | null> {
  const db = ctx.db
  if (type === 'im') {
    const row = db.prepare('SELECT id, session_id, sender_id, sender_name, time, text FROM im_messages WHERE id = ?').get(rawId) as unknown as
      | { id: string; session_id: string; sender_id: string; sender_name: string; time: number; text: string }
      | undefined
    if (row) return { id: row.id, sessionId: row.session_id, senderId: row.sender_id, senderName: row.sender_name, time: row.time, text: row.text }
    const m = await ctx.source.findMessage?.(rawId)
    return m ? { id: m.id, sessionId: m.sessionId, senderId: m.senderId, senderName: m.senderName, time: m.time, text: m.text } : null
  }
  if (type === 'mail') {
    const row = db.prepare('SELECT id, subject, sender, recipients, cc, time, text, folder FROM mails WHERE id = ?').get(rawId) as unknown as Record<string, unknown> | undefined
    if (row) {
      return {
        id: row.id as string,
        subject: row.subject as string,
        from: JSON.parse(row.sender as string) as MailAddress,
        to: JSON.parse(row.recipients as string) as MailAddress[],
        cc: JSON.parse(row.cc as string) as MailAddress[],
        time: row.time as number,
        text: row.text as string,
        folder: row.folder as string,
      }
    }
    const m = await ctx.source.findMail?.(rawId)
    return m ? { id: m.id, subject: m.subject, from: m.from, to: m.to, cc: m.cc, time: m.time, text: m.text, folder: m.folder } : null
  }
  const row = db.prepare('SELECT id, title, start, end, organizer, attendees, location, notes FROM events WHERE id = ?').get(rawId) as unknown as Record<string, unknown> | undefined
  if (row) {
    return {
      id: row.id as string,
      title: row.title as string,
      start: row.start as number,
      end: row.end as number,
      organizer: JSON.parse(row.organizer as string) as Person,
      attendees: JSON.parse(row.attendees as string) as Array<Person & { response: string }>,
      location: row.location as string,
      notes: row.notes as string,
    }
  }
  const e = await ctx.source.findEvent?.(rawId)
  return e ? { id: e.id, title: e.title, start: e.start, end: e.end, organizer: e.organizer, attendees: e.attendees, location: e.location, notes: e.notes } : null
}

function fmtAddr(a: MailAddress): string {
  return a.name && a.name !== a.address ? `${a.name} <${a.address}>` : a.address
}

/** 同一小时条目下的丢失原文汇总（票 11）：只出一个降级框，取最先判定那条的原因，原因不同标 mixed */
interface LostInfo {
  firstType: RawType
  firstId: string
  reason: LostReason
  count: number
  mixed: boolean
}

async function lostRawsOf(ctx: Ctx, cache: Map<string, Availability>, refs: RefRow[], approxTime: number): Promise<LostInfo | null> {
  let info: LostInfo | null = null
  for (const r of refs) {
    if (r.target_type === 'item' || r.raw_id === null) continue
    const type = r.target_type as RawType
    const av = await rawAvailability(ctx, cache, type, r.raw_id, approxTime)
    if (av.available) continue
    if (info === null) {
      info = { firstType: type, firstId: r.raw_id, reason: av.reason, count: 1, mixed: false }
    } else {
      info.count++
      if (av.reason !== info.reason) info.mixed = true
    }
  }
  return info
}

function lostNode(info: LostInfo, text: string, generatedAt: number): EvidenceNode {
  return {
    kind: 'lost',
    rawType: info.firstType,
    id: info.firstId,
    reason: info.reason,
    count: info.count,
    text,
    generatedAt,
    ...(info.mixed ? { mixedReasons: true } : {}),
  }
}

async function rawNode(ctx: Ctx, r: RefRow, cache: Map<string, Availability>, approxTime: number, me: string): Promise<EvidenceNode> {
  const type = r.target_type as RawType
  const rawId = r.raw_id!
  const av = await rawAvailability(ctx, cache, type, rawId, approxTime)
  // 丢失的由调用方（emitRaws）合并成降级框，这里只渲染可用原文
  if (!av.available) throw new Error(`rawNode 只处理可用原文：${type} ${rawId}`)
  // 客户端未连接：只有 ID 的“原文暂不可读”节点（不判丢失、不降级）
  if ('clientUnavailable' in av) return { kind: 'unreadable', rawType: type, id: rawId }
  let raw: ImRaw | MailRaw | EventRaw | null
  if (av.raw !== undefined) {
    const m = av.raw
    raw =
      'sessionId' in m
        ? { id: m.id, sessionId: m.sessionId, senderId: m.senderId, senderName: m.senderName, time: m.time, text: m.text }
        : 'subject' in m
          ? { id: m.id, subject: m.subject, from: m.from, to: m.to, cc: m.cc, time: m.time, text: m.text, folder: m.folder }
          : { id: m.id, title: m.title, start: m.start, end: m.end, organizer: m.organizer, attendees: m.attendees, location: m.location, notes: m.notes }
  } else {
    raw = await loadRaw(ctx, type, rawId)
  }
  if (!raw) throw new Error(`原文读取不到：${type} ${rawId}`)
  if ('sessionId' in raw) {
    const s = ctx.db.prepare('SELECT name FROM sessions WHERE id = ?').get(raw.sessionId) as { name: string } | undefined
    return { kind: 'im', id: raw.id, session: s?.name ?? raw.sessionId, sender: raw.senderName, time: raw.time, text: raw.text, isMine: raw.senderId === me }
  }
  if ('subject' in raw) return { kind: 'mail', id: raw.id, subject: raw.subject, from: fmtAddr(raw.from), to: raw.to.map(fmtAddr).join('、'), time: raw.time }
  return { kind: 'event', id: raw.id, title: raw.title, start: raw.start, end: raw.end, attendeeCount: raw.attendees.length }
}

/** 展开时原文预算：最多 50 条，超出合成 {kind:'more'} */
const RAW_BUDGET = 50

interface TreeCtx {
  cache: Map<string, Availability>
  budget: { left: number }
  me: string
}

async function itemNode(ctx: Ctx, t: TreeCtx, r: RefRow, expand: boolean, seen: Set<string>): Promise<EvidenceNode> {
  const db = ctx.db
  if (r.target_type !== 'item' || r.target_version === null || r.target_item === null) {
    throw new Error(`引用不是下层条目：${r.target_type} ${r.raw_id}`)
  }
  const target = db
    .prepare(
      `SELECT v.id AS vid, v.version, v.created_at, s.level AS level, s.period AS period, s.current_version AS current_version
       FROM versions v JOIN series s ON s.id = v.series_id WHERE v.id = ?`,
    )
    .get(r.target_version) as unknown as { vid: number; version: number; created_at: number; level: Level; period: string; current_version: number } | undefined
  const itemRow = target && (db.prepare('SELECT text FROM items WHERE version_id = ? AND item_id = ?').get(target.vid, r.target_item) as { text: string } | undefined)
  if (!target || !itemRow) throw new Error(`下层条目不存在：版本 ${r.target_version} #${r.target_item}`)
  const node: Extract<EvidenceNode, { kind: 'item' }> = {
    kind: 'item',
    ref: { level: target.level, period: target.period, version: target.version, itemId: r.target_item },
    when: whenLabel(target.level, target.period),
    levelName: LEVEL_NAME[target.level],
    text: itemRow.text,
  }
  if (target.current_version > target.version) node.latestVersion = target.current_version

  const childRefs = refsOf(db, target.vid, r.target_item)
  if (target.level === 'hour') {
    const hourStart = periodRange('hour', target.period).from
    // 小时条目：有原文丢失就降级（ADR-0002：以本条文本作为“AI 当时概述”）；丢失的合并成一个降级框
    const lost = await lostRawsOf(ctx, t.cache, childRefs, hourStart)
    if (lost) node.degraded = { generatedAt: target.created_at, reason: lost.reason, count: lost.count }
    if (expand) {
      const children: EvidenceNode[] = []
      await emitRaws(ctx, t, children, childRefs, hourStart, itemRow.text, target.created_at)
      node.children = children
    }
  } else if (expand) {
    const children: EvidenceNode[] = []
    for (const cr of childRefs) {
      if (cr.target_type === 'item') {
        const key = `${cr.target_version}:${cr.target_item}`
        if (seen.has(key)) continue
        seen.add(key)
        children.push(await itemNode(ctx, t, cr, expand, seen))
      }
    }
    // 预算耗尽的提示由下层小时条目的 more 节点携带
    node.children = children
  }
  return node
}

/** 列一个小时条目的原文：丢失的合并成一个降级框（不占预算），可用的照常列出、最多到预算 */
async function emitRaws(ctx: Ctx, t: TreeCtx, children: EvidenceNode[], refs: RefRow[], approxTime: number, hourText: string, generatedAt: number): Promise<void> {
  const raws = refs.filter((r): r is RefRow & { target_type: 'im' | 'mail' | 'event'; raw_id: string } => r.target_type !== 'item' && r.raw_id !== null)
  const lost = await lostRawsOf(ctx, t.cache, raws, approxTime)
  if (lost) children.push(lostNode(lost, hourText, generatedAt))
  let i = 0
  for (; i < raws.length; i++) {
    if (t.budget.left <= 0) break
    const av = await rawAvailability(ctx, t.cache, raws[i].target_type, raws[i].raw_id, approxTime)
    if (!av.available) continue // 已并入降级框
    children.push(await rawNode(ctx, raws[i], t.cache, approxTime, t.me))
    t.budget.left--
  }
  if (i < raws.length) children.push({ kind: 'more', count: raws.length - i })
}

export async function evidenceTree(ctx: Ctx, ref: { level: Level; period: string; version?: number; itemId: number }, expandRaw: boolean): Promise<EvidenceResponse> {
  const db = ctx.db
  const series = getSeries(db, ref.level, ref.period)
  if (!series) throw new Error(`摘要不存在：${ref.level} ${ref.period}`)
  const versionNo = ref.version ?? series.current_version
  const bundle: VersionBundle | undefined = getVersion(db, series.id, versionNo)
  if (!bundle) throw new Error(`版本不存在：v${versionNo}`)
  const item = bundle.items.find((i) => i.item_id === ref.itemId)
  if (!item) throw new Error(`条目不存在：#${ref.itemId}`)
  const itemRefs = bundle.refs.filter((r) => r.item_id === ref.itemId)

  const t: TreeCtx = { cache: new Map(), budget: { left: RAW_BUDGET }, me: await meId(ctx) }
  const nodes: EvidenceNode[] = []
  let itemDegraded: EvidenceResponse['item']['degraded']
  if (ref.level === 'hour') {
    // 小时条目：丢失原文合并成一个降级框（票 11），根条目自身降级时 item 带 degraded
    const hourStart = periodRange('hour', ref.period).from
    const lost = await lostRawsOf(ctx, t.cache, itemRefs, hourStart)
    if (lost) itemDegraded = { generatedAt: bundle.meta.created_at, reason: lost.reason, count: lost.count }
    await emitRaws(ctx, t, nodes, itemRefs, hourStart, item.text, bundle.meta.created_at)
  } else {
    for (const r of itemRefs) {
      if (r.target_type !== 'item') continue
      nodes.push(await itemNode(ctx, t, r, expandRaw, new Set([`${bundle.meta.id}:${ref.itemId}`])))
    }
  }

  const totals = subtreeTotals(ctx, bundle.meta.id, ref.itemId)
  return {
    item: {
      level: ref.level,
      period: ref.period,
      version: versionNo,
      itemId: ref.itemId,
      text: item.text,
      levelName: LEVEL_NAME[ref.level],
      createdAt: bundle.meta.created_at,
      itemIndex: item.position,
      ...(itemDegraded ? { degraded: itemDegraded } : {}),
    },
    path: buildPath(ctx, bundle.meta.id, ref.itemId, ref.level, ref.period),
    totals,
    nodes,
  }
}

/** 汇总：直接引用的下层条目数、去重后的原文数、已降级的小时条目数（便宜规则） */
function subtreeTotals(ctx: Ctx, versionId: number, itemId: number): EvidenceResponse['totals'] {
  const db = ctx.db
  const now = ctx.clock.now()
  const ret = ctx.source.retentionDays
  const seenItems = new Set<string>()
  const raws = { im: new Set<string>(), mail: new Set<string>(), event: new Set<string>() }
  let items = 0
  let degraded = 0
  const visit = (vid: number, iid: number, isRoot: boolean) => {
    const key = `${vid}:${iid}`
    if (seenItems.has(key)) return
    seenItems.add(key)
    const info = versionInfo(db, vid)
    if (!info) return
    const refs = refsOf(db, vid, iid)
    if (isRoot) {
      // “依据 N 份下层摘要”数的是直接引用，和卡片上的“证据 n”保持一致；原文数仍按整条链去重
      for (const r of refs) if (r.target_type === 'item' && r.target_version !== null) items++
    }
    if (info.level === 'hour') {
      const hourStart = periodRange('hour', info.period).from
      if (hourItemDegraded(db, vid, iid, hourStart, now, ret)) degraded++
      for (const r of refs) {
        if (r.target_type !== 'item' && r.raw_id) (raws[r.target_type as 'im' | 'mail' | 'event'] as Set<string>).add(r.raw_id)
      }
    } else {
      for (const r of refs) {
        if (r.target_type === 'item' && r.target_version !== null) visit(r.target_version, r.target_item!, false)
      }
    }
  }
  visit(versionId, itemId, true)
  return { items, im: raws.im.size, mail: raws.mail.size, event: raws.event.size, degraded }
}

// ───────── 原文详情（api-types 第 4 节） ─────────

/** IM 上下文：同会话前后 30 分钟，本机 + 客户端合并去重 */
export async function imContext(ctx: Ctx, id: string): Promise<ImContextResponse | null> {
  const db = ctx.db
  const row = db.prepare('SELECT session_id, time FROM im_messages WHERE id = ?').get(id) as unknown as { session_id: string; time: number } | undefined
  let sessionId: string
  let time: number
  if (row) {
    sessionId = row.session_id
    time = row.time
  } else {
    const m = await ctx.source.findMessage?.(id)
    if (!m) return null
    sessionId = m.sessionId
    time = m.time
  }
  const from = time - 30 * 60_000
  const to = time + 30 * 60_000
  const me = await meId(ctx)
  const byId = new Map<string, { id: string; sender: string; time: number; text: string; isMine: boolean; isTarget: boolean }>()
  for (const r of db.prepare('SELECT id, sender_id, sender_name, time, text FROM im_messages WHERE session_id = ? AND time >= ? AND time < ? ORDER BY time').all(sessionId, from, to) as unknown as Array<Record<string, unknown>>) {
    byId.set(r.id as string, { id: r.id as string, sender: r.sender_name as string, time: r.time as number, text: r.text as string, isMine: r.sender_id === me, isTarget: r.id === id })
  }
  try {
    const clientMsgs: ImMessage[] = await ctx.source.messages({ from, to })
    for (const m of clientMsgs) {
      if (m.sessionId !== sessionId || byId.has(m.id)) continue
      byId.set(m.id, { id: m.id, sender: m.senderName, time: m.time, text: m.text, isMine: m.senderId === me, isTarget: m.id === id })
    }
  } catch (e) {
    if (!(e instanceof SourceUnavailableError)) throw e // 客户端不可用时只给本机的
  }
  const s = db.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as { name: string } | undefined
  return {
    session: s?.name ?? sessionId,
    messages: [...byId.values()].sort((a, b) => a.time - b.time),
  }
}

export async function mailDetail(ctx: Ctx, id: string): Promise<MailDetail | null> {
  const raw = (await loadRaw(ctx, 'mail', id)) as MailRaw | null
  if (!raw) return null
  return { id: raw.id, subject: raw.subject, from: fmtAddr(raw.from), to: raw.to.map(fmtAddr), cc: raw.cc.map(fmtAddr), time: raw.time, text: raw.text, folder: raw.folder }
}

export async function eventDetail(ctx: Ctx, id: string): Promise<EventDetail | null> {
  const raw = (await loadRaw(ctx, 'event', id)) as EventRaw | null
  if (!raw) return null
  return {
    id: raw.id,
    title: raw.title,
    start: raw.start,
    end: raw.end,
    location: raw.location,
    organizer: raw.organizer.name,
    attendees: raw.attendees.map((a) => ({ name: a.name, response: a.response })),
    notes: raw.notes,
  }
}

// ───────── 受缺口影响的条目（api-types 第 15 节） ─────────

interface DegradedHourItem {
  ref: ItemRef
  text: string
  lostTypes: Set<RawType>
  reason: LostReason
  usedBy: Array<{ ref: ItemRef; text: string }>
}

function scanDegraded(ctx: Ctx): DegradedHourItem[] {
  const db = ctx.db
  const now = ctx.clock.now()
  const ret = ctx.source.retentionDays
  const out: DegradedHourItem[] = []
  const hours = db
    .prepare(`SELECT s.period AS period, v.id AS vid, v.version AS version FROM series s
      JOIN versions v ON v.series_id = s.id AND v.version = s.current_version
      WHERE s.level = 'hour' AND s.current_version > 0 ORDER BY s.period`)
    .all() as unknown as Array<{ period: string; vid: number; version: number }>
  for (const h of hours) {
    const hourStart = periodRange('hour', h.period).from
    const rows = db
      .prepare(`SELECT i.item_id AS item_id, i.text AS text, r.target_type AS target_type, r.raw_id AS raw_id
        FROM items i JOIN refs r ON r.version_id = i.version_id AND r.item_id = i.item_id
        WHERE i.version_id = ? AND r.target_type != 'item' ORDER BY i.position`)
      .all(h.vid) as unknown as Array<{ item_id: number; text: string; target_type: 'im' | 'mail' | 'event'; raw_id: string }>
    const byItem = new Map<number, { text: string; lost: Array<{ type: RawType; rawId: string }> }>()
    for (const r of rows) {
      const entry = byItem.get(r.item_id) ?? { text: r.text, lost: [] }
      if (isRawLostCheap(db, r.target_type, r.raw_id, hourStart, now, ret[SOURCE_OF[r.target_type]])) entry.lost.push({ type: r.target_type, rawId: r.raw_id })
      byItem.set(r.item_id, entry)
    }
    for (const [itemId, { text, lost }] of byItem) {
      if (lost.length === 0) continue
      // 原因：优先 raw_lost 里已判定的，否则按天推
      let reason: LostReason | undefined
      for (const l of lost) {
        const rec = db.prepare('SELECT reason FROM raw_lost WHERE raw_type = ? AND raw_id = ?').get(l.type, l.rawId) as { reason: LostReason } | undefined
        if (rec) {
          reason = rec.reason
          break
        }
      }
      const first = lost[0]
      const usedBy = (
        db
          .prepare(
            `SELECT s.level AS level, s.period AS period, v.version AS version, r.item_id AS item_id, i.text AS text
             FROM refs r
             JOIN versions v ON v.id = r.version_id
             JOIN series s ON s.id = v.series_id AND s.current_version = v.version
             JOIN items i ON i.version_id = v.id AND i.item_id = r.item_id
             WHERE r.target_type = 'item' AND r.target_version = ? AND r.target_item = ?`,
          )
          .all(h.vid, itemId) as unknown as Array<{ level: Level; period: string; version: number; item_id: number; text: string }>
      ).map((u) => ({ ref: { level: u.level, period: u.period, version: u.version, itemId: u.item_id }, text: u.text }))
      out.push({
        ref: { level: 'hour', period: h.period, version: h.version, itemId },
        text,
        lostTypes: new Set(lost.map((l) => l.type)),
        reason: reason ?? lostReasonFor(db, first.type, hourStart),
        usedBy,
      })
    }
  }
  return out
}

export function affectedItems(ctx: Ctx): AffectedResponse['items'] {
  return scanDegraded(ctx).map((d) => ({ ref: d.ref, text: d.text, reason: d.reason, usedBy: d.usedBy }))
}

/** 覆盖页的 degradedItems：受该来源原文丢失影响的小时条目数（api-types 第 14 节） */
export function degradedItemCount(ctx: Ctx, type: RawType): number {
  return scanDegraded(ctx).filter((d) => d.lostTypes.has(type)).length
}
