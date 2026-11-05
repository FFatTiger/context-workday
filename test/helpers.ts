// 测试通用设施：内存库 + ManualClock + 假客户端的 Ctx。后面的票都复用。
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from '../src/config.js'
import type { Ctx } from '../src/context.js'
import { openDb } from '../src/db/db.js'
import type { Db } from '../src/db/db.js'
import type { DraftItem, HourlyInput, RollupInput, RollupOp, Summarizer } from '../src/llm/types.js'
import { ManualClock, fromLocal } from '../src/time.js'
import { FakeSource } from './fake-source.js'

/** 不联网的假模型（票 02 之前只占位） */
export function fakeSummarizer(): Summarizer {
  return {
    model: 'fake',
    endpoint: null,
    hourly: async () => [],
    rollupFull: async () => [],
    rollupIncremental: async () => [],
    ping: async () => ({ ok: true, ms: 0 }),
  }
}

/** 脚本化假摘要器：按调用顺序返回预设输出（元素是 Error 就抛出）；记录每次调用和 feedback */
export class ScriptedSummarizer implements Summarizer {
  readonly model = 'scripted'
  readonly endpoint = null
  hourlyScript: Array<DraftItem[] | Error> = []
  rollupFullScript: Array<DraftItem[] | Error> = []
  rollupIncrementalScript: Array<RollupOp[] | Error> = []
  hourlyCalls: Array<{ input: HourlyInput; feedback?: string }> = []
  rollupFullCalls: Array<{ input: RollupInput; feedback?: string }> = []
  rollupIncrementalCalls: Array<{ input: RollupInput; feedback?: string }> = []

  async hourly(input: HourlyInput, feedback?: string): Promise<DraftItem[]> {
    this.hourlyCalls.push({ input, feedback })
    return next(this.hourlyScript, 'hourly')
  }
  async rollupFull(input: RollupInput, feedback?: string): Promise<DraftItem[]> {
    this.rollupFullCalls.push({ input, feedback })
    return next(this.rollupFullScript, 'rollupFull')
  }
  async rollupIncremental(input: RollupInput, feedback?: string): Promise<RollupOp[]> {
    this.rollupIncrementalCalls.push({ input, feedback })
    return next(this.rollupIncrementalScript, 'rollupIncremental')
  }
  async ping(): Promise<{ ok: boolean; ms: number; error?: string }> {
    return { ok: true, ms: 0 }
  }
}

function next<T>(script: Array<T | Error>, what: string): T {
  const v = script.shift()
  if (v === undefined) throw new Error(`脚本化摘要器：${what} 的预设输出已用完`)
  if (v instanceof Error) throw v
  return v
}

export interface TestCtx {
  ctx: Ctx
  db: Db
  clock: ManualClock
  source: FakeSource
  dataDir: string
}

export function makeCtx(opts: { now?: number; dbPath?: string } = {}): TestCtx {
  const clock = new ManualClock(opts.now ?? fromLocal(2026, 10, 29, 20, 36))
  const source = new FakeSource()
  const dataDir = mkdtempSync(join(tmpdir(), 'ctx-test-'))
  const db = openDb(opts.dbPath ?? ':memory:')
  const config: Config = {
    dataDir,
    port: 0,
    host: '127.0.0.1',
    source: 'fake',
    sourceOptions: {},
    llm: 'mock',
    demo: false,
  }
  const ctx: Ctx = { db, clock, source, summarizer: fakeSummarizer(), config, log: () => {} }
  return { ctx, db, clock, source, dataDir }
}
