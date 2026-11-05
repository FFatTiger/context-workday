// sim（票 09）：虚拟时钟快进生成演示历史。
// 只跑 mock 数据源 + mock 摘要器：ManualClock 从 now-days 的 0 点拨到真实的现在，
// 每小时拨一格后 await scheduler.tick()，让备份、小时摘要、日结、周月增量按调度规则自然发生。
// 结束时数据库就是一份正常的数据目录：context-workday start --demo --data 同一目录 可直接接着用
// （调度器启动补跑会把 sim 结束到真实现在之间的空隙补上）。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Config } from './config.js'
import type { Ctx } from './context.js'
import { openDb } from './db/db.js'
import { startScheduler } from './jobs/scheduler.js'
import { createSummarizer } from './llm/index.js'
import { LEVEL_NAME, degradedItemCount } from './summary/evidence.js'
import { loadSource } from './source/load.js'
import { SourceUnavailableError } from './source/types.js'
import type { SourceAdapter, TimeRange } from './source/types.js'
import { DAY_MS, HOUR_MS, dayKey, startOfDay } from './time.js'
import { ManualClock } from './time.js'
import type { Level } from './time.js'

export interface SimOptions {
  config: Config
  log?: (message: string) => void
  days: number
  /** 数据目录已有数据时仍继续 */
  force?: boolean
}

export interface SimStats {
  versions: Record<Level, number>
  finalVersions: Record<Level, number>
  /** 被引原文已丢失的小时条目数（演示降级窗口的产物） */
  degradedItems: number
  elapsedMs: number
}

const LEVELS: Level[] = ['hour', 'day', 'week', 'month', 'year']
const zeroLevels = (): Record<Level, number> => ({ hour: 0, day: 0, week: 0, month: 0, year: 0 })

/**
 * 演示手段（不是产品功能）：让 IM 备份中断一段，备份页出现“已过期”的红色缺口，
 * 对应日子的小时条目在证据链里显示降级。窗口内跨度超过 2 小时的 messages() 抛
 * SourceUnavailableError，小时摘要的 1 小时查询不受影响。
 * 45 天演示：第 days-20 到 days-11 天断 9 天，恢复后水位只回 7 天保留期，
 * 开头两三天永久丢失；小天数（< 31）：第 1 天起断 10 天（或到结束），效果相同。
 */
function degradeDemoSource(src: SourceAdapter, clock: ManualClock, winFrom: number, winTo: number): SourceAdapter {
  return {
    ...src,
    async messages(range: TimeRange) {
      const now = clock.now()
      if (now >= winFrom && now < winTo && range.to - range.from > 2 * HOUR_MS) {
        throw new SourceUnavailableError(`仿真演示：${dayKey(winFrom)} 起 IM 客户端不可用`)
      }
      return src.messages(range)
    },
  }
}

export async function runSim(opts: SimOptions): Promise<SimStats> {
  const { config } = opts
  const log = opts.log ?? ((m: string) => console.log(m))
  const days = Math.floor(opts.days)
  if (config.source !== 'mock') throw new Error('sim 只支持仿真数据源（--demo）；真实数据源请直接 context-workday start')
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new Error('--days 需在 1 到 365 之间')
  const dbPath = join(config.dataDir, 'context.db')
  if (existsSync(dbPath) && !opts.force) throw new Error(`数据目录已有数据（${dbPath}），拒绝运行；确认要重来请加 --force`)

  const startedAt = Date.now()
  const realNow = Date.now()
  const t0 = startOfDay(realNow - days * DAY_MS)
  const clock = new ManualClock(t0)
  const rawSource = await loadSource('mock', { options: config.sourceOptions, now: () => clock.now(), log }, config.dataDir)
  const winFromDays = days >= 31 ? days - 20 : 1
  const winToDays = days >= 31 ? days - 11 : Math.min(11, days)
  const source = degradeDemoSource(rawSource, clock, t0 + winFromDays * DAY_MS, t0 + winToDays * DAY_MS)

  const ctx: Ctx = {
    db: openDb(dbPath),
    clock,
    source,
    summarizer: createSummarizer('mock'),
    config,
    log,
  }
  // 演示库只需进程级崩溃安全（WAL + NORMAL），避免几千次事务的 fsync 把快进拖慢
  ctx.db.exec('PRAGMA synchronous = NORMAL')

  // 启动补跑（安装时第一次备份 + 过去 7 天的小时摘要）在第一次 tick 里完成。
  // 定时器间隔放到最大：sim 完全由拨钟驱动。
  const scheduler = startScheduler(ctx, { intervalMs: 2 ** 31 - 1 })
  const countVersions = (from: number, to: number) =>
    (ctx.db.prepare('SELECT COUNT(*) AS n FROM versions WHERE created_at >= ? AND created_at < ?').get(from, to) as { n: number }).n

  // 从每小时的第 6 分钟起拨（小时摘要在 :05 到期），直到真实的现在
  let curDay = t0
  for (let t = t0 + 6 * 60_000; ; t += HOUR_MS) {
    clock.set(Math.min(t, realNow))
    await scheduler.tick()
    const dayStart = startOfDay(clock.now())
    if (dayStart !== curDay) {
      log(`${dayKey(curDay)} 本日 ${countVersions(curDay, curDay + DAY_MS)} 个版本`)
      curDay = dayStart
    }
    if (clock.now() >= realNow) break
  }
  log(`${dayKey(curDay)} 本日 ${countVersions(curDay, curDay + DAY_MS)} 个版本`)

  scheduler.stop()

  const versions = zeroLevels()
  for (const row of ctx.db.prepare('SELECT s.level AS level, COUNT(*) AS n FROM versions v JOIN series s ON s.id = v.series_id GROUP BY s.level').all() as Array<{ level: Level; n: number }>)
    versions[row.level] = row.n
  const finalVersions = zeroLevels()
  for (const row of ctx.db
    .prepare('SELECT s.level AS level, COUNT(*) AS n FROM versions v JOIN series s ON s.id = v.series_id WHERE v.is_final = 1 GROUP BY s.level')
    .all() as Array<{ level: Level; n: number }>)
    finalVersions[row.level] = row.n
  const degradedItems = degradedItemCount(ctx, 'im')
  const elapsedMs = Date.now() - startedAt

  ctx.db.close()
  const parts = (o: Record<Level, number>) =>
    LEVELS.filter((l) => o[l] > 0).map((l) => `${LEVEL_NAME[l]} ${o[l]}`).join(' · ')
  log(`sim 完成：${parts(versions)}；最终版 ${parts(finalVersions) || '无'}；降级小时条目 ${degradedItems} 个；耗时 ${(elapsedMs / 1000).toFixed(1)} 秒`)
  return { versions, finalVersions, degradedItems, elapsedMs }
}
