// 版本对比（spec 第 8 节）：同一增量链按编号逐条 edit/add/delete/same，否则全文对比。
// 版本列表的变更计数和输入说明（"并入周四日结"、"收尾"、"手动重建"）也在这里算。
import type { DiffResponse } from '../api-types.js'
import type { Db } from '../db/db.js'
import { WEEKDAY_ZH, local, periodRange } from '../time.js'
import { getVersion } from './store.js'
import type { VersionMetaRow } from './store.js'

/**
 * 同一增量链：区间 (a, b] 里的版本全部是增量生成（b 建立在 a 的条目编号体系上）。
 * 只要中间有一个全量版本，编号体系就断了，只能全文对比。
 */
export function sameIncrementalChain(db: Db, seriesId: number, a: number, b: number): boolean {
  for (let v = b; v > a; v--) {
    const row = db.prepare('SELECT mode FROM versions WHERE series_id = ? AND version = ?').get(seriesId, v) as { mode: string } | undefined
    if (!row || row.mode !== 'incremental') return false
  }
  return true
}

/** 对比两个版本（a 在前 b 在后） */
export function diffVersions(db: Db, seriesId: number, a: number, b: number): DiffResponse {
  const va = getVersion(db, seriesId, a)
  const vb = getVersion(db, seriesId, b)
  if (!va || !vb) throw new Error(`版本不存在：v${!va ? a : b}`)
  if (!sameIncrementalChain(db, seriesId, a, b)) {
    return { mode: 'fulltext', a: va.items.map((i) => i.text), b: vb.items.map((i) => i.text) }
  }
  const aById = new Map(va.items.map((i) => [i.item_id, i]))
  const bIds = new Set(vb.items.map((i) => i.item_id))
  const rows: Extract<DiffResponse, { mode: 'items' }>['rows'] = []
  for (const it of vb.items) {
    const prev = aById.get(it.item_id)
    if (!prev) rows.push({ kind: 'add', itemId: it.item_id, text: it.text })
    else if (prev.text !== it.text) rows.push({ kind: 'edit', itemId: it.item_id, before: prev.text, after: it.text })
    else rows.push({ kind: 'same', itemId: it.item_id, text: it.text })
  }
  for (const it of va.items) {
    if (!bIds.has(it.item_id)) rows.push({ kind: 'delete', itemId: it.item_id, text: it.text })
  }
  return { mode: 'items', rows }
}

/** 版本列表的变更计数：和上一版按编号对比。全量重建的新编号天然表现为全加全删 */
export function versionChanges(db: Db, seriesId: number, version: number): { added: number; edited: number; deleted: number } {
  const cur = getVersion(db, seriesId, version)
  if (!cur) return { added: 0, edited: 0, deleted: 0 }
  const prev = version > 1 ? getVersion(db, seriesId, version - 1) : undefined
  if (!prev) return { added: cur.items.length, edited: 0, deleted: 0 }
  const prevById = new Map(prev.items.map((i) => [i.item_id, i]))
  const curIds = new Set(cur.items.map((i) => i.item_id))
  let added = 0
  let edited = 0
  for (const it of cur.items) {
    const p = prevById.get(it.item_id)
    if (!p) added++
    else if (p.text !== it.text) edited++
  }
  const deleted = prev.items.filter((i) => !curIds.has(i.item_id)).length
  return { added, edited, deleted }
}

const INPUT_NOUN: Record<string, string> = { hour: '小时摘要', day: '日结', month: '月摘要' }

function inputShortLabel(level: string, period: string): string {
  if (level === 'hour') return `${period.slice(11)}:00`
  if (level === 'day') return WEEKDAY_ZH[local(periodRange('day', period).from).wd]
  if (level === 'month') return `${Number(period.slice(5))} 月`
  return period
}

/** 版本列表的输入说明，例如 "并入周四、周五日结"、"收尾"、"手动重建" */
export function inputNote(db: Db, meta: VersionMetaRow): string {
  if (meta.trigger === 'close') return '收尾'
  if (meta.mode === 'full') {
    if (meta.version === 1) return '首次生成'
    if (meta.trigger === 'manual') return '手动重建'
    return '全量生成'
  }
  if (meta.inputs.length === 0) return '无新输入'
  const labels: string[] = []
  let noun = ''
  for (const i of meta.inputs) {
    const s = db.prepare('SELECT level, period FROM series WHERE id = ?').get(i.seriesId) as { level: string; period: string } | undefined
    if (!s) continue
    const label = inputShortLabel(s.level, s.period)
    if (!labels.includes(label)) labels.push(label)
    noun = INPUT_NOUN[s.level] ?? '下层摘要'
  }
  if (labels.length === 0) return '无新输入'
  if (labels.length <= 2) return `并入${labels.join('、')}${noun}`
  return `并入 ${labels.length} 份${noun}`
}
