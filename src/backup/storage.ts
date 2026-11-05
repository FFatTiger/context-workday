// 存储统计与完整性（spec 第 9 节）。
// ponytail: 原文/摘要占用按各表文本列的字符数估算（中文 UTF-8 每字约 3 字节），不逐行取回；
// 证据引用等小表不计入。完整性 = 最近一次 IM 备份的核对结果。
import type { StorageResponse } from '../api-types.js'
import type { Ctx } from '../context.js'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { SELECT_RUN, type RunRow } from './run.js'

const BYTES_PER_CHAR = 3

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function chars(db: Ctx['db'], sql: string): number {
  const row = db.prepare(sql).get() as { n: number }
  return row.n
}

export function storage(ctx: Ctx): StorageResponse {
  const db = ctx.db
  const dbPath = join(ctx.config.dataDir, 'context.db')
  const totalBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`) + fileSize(`${dbPath}-shm`)

  const rawChars =
    chars(db, 'SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM im_messages') +
    chars(db, 'SELECT COALESCE(SUM(LENGTH(subject)) + SUM(LENGTH(text)), 0) AS n FROM mails') +
    chars(db, 'SELECT COALESCE(SUM(LENGTH(title)) + SUM(LENGTH(location)) + SUM(LENGTH(notes)), 0) AS n FROM events')
  const summaryChars = chars(db, 'SELECT COALESCE(SUM(LENGTH(text)), 0) AS n FROM items')

  const lastIm = db.prepare(`${SELECT_RUN} WHERE source = 'im' ORDER BY id DESC LIMIT 1`).get() as RunRow | undefined
  let integrity: StorageResponse['integrity'] = null
  if (lastIm) {
    if (lastIm.result === 'success') integrity = { at: lastIm.ended_at ?? lastIm.started_at, ok: true, note: '逐日核对一致' }
    else if (lastIm.result === 'partial') {
      const days = db.prepare('SELECT day FROM backup_days WHERE run_id = ? AND local_count < client_count ORDER BY day').all(lastIm.id) as Array<{ day: string }>
      integrity = { at: lastIm.ended_at ?? lastIm.started_at, ok: false, note: `${days.map((d) => d.day.slice(5)).join('、')} 核对不一致` }
    } else if (lastIm.result === 'failed') {
      integrity = { at: lastIm.ended_at ?? lastIm.started_at, ok: false, note: lastIm.error ?? '备份失败' }
    }
  }

  return { totalBytes, rawBytes: rawChars * BYTES_PER_CHAR, summaryBytes: summaryChars * BYTES_PER_CHAR, integrity }
}
