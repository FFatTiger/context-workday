// 调度测试：规则校验和 nextRun/prevRun（跨天、跨月、周日）、jobs 表默认值与修改、
// spec 测试 11（睡眠 3 小时后启动按顺序补齐、超 7 天不追）、同一任务并发被拒、
// 停用后到点不跑、备份失败后下一个整点重试、中断标记。
import { describe, expect, it } from 'vitest'
import { backupProgress, runBackup } from '../src/backup/run.js'
import type { Summarizer } from '../src/llm/types.js'
import type { RollupOp } from '../src/llm/types.js'
import { getJobRunner } from '../src/jobs/registry.js'
import { DEFAULT_RULES, JOB_NAMES, ensureJobs, getJob, listJobs, nextRun, prevRun, saveJob, validateRule } from '../src/jobs/rules.js'
import { startScheduler } from '../src/jobs/scheduler.js'
import { getSeries, getVersion } from '../src/summary/store.js'
import { fromLocal } from '../src/time.js'
import { makeCtx, type TestCtx } from './helpers.js'

const day = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi)
const row = (db: TestCtx['db'], sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as Record<string, unknown>
const rows = (db: TestCtx['db'], sql: string, ...args: Array<string | number>) => db.prepare(sql).all(...args) as Array<Record<string, unknown>>

/** 确定性的假模型：每个可引用输入行各出一条引用它的条目 */
function echoSummarizer(): Summarizer {
  return {
    model: 'echo',
    endpoint: null,
    async hourly(input) {
      return input.lines.filter((l) => !l.contextOnly).slice(0, input.maxItems).map((l, i) => ({ text: `做了 ${i + 1}`, refs: [l.ref] }))
    },
    async rollupFull(input) {
      return input.inputs.slice(0, input.maxItems).map((it, i) => ({ text: `汇总 ${i + 1}`, refs: [it.ref] }))
    },
    async rollupIncremental(input) {
      const ops: RollupOp[] = input.previous.map((p) => ({ op: 'keep' as const, id: p.id }))
      for (const it of input.inputs.slice(0, input.maxItems)) ops.push({ op: 'add' as const, text: `新增 ${it.from}`, refs: [it.ref] })
      return ops
    },
    async ping() {
      return { ok: true, ms: 0 }
    },
  }
}

/** 群里一条我开口的消息 → 该小时与我有关 */
function myMessage(t: TestCtx, id: string, at: number) {
  if (!t.source.sessionsList.some((s) => s.id === 'g1')) t.source.addSession('g1', '群 1')
  t.source.addMsg({ id, sessionId: 'g1', senderId: 'u_me', time: at, text: `推进 ${id}` })
}

describe('规则：校验（spec 第 2 节允许范围，中文提示）', () => {
  it('小时摘要：分钟 1–30', () => {
    expect(validateRule('hourly', { type: 'hourly', minute: 5 })).toEqual({ type: 'hourly', minute: 5 })
    expect(() => validateRule('hourly', { type: 'hourly', minute: 0 })).toThrow('小时摘要时间需在第 1 到 30 分之间')
    expect(() => validateRule('hourly', { type: 'hourly', minute: 31 })).toThrow('小时摘要时间需在第 1 到 30 分之间')
    expect(() => validateRule('hourly', { type: 'daily', hour: 20, minute: 30 })).toThrow('小时摘要需为每小时的时间规则')
  })

  it('日结：12:00–23:59；补跑：00:00–05:59', () => {
    expect(validateRule('daily', { type: 'daily', hour: 23, minute: 59 })).toEqual({ type: 'daily', hour: 23, minute: 59 })
    expect(() => validateRule('daily', { type: 'daily', hour: 3, minute: 0 })).toThrow('日结时间需在 12:00 到 23:59 之间')
    expect(() => validateRule('daily', { type: 'daily', hour: 11, minute: 59 })).toThrow('日结时间需在 12:00 到 23:59 之间')
    expect(() => validateRule('daily', { type: 'weekly', weekday: 7, hour: 20, minute: 30 })).toThrow('日结需为每天的时间规则')
    expect(validateRule('catchup', { type: 'daily', hour: 5, minute: 59 })).toEqual({ type: 'daily', hour: 5, minute: 59 })
    expect(() => validateRule('catchup', { type: 'daily', hour: 6, minute: 0 })).toThrow('补跑时间需在 00:00 到 05:59 之间')
  })

  it('年摘要：每月 1–28 日；备份任务时间任意但格式要合法', () => {
    expect(validateRule('yearly', { type: 'monthly', day: 28, hour: 3, minute: 0 })).toEqual({ type: 'monthly', day: 28, hour: 3, minute: 0 })
    expect(() => validateRule('yearly', { type: 'monthly', day: 29, hour: 3, minute: 0 })).toThrow('年摘要日期需在 1 到 28 日之间')
    expect(() => validateRule('yearly', { type: 'daily', hour: 3, minute: 0 })).toThrow('年摘要需为每月的时间规则')
    expect(validateRule('backup_im', { type: 'weekly', weekday: 3, hour: 2, minute: 0 })).toEqual({ type: 'weekly', weekday: 3, hour: 2, minute: 0 })
    expect(() => validateRule('backup_im', { type: 'daily', hour: 24, minute: 0 })).toThrow('小时需在 0 到 23 之间')
    expect(() => validateRule('backup_mail', { type: 'weekly', weekday: 8, hour: 3, minute: 0 })).toThrow('星期需在 1 到 7 之间（1=周一）')
    expect(() => validateRule('backup_im', { type: 'monthly', day: 31, hour: 2, minute: 0 })).toThrow('日期需在 1 到 28 日之间')
  })
})

describe('规则：nextRun / prevRun（上海时区）', () => {
  it('daily：当天已过取明天（跨天）；恰好在运行时刻上也算已过', () => {
    expect(nextRun({ type: 'daily', hour: 20, minute: 30 }, day(2026, 11, 3, 20, 36))).toBe(day(2026, 11, 4, 20, 30))
    expect(nextRun({ type: 'daily', hour: 20, minute: 30 }, day(2026, 11, 3, 20, 30))).toBe(day(2026, 11, 4, 20, 30))
    expect(nextRun({ type: 'daily', hour: 20, minute: 30 }, day(2026, 11, 3, 20, 29))).toBe(day(2026, 11, 3, 20, 30))
  })

  it('hourly：本小时的分已过取下一小时', () => {
    expect(nextRun({ type: 'hourly', minute: 5 }, day(2026, 11, 3, 20, 7))).toBe(day(2026, 11, 3, 21, 5))
    expect(nextRun({ type: 'hourly', minute: 5 }, day(2026, 11, 3, 20, 4))).toBe(day(2026, 11, 3, 20, 5))
  })

  it('weekly：周一取下周日；monthly：11 月中旬取 12 月 1 日、1 月底取 2 月 28 日（跨月）', () => {
    expect(nextRun({ type: 'weekly', weekday: 7, hour: 3, minute: 0 }, day(2026, 11, 2, 10, 0))).toBe(day(2026, 11, 8, 3, 0))
    expect(nextRun({ type: 'monthly', day: 1, hour: 3, minute: 0 }, day(2026, 11, 15, 10, 0))).toBe(day(2026, 12, 1, 3, 0))
    expect(nextRun({ type: 'monthly', day: 28, hour: 3, minute: 0 }, day(2026, 1, 31, 10, 0))).toBe(day(2026, 2, 28, 3, 0))
  })

  it('prevRun：当天还没到取昨天/上个周期', () => {
    expect(prevRun({ type: 'daily', hour: 2, minute: 0 }, day(2026, 11, 3, 2, 10))).toBe(day(2026, 11, 3, 2, 0))
    expect(prevRun({ type: 'daily', hour: 2, minute: 0 }, day(2026, 11, 3, 1, 50))).toBe(day(2026, 11, 2, 2, 0))
    expect(prevRun({ type: 'weekly', weekday: 7, hour: 3, minute: 0 }, day(2026, 11, 2, 10, 0))).toBe(day(2026, 11, 1, 3, 0))
    expect(prevRun({ type: 'monthly', day: 1, hour: 3, minute: 0 }, day(2026, 11, 1, 2, 0))).toBe(day(2026, 10, 1, 3, 0))
  })
})

describe('jobs 表：默认规则与修改', () => {
  it('首次写入 7 个默认任务和下次运行时间', () => {
    const t = makeCtx()
    ensureJobs(t.db, day(2026, 11, 3, 10, 7))
    const jobs = listJobs(t.db)
    expect(jobs.map((j) => j.name)).toEqual(JOB_NAMES)
    expect(jobs.every((j) => j.enabled && j.rule)).toBe(true)
    expect(jobs.find((j) => j.name === 'hourly')!.nextRunAt).toBe(day(2026, 11, 3, 11, 5))
    expect(jobs.find((j) => j.name === 'daily')!.nextRunAt).toBe(day(2026, 11, 3, 20, 30))
    expect(jobs.find((j) => j.name === 'backup_im')!.nextRunAt).toBe(day(2026, 11, 4, 2, 0))
    expect(jobs.find((j) => j.name === 'backup_mail')!.nextRunAt).toBe(day(2026, 11, 8, 3, 0))
    // 重复调用不动已有配置
    saveJob(t.db, 'daily', { enabled: false }, day(2026, 11, 3, 10, 8))
    ensureJobs(t.db, day(2026, 11, 3, 10, 9))
    expect(getJob(t.db, 'daily')!.enabled).toBe(false)
  })

  it('停用后 nextRunAt=null，重新启用并改时间后立即重算', () => {
    const t = makeCtx()
    ensureJobs(t.db, day(2026, 11, 3, 10, 0))
    const off = saveJob(t.db, 'daily', { enabled: false }, day(2026, 11, 3, 10, 0))
    expect(off.enabled).toBe(false)
    expect(off.nextRunAt).toBeNull()
    const on = saveJob(t.db, 'daily', { enabled: true, rule: { type: 'daily', hour: 21, minute: 0 } }, day(2026, 11, 3, 10, 0))
    expect(on.nextRunAt).toBe(day(2026, 11, 3, 21, 0))
  })

  it('默认规则与 spec 第 2 节的表一致', () => {
    expect(DEFAULT_RULES.hourly).toEqual({ type: 'hourly', minute: 5 })
    expect(DEFAULT_RULES.daily).toEqual({ type: 'daily', hour: 20, minute: 30 })
    expect(DEFAULT_RULES.catchup).toEqual({ type: 'daily', hour: 0, minute: 30 })
    expect(DEFAULT_RULES.yearly).toEqual({ type: 'monthly', day: 1, hour: 3, minute: 0 })
    expect(DEFAULT_RULES.backup_im).toEqual({ type: 'daily', hour: 2, minute: 0 })
    expect(DEFAULT_RULES.backup_calendar).toEqual({ type: 'daily', hour: 2, minute: 0 })
    expect(DEFAULT_RULES.backup_mail).toEqual({ type: 'weekly', weekday: 7, hour: 3, minute: 0 })
  })
})

describe('启动补跑：spec 测试 11 —— 睡眠 3 小时后启动', () => {
  it('3 个小时摘要按先后补齐，触发方式是 startup；超过 7 天的小时不追', async () => {
    const t = makeCtx({ now: day(2026, 11, 3, 14, 5) }) // 周二 14:05，程序"睡"到此刻
    t.ctx.summarizer = echoSummarizer()
    myMessage(t, 'm09', day(2026, 11, 3, 9, 10))
    myMessage(t, 'm10', day(2026, 11, 3, 10, 10))
    myMessage(t, 'm11', day(2026, 11, 3, 11, 10))
    myMessage(t, 'm_old', day(2026, 10, 26, 10, 10)) // 8 天前，超出 7 天不追

    const sched = startScheduler(t.ctx, { intervalMs: 3_600_000 })
    await sched.tick() // 等启动补跑跑完
    sched.stop()

    const done = rows(t.db, "SELECT target, result, trigger FROM task_runs WHERE job = 'hourly' AND result = 'success' ORDER BY id").filter((r) => /^2026-11-03T\d{2}$/.test(r.target as string))
    expect(done.map((r) => r.target)).toEqual(['2026-11-03T09', '2026-11-03T10', '2026-11-03T11']) // 按时间先后
    expect(done.every((r) => r.trigger === 'startup')).toBe(true) // 触发方式"启动补跑"
    for (const h of ['T09', 'T10', 'T11']) {
      const s = getSeries(t.db, 'hour', `2026-11-03${h}`)!
      expect(s.current_version).toBe(1)
      expect(getVersion(t.db, s.id, 1)!.items.length).toBeGreaterThan(0)
    }
    expect(getSeries(t.db, 'hour', '2026-10-26T10')).toBeUndefined() // 超过 7 天不追
    // 日结时间（20:30）还没到，启动时不跑日结
    expect(rows(t.db, "SELECT * FROM task_runs WHERE job = 'daily'")).toHaveLength(0)
  })

  it('上次进程没跑完的运行记为中断', () => {
    const t = makeCtx()
    t.db.prepare("INSERT INTO task_runs (job, target, started_at, result, trigger) VALUES ('hourly', 'x', 1, 'running', 'scheduled')").run()
    t.db.prepare("INSERT INTO backup_runs (source, trigger, started_at, result) VALUES ('im', 'scheduled', 1, 'running')").run()
    const sched = startScheduler(t.ctx, { intervalMs: 3_600_000 })
    sched.stop()
    const tr = row(t.db, 'SELECT result, ended_at FROM task_runs WHERE id = 1')
    expect(tr.result).toBe('interrupted')
    expect(tr.ended_at).toBe(t.clock.now())
    const br = row(t.db, 'SELECT result, error FROM backup_runs WHERE id = 1')
    expect(br.result).toBe('failed')
    expect(br.error).toBe('程序退出时中断')
  })
})

describe('执行互斥与停用', () => {
  it('同一任务并发调用第二次被拒；跑完后可以再跑', async () => {
    const t = makeCtx({ now: day(2026, 11, 3, 10, 30) })
    t.ctx.summarizer = echoSummarizer()
    myMessage(t, 'm1', day(2026, 11, 3, 9, 10))
    const runner = getJobRunner(t.ctx)
    const p1 = runner.run('hourly', 'manual')
    expect(runner.isRunning('hourly')).toBe(true)
    expect(await runner.run('hourly', 'manual')).toBeUndefined() // 并发被拒
    const r1 = await p1
    expect(r1?.result).toBe('success')
    const r2 = await runner.run('hourly', 'manual') // 已跑完，可以再跑（此时没有待处理小时）
    expect(r2?.result).toBe('skipped')
  })

  it('停用的任务到点不跑；启用的任务到点按计划跑', async () => {
    // 停用：20:30 过后 tick，日结不跑
    const off = makeCtx({ now: day(2026, 11, 3, 20, 0) })
    off.ctx.summarizer = echoSummarizer()
    myMessage(off, 'm1', day(2026, 11, 3, 19, 10))
    ensureJobs(off.db, off.clock.now())
    saveJob(off.db, 'daily', { enabled: false }, off.clock.now())
    const s1 = startScheduler(off.ctx, { intervalMs: 3_600_000 })
    await s1.tick()
    off.clock.set(day(2026, 11, 3, 20, 35))
    await s1.tick()
    s1.stop()
    expect(rows(off.db, "SELECT * FROM task_runs WHERE job = 'daily'")).toHaveLength(0)

    // 启用（默认配置）：20:35 tick，日结按计划跑了
    const on = makeCtx({ now: day(2026, 11, 3, 20, 0) })
    on.ctx.summarizer = echoSummarizer()
    myMessage(on, 'm1', day(2026, 11, 3, 19, 10))
    const s2 = startScheduler(on.ctx, { intervalMs: 3_600_000 })
    await s2.tick()
    expect(rows(on.db, "SELECT * FROM task_runs WHERE job = 'daily'")).toHaveLength(0) // 启动时日结时间没过，不跑
    on.clock.set(day(2026, 11, 3, 20, 35))
    await s2.tick()
    s2.stop()
    const daily = row(on.db, "SELECT trigger, result, note FROM task_runs WHERE job = 'daily'")
    expect(daily.trigger).toBe('scheduled')
    expect(daily.result).toBe('success')
    expect(daily.note).toContain('日结 v1')
    expect(getJob(on.db, 'daily')!.nextRunAt).toBe(day(2026, 11, 4, 20, 30)) // 跑完重算下次运行
  })
})

describe('备份进度计数（BackupSourceStatus.progress.read）', () => {
  it('运行中累计已读取条数；失败时归零', async () => {
    const t = makeCtx({ now: day(2026, 11, 3, 10, 0) })
    myMessage(t, 'm1', day(2026, 11, 3, 9, 10))
    myMessage(t, 'm2', day(2026, 11, 3, 9, 40))
    const ok = await runBackup(t.ctx, 'im', 'scheduled')
    expect(ok.result).toBe('success')
    expect(backupProgress('im')).toBeGreaterThanOrEqual(2) // 主读 2 条 + 逐日核对的重读

    t.source.down = true
    const failed = await runBackup(t.ctx, 'im', 'scheduled')
    expect(failed.result).toBe('failed')
    expect(backupProgress('im')).toBe(0) // 每次运行重置
  })
})

describe('备份失败后整点重试（spec 第 9 节）', () => {
  it('失败后同一小时内不重试，进入新的小时自动 trigger=retry 重跑，直到成功', async () => {
    const t = makeCtx({ now: day(2026, 11, 3, 2, 0) })
    myMessage(t, 'm1', day(2026, 11, 3, 1, 10))
    t.source.down = true
    const failed = await runBackup(t.ctx, 'im', 'scheduled')
    expect(failed.result).toBe('failed')
    t.source.down = false

    const sched = startScheduler(t.ctx, { intervalMs: 3_600_000 })
    await sched.tick()
    expect(rows(t.db, "SELECT * FROM task_runs WHERE job = 'backup_im'")).toHaveLength(0) // 同一整点内不重试；上次计划运行（02:00）有记录，启动也不重跑

    t.clock.set(day(2026, 11, 3, 3, 5))
    await sched.tick()
    const retry = row(t.db, "SELECT trigger, result, note FROM task_runs WHERE job = 'backup_im'")
    expect(retry.trigger).toBe('retry')
    expect(retry.result).toBe('success')
    expect(retry.note).toContain('新增')
    expect(row(t.db, 'SELECT result FROM backup_runs WHERE source = ? ORDER BY id DESC LIMIT 1', 'im').result).toBe('success')

    // 成功后不再重试
    t.clock.set(day(2026, 11, 3, 4, 5))
    await sched.tick()
    sched.stop()
    expect(rows(t.db, "SELECT * FROM task_runs WHERE job = 'backup_im'")).toHaveLength(1)
  })
})
