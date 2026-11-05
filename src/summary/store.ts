// 摘要系列的读写（spec 第 8、12 节）：系列、版本、条目、引用。
// 一个版本连同条目、引用在一个 tx() 里写完，失败不占版本号（spec 14）。
// 条目编号在系列内永不复用：keep/edit 沿用原编号，add 从 next_item_id 分配。
import type { GenMode, Level, Trigger } from '../api-types.js'
import type { Db } from '../db/db.js'
import { tx } from '../db/db.js'

export type SeriesState = 'idle' | 'generating' | 'failed'

export interface SeriesRow {
  id: number
  level: Level
  period: string
  current_version: number
  is_final: number
  upstream_changed: number
  next_item_id: number
  state: SeriesState
  last_error: string | null
}

const SELECT_SERIES = 'SELECT id, level, period, current_version, is_final, upstream_changed, next_item_id, state, last_error FROM series'

export function getSeries(db: Db, level: Level, period: string): SeriesRow | undefined {
  return db.prepare(`${SELECT_SERIES} WHERE level = ? AND period = ?`).get(level, period) as unknown as SeriesRow | undefined
}

export function ensureSeries(db: Db, level: Level, period: string): SeriesRow {
  db.prepare('INSERT INTO series (level, period) VALUES (?, ?) ON CONFLICT(level, period) DO NOTHING').run(level, period)
  return getSeries(db, level, period)!
}

/**
 * 系列级互斥：已经在 generating 就抛"正在生成"（spec：同一系列串行）。
 * 成功路径由 saveVersion 收尾（state=idle）；失败调 failGeneration；无内容跳过调 releaseGeneration。
 */
export function beginGeneration(db: Db, level: Level, period: string): SeriesRow {
  const s = ensureSeries(db, level, period)
  if (s.state === 'generating') throw new Error(`正在生成 ${level} ${period}`)
  db.prepare("UPDATE series SET state = 'generating' WHERE id = ?").run(s.id)
  return { ...s, state: 'generating' }
}

export function failGeneration(db: Db, seriesId: number, error: string): void {
  db.prepare("UPDATE series SET state = 'failed', last_error = ? WHERE id = ?").run(error, seriesId)
}

/** 没有生成任何版本就结束（跳过）：状态回到 idle，不占版本号 */
export function releaseGeneration(db: Db, seriesId: number): void {
  db.prepare("UPDATE series SET state = 'idle' WHERE id = ?").run(seriesId)
}

// ───────── 版本写入 ─────────

export type RefSpec =
  | { type: 'im' | 'mail' | 'event'; rawId: string }
  | { type: 'item'; versionId: number; itemId: number }

export interface SaveItem {
  /** keep/edit：沿用系列内已有编号；add：不填，由系统分配 */
  itemId?: number
  text: string
  op: 'keep' | 'edit' | 'add'
  refs: RefSpec[]
}

export interface SaveVersionInput {
  level: Level
  period: string
  createdAt: number
  trigger: Trigger
  mode: GenMode
  model: string
  /** 用到的下层版本 {seriesId, version}；小时摘要为空数组 */
  inputs: Array<{ seriesId: number; version: number }>
  /** 仅小时版本 */
  totalMsgs?: number
  relatedMsgs?: number
  isFinal?: boolean
  items: SaveItem[]
}

/** 返回新版本号 */
export function saveVersion(db: Db, input: SaveVersionInput): number {
  return tx(db, () => {
    const s = ensureSeries(db, input.level, input.period)
    const version = s.current_version + 1
    const r = db
      .prepare('INSERT INTO versions (series_id, version, created_at, trigger, mode, inputs, model, total_msgs, related_msgs, is_final) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, version, input.createdAt, input.trigger, input.mode, JSON.stringify(input.inputs), input.model, input.totalMsgs ?? null, input.relatedMsgs ?? null, input.isFinal ? 1 : 0)
    const versionId = Number(r.lastInsertRowid)

    // 上一版同条目的引用算"旧引用"，本次新增的标 is_new（spec 5：修改的条目保留旧引用、追加新引用）
    const prevRefKeys = new Set<string>()
    if (s.current_version > 0) {
      const prev = db.prepare('SELECT id FROM versions WHERE series_id = ? AND version = ?').get(s.id, s.current_version) as { id: number } | undefined
      if (prev) {
        for (const row of db.prepare('SELECT item_id, target_type, target_version, target_item, raw_id FROM refs WHERE version_id = ?').all(prev.id) as unknown as Array<RefRow>) {
          prevRefKeys.add(`${row.item_id}\u0000${row.target_type}\u0000${row.target_version}\u0000${row.target_item}\u0000${row.raw_id}`)
        }
      }
    }

    let nextItemId = s.next_item_id
    const insItem = db.prepare('INSERT INTO items (version_id, item_id, position, text, op) VALUES (?,?,?,?,?)')
    const insRef = db.prepare('INSERT INTO refs (version_id, item_id, target_type, target_version, target_item, raw_id, is_new) VALUES (?,?,?,?,?,?,?)')
    let position = 0
    for (const it of input.items) {
      position++
      const itemId = it.itemId ?? nextItemId++
      insItem.run(versionId, itemId, position, it.text, it.op)
      for (const ref of it.refs) {
        const targetType = ref.type
        const targetVersion = ref.type === 'item' ? ref.versionId : null
        const targetItem = ref.type === 'item' ? ref.itemId : null
        const rawId = ref.type === 'item' ? null : ref.rawId
        const old = prevRefKeys.has(`${itemId}\u0000${targetType}\u0000${targetVersion}\u0000${targetItem}\u0000${rawId}`)
        insRef.run(versionId, itemId, targetType, targetVersion, targetItem, rawId, old ? 0 : 1)
      }
    }

    db.prepare('UPDATE series SET current_version = ?, next_item_id = ?, is_final = MAX(is_final, ?), upstream_changed = 0, state = ?, last_error = NULL WHERE id = ?')
      .run(version, nextItemId, input.isFinal ? 1 : 0, 'idle', s.id)

    // 给"当前版本用到了本系列"的上层系列标上游已变更（spec 8）；新版本是刚生成的，所以它们引用的一定是旧版本
    markUpstreamChanged(db, s.id)
    return version
  })
}

function markUpstreamChanged(db: Db, seriesId: number): void {
  const uppers = db
    .prepare(`SELECT s.id AS sid, v.inputs AS inputs FROM series s
      JOIN versions v ON v.series_id = s.id AND v.version = s.current_version
      WHERE s.id != ? AND v.inputs != '[]'`)
    .all(seriesId) as unknown as Array<{ sid: number; inputs: string }>
  for (const u of uppers) {
    let inputs: Array<{ seriesId: number }>
    try {
      inputs = JSON.parse(u.inputs)
    } catch {
      continue
    }
    if (inputs.some((i) => i.seriesId === seriesId)) db.prepare('UPDATE series SET upstream_changed = 1 WHERE id = ?').run(u.sid)
  }
}

// ───────── 版本读取 ─────────

export interface VersionMetaRow {
  id: number
  series_id: number
  version: number
  created_at: number
  trigger: Trigger
  mode: GenMode
  inputs: Array<{ seriesId: number; version: number }>
  model: string
  total_msgs: number | null
  related_msgs: number | null
  is_final: number
}

export interface ItemRow {
  item_id: number
  position: number
  text: string
  op: 'keep' | 'edit' | 'add'
}

export interface RefRow {
  item_id: number
  target_type: 'item' | 'im' | 'mail' | 'event'
  target_version: number | null
  target_item: number | null
  raw_id: string | null
  is_new: number
}

export interface VersionBundle {
  meta: VersionMetaRow
  items: ItemRow[]
  refs: RefRow[]
}

function rowToMeta(row: Record<string, unknown>): VersionMetaRow {
  return {
    id: row.id as number,
    series_id: row.series_id as number,
    version: row.version as number,
    created_at: row.created_at as number,
    trigger: row.trigger as Trigger,
    mode: row.mode as GenMode,
    inputs: JSON.parse(row.inputs as string) as Array<{ seriesId: number; version: number }>,
    model: row.model as string,
    total_msgs: (row.total_msgs as number | null) ?? null,
    related_msgs: (row.related_msgs as number | null) ?? null,
    is_final: row.is_final as number,
  }
}

const SELECT_VERSION = 'SELECT id, series_id, version, created_at, trigger, mode, inputs, model, total_msgs, related_msgs, is_final FROM versions'

function loadBundle(db: Db, where: string, ...args: Array<string | number>): VersionBundle | undefined {
  const meta = db.prepare(`${SELECT_VERSION} ${where}`).get(...args) as unknown as Record<string, unknown> | undefined
  if (!meta) return undefined
  const versionId = meta.id as number
  const items = db.prepare('SELECT item_id, position, text, op FROM items WHERE version_id = ? ORDER BY position').all(versionId) as unknown as ItemRow[]
  const refs = db
    .prepare('SELECT item_id, target_type, target_version, target_item, raw_id, is_new FROM refs WHERE version_id = ?')
    .all(versionId) as unknown as RefRow[]
  return { meta: rowToMeta(meta), items, refs }
}

export function getVersion(db: Db, seriesId: number, version: number): VersionBundle | undefined {
  return loadBundle(db, 'WHERE series_id = ? AND version = ?', seriesId, version)
}

export function getVersionById(db: Db, versionId: number): VersionBundle | undefined {
  return loadBundle(db, 'WHERE id = ?', versionId)
}

export function getCurrentVersion(db: Db, seriesId: number): VersionBundle | undefined {
  const s = db.prepare('SELECT current_version FROM series WHERE id = ?').get(seriesId) as { current_version: number } | undefined
  if (!s || s.current_version === 0) return undefined
  return getVersion(db, seriesId, s.current_version)
}

/** 版本列表（旧 → 新）。03 票的版本列表接口在此基础上补变更计数 */
export function listVersions(db: Db, seriesId: number): VersionMetaRow[] {
  return (db.prepare(`${SELECT_VERSION} WHERE series_id = ? ORDER BY version`).all(seriesId) as unknown as Array<Record<string, unknown>>).map(rowToMeta)
}
