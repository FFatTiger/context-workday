// sim（票 09）：虚拟时钟快进 10 天，断言各层级版本、最终周摘要、降级条目和 gap_expired 覆盖。
import { mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { coverage } from '../src/backup/coverage.js'
import type { Config } from '../src/config.js'
import type { Ctx } from '../src/context.js'
import { openDb } from '../src/db/db.js'
import { createMockSource } from '../src/source/mock.js'
import { runSim } from '../src/sim.js'
import { ManualClock } from '../src/time.js'
import { fakeSummarizer } from './helpers.js'

function simConfig(dataDir: string): Config {
  return { dataDir, port: 0, host: '127.0.0.1', source: 'mock', sourceOptions: {}, llm: 'mock', demo: true }
}

describe('sim', () => {
  test('12 天：小时/日/周版本、最终周摘要、降级条目、gap_expired', { timeout: 240_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctx-sim-'))
    const stats = await runSim({ config: simConfig(dataDir), log: () => {}, days: 12 })

    expect(stats.versions.hour).toBeGreaterThan(0)
    expect(stats.versions.day).toBeGreaterThan(0)
    expect(stats.versions.week).toBeGreaterThan(0)
    // 10 天必然跨过一个周一，补跑会把上一周收尾成最终版
    expect(stats.finalVersions.week).toBeGreaterThanOrEqual(1)
    // 演示降级窗口：IM 备份中断那几天的小时条目，原文已超保留期且本机无备份
    expect(stats.degradedItems).toBeGreaterThanOrEqual(1)

    const db = openDb(join(dataDir, 'context.db'))
    try {
      // 结束时是一份正常的数据目录：7 个任务的配置都在
      expect((db.prepare('SELECT COUNT(*) AS n FROM jobs').get() as { n: number }).n).toBe(7)

      const clock = new ManualClock(Date.now())
      const ctx: Ctx = {
        db,
        clock,
        source: createMockSource({ options: {}, now: () => clock.now(), log: () => {} }),
        summarizer: fakeSummarizer(),
        config: simConfig(dataDir),
        log: () => {},
      }
      const cov = coverage(ctx, 'im', 14)
      const expired = cov.days.filter((d) => d.state === 'gap_expired')
      // 演示降级窗口开头 3 天（第 1–3 天）已永久丢失
      expect(expired.length).toBeGreaterThanOrEqual(3)
    } finally {
      db.close()
    }
  })

  test('只允许 mock 数据源', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctx-sim-'))
    const config = { ...simConfig(dataDir), source: './source/index.mjs', demo: false }
    await expect(runSim({ config, log: () => {}, days: 2 })).rejects.toThrow(/仿真数据源/)
    await expect(runSim({ config: simConfig(dataDir), log: () => {}, days: 0 })).rejects.toThrow(/--days/)
  })

  test('已有数据的目录拒绝运行，--force 放行', { timeout: 240_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ctx-sim-'))
    const dbPath = join(dataDir, 'context.db')
    const fd = openSync(dbPath, 'w')
    closeSync(fd)
    writeFileSync(dbPath, '')
    await expect(runSim({ config: simConfig(dataDir), log: () => {}, days: 2 })).rejects.toThrow(/已有数据/)
    const stats = await runSim({ config: simConfig(dataDir), log: () => {}, days: 1, force: true })
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
