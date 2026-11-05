// 日结、周月年增量、补跑、收尾、年摘要、手动重建的流水线测试。
// 必测 spec 测试 4、5、6、7、8，以及：add 没引用本次输入被丢弃、已收尾周期不再增量、年摘要只用最终版月摘要。
import { describe, expect, it } from 'vitest'
import type { RollupOp } from '../src/llm/types.js'
import { JOB_DEFS_BY_NAME } from '../src/jobs/registry.js'
import { backfillMissingDailies, closePeriod, regenerate, runCatchup, runDaily, runYearly, updatePeriod } from '../src/summary/rollup.js'
import { getSeries, getVersion, saveVersion } from '../src/summary/store.js'
import { fromLocal, hourKey } from '../src/time.js'
import { ScriptedSummarizer, makeCtx, type TestCtx } from './helpers.js'

const D = '2026-10-29' // 周四，W44（10/26–11/1）

/** 直接造一个小时版本 + success 运行记录（避免走客户端和模型），related 默认与 items 数一致 */
function fakeHour(t: TestCtx, period: string, items: string[], opts: { related?: number; total?: number } = {}) {
  const version = saveVersion(t.db, {
    level: 'hour',
    period,
    createdAt: t.clock.now(),
    trigger: 'scheduled',
    mode: 'full',
    model: 'test',
    inputs: [],
    totalMsgs: opts.total ?? items.length,
    relatedMsgs: opts.related ?? items.length,
    items: items.map((text, i) => ({ text, op: 'add' as const, refs: [{ type: 'im' as const, rawId: `${period}-m${i}` }] })),
  })
  t.db.prepare("INSERT INTO task_runs (job, target, started_at, result, trigger) VALUES ('hourly', ?, ?, 'success', 'scheduled')").run(period, t.clock.now())
  const series = getSeries(t.db, 'hour', period)!
  return { seriesId: series.id, versionId: getVersion(t.db, series.id, version)!.meta.id, version }
}

function fakeDay(t: TestCtx, day: string, items: string[], hourRefs: Array<{ seriesId: number; version: number; versionId: number; itemIds: number[] }>) {
  const refItems = hourRefs.flatMap((h) => h.itemIds.map((itemId) => ({ type: 'item' as const, versionId: h.versionId, itemId })))
  const version = saveVersion(t.db, {
    level: 'day',
    period: day,
    createdAt: t.clock.now(),
    trigger: 'scheduled',
    mode: 'full',
    model: 'test',
    inputs: hourRefs.map((h) => ({ seriesId: h.seriesId, version: h.version })),
    items: items.map((text, i) => ({ text, op: 'add' as const, refs: refItems.length ? [refItems[i % refItems.length]] : [] })),
  })
  const series = getSeries(t.db, 'day', day)!
  return { seriesId: series.id, versionId: getVersion(t.db, series.id, version)!.meta.id, version }
}

function scripted(t: TestCtx, scripts: { hourly?: Array<unknown[] | Error>; full?: Array<unknown[] | Error>; inc?: Array<unknown[] | Error> }): ScriptedSummarizer {
  const s = new ScriptedSummarizer()
  s.hourlyScript = (scripts.hourly ?? []) as ScriptedSummarizer['hourlyScript']
  s.rollupFullScript = (scripts.full ?? []) as ScriptedSummarizer['rollupFullScript']
  s.rollupIncrementalScript = (scripts.inc ?? []) as ScriptedSummarizer['rollupIncrementalScript']
  t.ctx.summarizer = s
  return s
}

function addTalk(t: TestCtx, at: number, id: string, text = '推进预算') {
  t.source.addMsg({ id, sessionId: 'g1', senderId: 'u_me', time: at, text })
}
describe('日结 runDaily（spec 第 4 节）', () => {
  it('spec 测试 4：迟到消息触发小时重跑，日结引用的是小时 v2', async () => {
    const t = makeCtx() // 2026-10-29 20:36
    t.source.addSession('g1', '预算群')
    addTalk(t, fromLocal(2026, 10, 29, 9, 10), 'm1', '预算初稿发出')
    addTalk(t, fromLocal(2026, 10, 29, 9, 40), 'm2', '定稿：砍 8% 执行')
    // 小时 v1 生成时只有 1 条与我有关；之后 m2 迟到
    fakeHour(t, `${D}T09`, ['预算初稿推进'], { related: 1 })
    scripted(t, {
      hourly: [[{ text: '预算初稿与定稿推进', refs: ['m2'] }]],
      full: [[{ text: '日结条目：预算推进', refs: ['h1'] }]],
      inc: [
        [{ op: 'add', text: '本周条目', refs: ['d1'] }],
        [{ op: 'add', text: '本月条目', refs: ['d1'] }],
      ],
    })

    const run = await runDaily(t.ctx, D, 'manual')
    expect(run.result).toBe('success')
    expect(run.job).toBe('daily')
    expect(run.trigger).toBe('manual')
    expect(run.note).toBe('迟到重跑 1 个小时 · 生成 日结 v1 · 本周 v1 · 本月 v1')
    expect(run.outputs).toEqual([
      { level: 'day', period: D, version: 1 },
      { level: 'week', period: '2026-W44', version: 1 },
      { level: 'month', period: '2026-10', version: 1 },
    ])

    // 小时 v2（迟到重跑），日结引用 v2
    const hour = getSeries(t.db, 'hour', `${D}T09`)!
    expect(hour.current_version).toBe(2)
    const hourV2 = getVersion(t.db, hour.id, 2)!
    expect(hourV2.meta.trigger).toBe('late')
    expect(hourV2.meta.related_msgs).toBe(2)
    const day = getSeries(t.db, 'day', D)!
    const dayV1 = getVersion(t.db, day.id, 1)!
    expect(dayV1.meta.mode).toBe('full')
    expect(dayV1.meta.trigger).toBe('manual')
    expect(dayV1.refs[0].target_version).toBe(hourV2.meta.id)
    expect(dayV1.meta.inputs).toEqual([{ seriesId: hour.id, version: 2 }])
  })

  it('当天没有小时摘要 → 跳过', async () => {
    const t = makeCtx()
    const run = await runDaily(t.ctx, '2026-10-28', 'scheduled')
    expect(run.result).toBe('skipped')
    expect(run.note).toContain('当天没有小时摘要')
    expect(getSeries(t.db, 'day', '2026-10-28')!.current_version).toBe(0)
  })

  it('已有日结且没有新输入 → 跳过，不产生版本', async () => {
    const t = makeCtx()
    const h = fakeHour(t, `${D}T09`, ['条目一'])
    fakeDay(t, D, ['日结条目'], [{ seriesId: h.seriesId, version: h.version, versionId: h.versionId, itemIds: [1] }])
    scripted(t, {}) // 不应该有任何模型调用
    const run = await runDaily(t.ctx, D, 'scheduled')
    expect(run.result).toBe('skipped')
    expect(run.note).toContain('没有新输入')
    expect(getSeries(t.db, 'day', D)!.current_version).toBe(1)
  })

  it('日结之后新出的小时版本走增量（keep + add）', async () => {
    const t = makeCtx()
    const h9 = fakeHour(t, `${D}T09`, ['上午推进预算'])
    fakeDay(t, D, ['日结 v1 条目'], [{ seriesId: h9.seriesId, version: h9.version, versionId: h9.versionId, itemIds: [1] }])
    // 日结跑完后又出了 14 点的小时摘要
    fakeHour(t, `${D}T14`, ['下午联调接口'])
    const s = scripted(t, {
      inc: [
        [{ op: 'keep', id: 1 }, { op: 'add', text: '下午联调', refs: ['h1'] }],
        [{ op: 'add', text: '本周条目', refs: ['d1'] }],
        [{ op: 'add', text: '本月条目', refs: ['d1'] }],
      ],
    })
    const run = await runDaily(t.ctx, D, 'scheduled')
    expect(run.result).toBe('success')
    expect(run.note).toBe('生成 日结 v2 · 本周 v1 · 本月 v1')

    const day = getSeries(t.db, 'day', D)!
    const v2 = getVersion(t.db, day.id, 2)!
    expect(v2.meta.mode).toBe('incremental')
    expect(v2.items.map((i) => `${i.item_id}:${i.text}:${i.op}`)).toEqual(['1:日结 v1 条目:keep', '2:下午联调:add'])
    // 增量输入只有新出的 14 点
    const hour14 = getSeries(t.db, 'hour', `${D}T14`)!
    expect(v2.meta.inputs).toContainEqual({ seriesId: hour14.id, version: 1 })
    expect(v2.meta.inputs).toContainEqual({ seriesId: h9.seriesId, version: 1 }) // 保留的旧引用也算"用了"
    // 模型收到的 inputs 是新小时条目
    expect(s.rollupIncrementalCalls[0].input.inputs.map((i) => i.ref)).toEqual(['h1'])
  })
})

describe('周月增量 updatePeriod（spec 第 5 节，spec 测试 5）', () => {
  it('编号不变；edit 保留旧引用并追加新引用；delete 不写入；add 必须引用本次输入', async () => {
    const t = makeCtx()
    const h = fakeHour(t, `${D}T09`, ['推进预算', '联调接口', '写周报'])
    fakeDay(t, D, ['推进预算', '联调接口', '写周报'], [{ seriesId: h.seriesId, version: h.version, versionId: h.versionId, itemIds: [1, 2, 3] }])
    // 旧周版本：#1 引用旧日结条目，#2 无关条目
    const day = getSeries(t.db, 'day', D)!
    const dayV1 = getVersion(t.db, day.id, 1)!
    saveVersion(t.db, {
      level: 'week',
      period: '2026-W44',
      createdAt: t.clock.now(),
      trigger: 'scheduled',
      mode: 'incremental',
      model: 'test',
      inputs: [{ seriesId: day.id, version: 1 }],
      items: [
        { text: '预算推进中', op: 'add', refs: [{ type: 'item', versionId: dayV1.meta.id, itemId: 1 }] },
        { text: '旧条目', op: 'add', refs: [{ type: 'item', versionId: dayV1.meta.id, itemId: 2 }] },
      ],
    })
    scripted(t, {
      inc: [
        [
          { op: 'edit', id: 1, text: '预算定稿', refs: ['d2', 'zz'] }, // zz 不在本次输入里，应去掉
          { op: 'delete', id: 2 },
          { op: 'add', text: '没有引用本次输入的新增', refs: [] }, // 应被丢弃
          { op: 'add', text: '接口联调完成', refs: ['d3'] },
        ] satisfies RollupOp[],
      ],
    })

    const up = await updatePeriod(t.ctx, 'week', '2026-W44', [{ seriesId: day.id, version: 1 }], 'scheduled')
    expect(up.result).toBe('success')
    expect(up.version).toBe(2)

    const week = getSeries(t.db, 'week', '2026-W44')!
    const v2 = getVersion(t.db, week.id, 2)!
    expect(v2.items.map((i) => `${i.item_id}:${i.text}:${i.op}`)).toEqual(['1:预算定稿:edit', '3:接口联调完成:add'])
    // edit：旧引用保留 + 追加新引用（is_new 由 saveVersion 判定）
    const editRefs = v2.refs.filter((r) => r.item_id === 1)
    expect(editRefs.map((r) => `${r.target_item}:${r.is_new}`)).toEqual(['1:0', '2:1'])
    // 编号不复用：add 从 next_item_id=3 分配
    expect(week.next_item_id).toBe(4)
  })

  it('已收尾的周期不再增量，只标上游已变更', async () => {
    const t = makeCtx()
    const h = fakeHour(t, `${D}T09`, ['推进预算'])
    const d = fakeDay(t, D, ['推进预算'], [{ seriesId: h.seriesId, version: h.version, versionId: h.versionId, itemIds: [1] }])
    const day = getSeries(t.db, 'day', D)!
    const dayV1 = getVersion(t.db, day.id, 1)!
    saveVersion(t.db, {
      level: 'week',
      period: '2026-W44',
      createdAt: t.clock.now(),
      trigger: 'close',
      mode: 'full',
      model: 'test',
      inputs: [{ seriesId: day.id, version: 1 }],
      isFinal: true,
      items: [{ text: '最终版条目', op: 'add', refs: [{ type: 'item', versionId: dayV1.meta.id, itemId: 1 }] }],
    })
    scripted(t, {}) // 不应调模型
    // 日结出了新版本 v2
    saveVersion(t.db, {
      level: 'day',
      period: D,
      createdAt: t.clock.now(),
      trigger: 'late',
      mode: 'incremental',
      model: 'test',
      inputs: [{ seriesId: h.seriesId, version: h.version }],
      items: [{ itemId: 1, text: '推进预算（补）', op: 'edit', refs: [{ type: 'item', versionId: h.versionId, itemId: 1 }] }],
    })

    const up = await updatePeriod(t.ctx, 'week', '2026-W44', [{ seriesId: d.seriesId, version: 2 }], 'scheduled')
    expect(up.result).toBe('skipped')
    expect(up.reason).toBe('已收尾')
    const week = getSeries(t.db, 'week', '2026-W44')!
    expect(week.current_version).toBe(1)
    expect(week.is_final).toBe(1)
    expect(week.upstream_changed).toBe(1)
  })

  it('没有新输入 → 跳过', async () => {
    const t = makeCtx()
    const up = await updatePeriod(t.ctx, 'week', '2026-W44', [], 'scheduled')
    expect(up.result).toBe('skipped')
    expect(up.reason).toBe('没有新输入')
  })
})

describe('补跑 runCatchup（spec 第 5 节，spec 测试 6）', () => {
  const Y = '2026-10-28' // 周三

  function setup(t: TestCtx) {
    const h9 = fakeHour(t, `${Y}T09`, ['上午推进'])
    const d = fakeDay(t, Y, ['日结条目'], [{ seriesId: h9.seriesId, version: h9.version, versionId: h9.versionId, itemIds: [1] }])
    // 日结之后又出了 21 点的小时摘要
    fakeHour(t, `${Y}T21`, ['晚上收尾'])
    return { d }
  }

  it('日结后出现新小时摘要 → 日结 v2，周和月各加一个版本', async () => {
    const t = makeCtx()
    setup(t)
    scripted(t, {
      inc: [
        [{ op: 'keep', id: 1 }, { op: 'add', text: '晚上收尾', refs: ['h1'] }],
        [{ op: 'add', text: '本周条目', refs: ['d1'] }],
        [{ op: 'add', text: '本月条目', refs: ['d1'] }],
      ],
    })
    const run = await runCatchup(t.ctx, Y)
    expect(run.result).toBe('success')
    expect(run.job).toBe('catchup')
    expect(run.note).toBe('日结 v2 · 本周 v1 · 本月 v1') // 10-28 与 10-29 同周同月

    expect(getSeries(t.db, 'day', Y)!.current_version).toBe(2)
    expect(getSeries(t.db, 'week', '2026-W44')!.current_version).toBe(1)
    expect(getSeries(t.db, 'month', '2026-10')!.current_version).toBe(1)
    const weekV1 = getVersion(t.db, getSeries(t.db, 'week', '2026-W44')!.id, 1)!
    expect(weekV1.meta.trigger).toBe('catchup')
    expect(weekV1.meta.mode).toBe('incremental')
  })

  it('没有新小时摘要 → 跳过，不产生版本', async () => {
    const t = makeCtx()
    setup(t)
    // 先补跑一次把新小时并入
    scripted(t, {
      inc: [
        [{ op: 'keep', id: 1 }, { op: 'add', text: '晚上收尾', refs: ['h1'] }],
        [{ op: 'add', text: '本周条目', refs: ['d1'] }],
        [{ op: 'add', text: '本月条目', refs: ['d1'] }],
      ],
    })
    await runCatchup(t.ctx, Y)
    // 再补跑：没有新内容
    scripted(t, {})
    const run = await runCatchup(t.ctx, Y)
    expect(run.result).toBe('skipped')
    expect(run.note).toBe('没有新内容')
    expect(getSeries(t.db, 'day', Y)!.current_version).toBe(2)
    expect(getSeries(t.db, 'week', '2026-W44')!.current_version).toBe(1)
  })
})

describe('收尾 closePeriod 与年摘要 runYearly（spec 第 5、6 节，spec 测试 7）', () => {
  function setupDays(t: TestCtx, days: string[]) {
    for (const day of days) {
      const [y, mo, dd] = day.split('-').map(Number)
      const h = fakeHour(t, hourKey(fromLocal(y, mo, dd, 9)), ['推进'])
      fakeDay(t, day, [`${day} 的日结`], [{ seriesId: h.seriesId, version: h.version, versionId: h.versionId, itemIds: [1] }])
    }
  }

  it('周一凌晨的补跑对上周收尾，产生最终版', async () => {
    const t = makeCtx()
    t.clock.set(fromLocal(2026, 11, 2, 0, 30)) // 周一 00:30，昨天是周日 11-01
    setupDays(t, ['2026-10-29', '2026-10-30'])
    scripted(t, { full: [[{ text: '本周最终条目', refs: ['d1', 'd2'] }]] })

    const run = await runCatchup(t.ctx, '2026-11-01')
    expect(run.result).toBe('success')
    expect(run.note).toBe('收尾第 44 周 v1')
    const week = getSeries(t.db, 'week', '2026-W44')!
    expect(week.is_final).toBe(1)
    const v1 = getVersion(t.db, week.id, 1)!
    expect(v1.meta.trigger).toBe('close')
    expect(v1.meta.mode).toBe('full')
    expect(v1.meta.is_final).toBe(1)
    // 用的是周期内全部日结的最新版本
    expect(v1.meta.inputs).toHaveLength(2)
  })

  it('月末补跑收尾上月；年摘要先收尾再用最终版月摘要增量（年只用最终版）', async () => {
    const t = makeCtx()
    t.clock.set(fromLocal(2026, 11, 1, 3, 0))
    setupDays(t, ['2026-10-29', '2026-10-30'])
    // 10 月已有一个非最终的月版本
    const daySeries = getSeries(t.db, 'day', '2026-10-29')!
    const dayV1 = getVersion(t.db, daySeries.id, 1)!
    saveVersion(t.db, {
      level: 'month',
      period: '2026-10',
      createdAt: t.clock.now(),
      trigger: 'scheduled',
      mode: 'incremental',
      model: 'test',
      inputs: [{ seriesId: daySeries.id, version: 1 }],
      items: [{ text: '10 月进行中条目', op: 'add', refs: [{ type: 'item', versionId: dayV1.meta.id, itemId: 1 }] }],
    })
    scripted(t, {
      full: [[{ text: '10 月最终条目', refs: ['d1'] }]], // 收尾
      inc: [[{ op: 'add', text: '本年条目', refs: ['m1'] }]], // 年增量
    })

    const run = await runYearly(t.ctx, '2026-10')
    expect(run.result).toBe('success')
    expect(run.note).toBe('收尾 10 月 v2 · 2026 年 v1')

    const month = getSeries(t.db, 'month', '2026-10')!
    expect(month.is_final).toBe(1)
    expect(month.current_version).toBe(2)
    // 年摘要引用的是月摘要最终版 v2
    const year = getSeries(t.db, 'year', '2026')!
    const yearV1 = getVersion(t.db, year.id, 1)!
    expect(yearV1.meta.mode).toBe('incremental')
    expect(yearV1.meta.inputs).toEqual([{ seriesId: month.id, version: 2 }])
    expect(yearV1.refs[0].target_version).toBe(getVersion(t.db, month.id, 2)!.meta.id)
    expect(year.is_final).toBe(0)
  })

  it('1 月 1 日并入 12 月后，那一版是上一年的最终版', async () => {
    const t = makeCtx()
    t.clock.set(fromLocal(2026, 1, 1, 3, 0))
    // 造一个已收尾的 12 月和一个上一年的年版本
    const dec = saveVersion(t.db, {
      level: 'month',
      period: '2025-12',
      createdAt: t.clock.now(),
      trigger: 'close',
      mode: 'full',
      model: 'test',
      inputs: [],
      isFinal: true,
      items: [{ text: '12 月条目', op: 'add', refs: [] }],
    })
    void dec
    const mSeries = getSeries(t.db, 'month', '2025-12')!
    saveVersion(t.db, {
      level: 'year',
      period: '2025',
      createdAt: t.clock.now(),
      trigger: 'scheduled',
      mode: 'incremental',
      model: 'test',
      inputs: [], // 还没并入 12 月
      items: [{ text: '2025 年条目', op: 'add', refs: [{ type: 'item', versionId: getVersion(t.db, mSeries.id, 1)!.meta.id, itemId: 1 }] }],
    })
    scripted(t, { inc: [[{ op: 'keep', id: 1 }, { op: 'add', text: '12 月收尾', refs: ['m1'] }]] })

    const run = await runYearly(t.ctx, '2025-12')
    expect(run.result).toBe('success')
    expect(run.note).toBe('2025 年 v2（最终版）')
    const year = getSeries(t.db, 'year', '2025')!
    expect(year.is_final).toBe(1)
    expect(getVersion(t.db, year.id, 2)!.meta.is_final).toBe(1)
  })
})

describe('手动重建 regenerate（spec 第 8、13.8 节，spec 测试 8 后半）', () => {
  it('上游已变更：下层重跑后出现，上层重建后消失', async () => {
    const t = makeCtx()
    const h = fakeHour(t, `${D}T09`, ['推进预算'])
    fakeDay(t, D, ['推进预算'], [{ seriesId: h.seriesId, version: h.version, versionId: h.versionId, itemIds: [1] }])
    const day = getSeries(t.db, 'day', D)!
    const dayV1Meta = getVersion(t.db, day.id, 1)!.meta
    saveVersion(t.db, {
      level: 'week',
      period: '2026-W44',
      createdAt: t.clock.now(),
      trigger: 'scheduled',
      mode: 'incremental',
      model: 'test',
      inputs: [{ seriesId: day.id, version: 1 }],
      items: [{ text: '本周条目', op: 'add', refs: [{ type: 'item', versionId: dayV1Meta.id, itemId: 1 }] }],
    })

    // 小时重跑 → 日结"上游已变更"
    saveVersion(t.db, {
      level: 'hour',
      period: `${D}T09`,
      createdAt: t.clock.now(),
      trigger: 'manual',
      mode: 'full',
      model: 'test',
      inputs: [],
      items: [{ itemId: 1, text: '推进预算（重跑）', op: 'edit', refs: [{ type: 'im', rawId: `${D}T09-m0` }] }],
    })
    expect(getSeries(t.db, 'day', D)!.upstream_changed).toBe(1)

    // 手动重建日结 → 标记消失，引用最新小时版本
    scripted(t, { full: [[{ text: '重建的日结', refs: ['h1'] }]] })
    const version = await regenerate(t.ctx, 'day', D)
    expect(version).toBe(2)
    const dayV2 = getVersion(t.db, day.id, 2)!
    expect(dayV2.meta.trigger).toBe('manual')
    expect(dayV2.meta.mode).toBe('full')
    expect(dayV2.meta.inputs).toEqual([{ seriesId: h.seriesId, version: 2 }])
    expect(getSeries(t.db, 'day', D)!.upstream_changed).toBe(0)
    // 日结重建后，引用它的周被标上游已变更
    expect(getSeries(t.db, 'week', '2026-W44')!.upstream_changed).toBe(1)
  })

  it('未来的周期拒绝；已收尾的周期重建仍是最终版', async () => {
    const t = makeCtx()
    await expect(regenerate(t.ctx, 'day', '2026-11-15')).rejects.toThrow('还没有开始')
    await expect(regenerate(t.ctx, 'hour', '2026-10-29T21')).rejects.toThrow('还没有结束')

    const h = fakeHour(t, `${D}T09`, ['推进'])
    fakeDay(t, D, ['推进'], [{ seriesId: h.seriesId, version: h.version, versionId: h.versionId, itemIds: [1] }])
    const day = getSeries(t.db, 'day', D)!
    const dayV1 = getVersion(t.db, day.id, 1)!
    saveVersion(t.db, {
      level: 'week',
      period: '2026-W44',
      createdAt: t.clock.now(),
      trigger: 'close',
      mode: 'full',
      model: 'test',
      inputs: [{ seriesId: day.id, version: 1 }],
      isFinal: true,
      items: [{ text: '最终版', op: 'add', refs: [{ type: 'item', versionId: dayV1.meta.id, itemId: 1 }] }],
    })
    scripted(t, { full: [[{ text: '重建的最终版', refs: ['d1'] }]] })
    const version = await regenerate(t.ctx, 'week', '2026-W44')
    expect(version).toBe(2)
    const week = getSeries(t.db, 'week', '2026-W44')!
    expect(getVersion(t.db, week.id, 2)!.meta.is_final).toBe(1)
    expect(week.is_final).toBe(1)
  })

  it('closePeriod：周期内没有日结 → 跳过', async () => {
    const t = makeCtx()
    const r = await closePeriod(t.ctx, 'week', '2026-W43')
    expect(r.result).toBe('skipped')
    expect(r.reason).toBe('周期内没有日结')
  })
})


describe('补跑前置：只有小时摘要、没有日结的日子（票 11）', () => {
  // 10/20 周二 00:30 跑补跑：窗口是 10/13–10/18（不含今天 10/20、昨天 10/19）
  const NOW = fromLocal(2026, 10, 20, 0, 30)

  it('窗口内有小时无日结的日子按时间先后各出日结 v1，所在周、月跟着增量出版本', async () => {
    const t = makeCtx({ now: NOW })
    fakeHour(t, '2026-10-13T09', ['推进 A']) // 周二
    fakeHour(t, '2026-10-14T10', ['推进 B'])
    fakeHour(t, '2026-10-15T11', ['推进 C'])
    scripted(t, {
      full: [
        [{ text: '日结 13', refs: ['h1'] }],
        [{ text: '日结 14', refs: ['h1'] }],
        [{ text: '日结 15', refs: ['h1'] }],
      ],
      inc: [
        [{ op: 'add', text: 'W42 第一条', refs: ['d1'] }],
        [{ op: 'add', text: '10 月第一条', refs: ['d1'] }],
        [{ op: 'add', text: 'W42 第二条', refs: ['d1'] }],
        [{ op: 'add', text: '10 月第二条', refs: ['d1'] }],
        [{ op: 'add', text: 'W42 第三条', refs: ['d1'] }],
        [{ op: 'add', text: '10 月第三条', refs: ['d1'] }],
      ],
    })

    const days = await backfillMissingDailies(t.ctx)
    expect(days).toEqual(['2026-10-13', '2026-10-14', '2026-10-15'])
    for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) {
      const s = getSeries(t.db, 'day', d)!
      expect(s.current_version).toBe(1)
      expect(getVersion(t.db, s.id, 1)!.meta.trigger).toBe('catchup')
    }
    expect(getSeries(t.db, 'week', '2026-W42')!.current_version).toBe(3)
    expect(getSeries(t.db, 'month', '2026-10')!.current_version).toBe(3)

    // 再跑一次：没有新缺口日，也不调模型
    const s2 = scripted(t, {})
    expect(await backfillMissingDailies(t.ctx)).toEqual([])
    expect(s2.rollupFullCalls).toHaveLength(0)
  })

  it('已收尾的周不增量，只标上游已变更；月照常增量', async () => {
    const t = makeCtx({ now: NOW })
    // W42 已收尾（引用 10/12 的日结）；10/13 只有小时摘要，补出的日结落在 W42 里
    const h12 = fakeHour(t, '2026-10-12T09', ['旧的'])
    fakeDay(t, '2026-10-12', ['旧日结'], [{ seriesId: h12.seriesId, version: h12.version, versionId: h12.versionId, itemIds: [1] }])
    const d12 = getSeries(t.db, 'day', '2026-10-12')!
    const d12v1 = getVersion(t.db, d12.id, 1)!
    saveVersion(t.db, {
      level: 'week',
      period: '2026-W42',
      createdAt: t.clock.now(),
      trigger: 'close',
      mode: 'full',
      model: 'test',
      inputs: [{ seriesId: d12.id, version: 1 }],
      isFinal: true,
      items: [{ text: 'W42 最终版', op: 'add', refs: [{ type: 'item', versionId: d12v1.meta.id, itemId: 1 }] }],
    })
    fakeHour(t, '2026-10-13T09', ['推进 A'])
    const s = scripted(t, {
      full: [[{ text: '日结 13', refs: ['h1'] }]],
      inc: [[{ op: 'add', text: '10 月第一条', refs: ['d1'] }]], // 只有月增量；周已收尾不再调模型
    })

    expect(await backfillMissingDailies(t.ctx)).toEqual(['2026-10-13'])
    const week = getSeries(t.db, 'week', '2026-W42')!
    expect(week.current_version).toBe(1)
    expect(week.is_final).toBe(1)
    expect(week.upstream_changed).toBe(1)
    expect(s.rollupIncrementalCalls).toHaveLength(1) // 只调了月那次
    expect(getSeries(t.db, 'month', '2026-10')!.current_version).toBe(1)
  })

  it('今天和昨天不算缺口日：昨天由补跑主体处理，今天还没到日结时间', async () => {
    const t = makeCtx({ now: NOW })
    fakeHour(t, '2026-10-19T09', ['昨天的小时']) // 昨天：不走补日结，走 runCatchup 主体
    fakeHour(t, '2026-10-20T00', ['今天 0 点的小时'])
    scripted(t, {})
    expect(await backfillMissingDailies(t.ctx)).toEqual([])
  })

  it('catchup 任务先补缺口日、再处理昨天（接线）', async () => {
    const t = makeCtx({ now: NOW })
    fakeHour(t, '2026-10-13T09', ['推进 A'])
    scripted(t, {
      full: [[{ text: '日结 13', refs: ['h1'] }]],
      inc: [
        [{ op: 'add', text: 'W42 第一条', refs: ['d1'] }],
        [{ op: 'add', text: '10 月第一条', refs: ['d1'] }],
      ],
    })
    const run = await JOB_DEFS_BY_NAME.catchup.execute(t.ctx, 'scheduled')
    expect(getSeries(t.db, 'day', '2026-10-13')!.current_version).toBe(1)
    expect(run.job).toBe('catchup')
    expect(run.result).toBe('skipped') // 昨天 10/19 没有日结也没有新小时 → 没有新内容
  })
})
