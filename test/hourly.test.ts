// 小时摘要流水线测试：spec 测试 1（没有参与的小时跳过）、3（无效引用丢弃/上下文引用去掉），
// 以及重试、统计、task_runs、待处理清单、saveVersion 原子性、上游已变更。
import { describe, expect, it } from 'vitest'
import { SummarizerFormatError } from '../src/llm/types.js'
import type { DraftItem } from '../src/llm/types.js'
import { runHour, pendingHours } from '../src/summary/hourly.js'
import { getSeries, getVersion, saveVersion } from '../src/summary/store.js'
import { DAY_MS, fromLocal, hourKey, startOfHour } from '../src/time.js'
import { ScriptedSummarizer, makeCtx } from './helpers.js'

const day = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi)
const row = (db: ReturnType<typeof makeCtx>['db'], sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as Record<string, unknown>

const HOUR_09 = '2026-10-29T09'

/** 一个可参与的 9 点小时：我开口 + 别人拍板 + 上下文消息 + 一封邮件 + 一个日程 */
function setupParticipatingHour(t: ReturnType<typeof makeCtx>) {
  t.source.addSession('g1', '群 1')
  t.source.addMsg({ id: 'm0', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 8, 50), text: '早上对齐' })
  t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '预算初稿已发出' })
  t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 40), text: '定了：按砍 8% 执行' })
  t.source.mailsList.push({
    id: 'mail1',
    subject: '预算反馈',
    from: { name: '李敏', address: 'limin@corp.com' },
    to: [{ name: '我', address: 'me@corp.com' }],
    cc: [],
    time: day(2026, 10, 29, 9, 20),
    text: '请看附件',
    folder: 'inbox',
  })
  t.source.eventsList.push({
    id: 'ev1',
    title: '产品周会',
    start: day(2026, 10, 29, 9, 0),
    end: day(2026, 10, 29, 9, 30),
    allDay: false,
    organizer: { id: 'u_me', name: '我' },
    attendees: [],
    location: '5 号会议室',
    notes: '周例会',
    updatedAt: day(2026, 10, 29, 9, 0),
  })
}

function scripted(t: ReturnType<typeof makeCtx>, outputs: Array<DraftItem[] | Error>): ScriptedSummarizer {
  const s = new ScriptedSummarizer()
  s.hourlyScript = outputs
  t.ctx.summarizer = s
  return s
}

describe('小时摘要：spec 测试 1 —— 没有参与的小时被跳过', () => {
  it('只有别人的消息：跳过、不产生版本、写 skipped 记录、不再出现在待处理清单', async () => {
    const t = makeCtx()
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 10), text: '闲聊' })
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('skipped')
    expect(getSeries(t.db, 'hour', HOUR_09)?.current_version).toBe(0)
    const run = row(t.db, 'SELECT result, note FROM task_runs WHERE job = ?', 'hourly')
    expect(run.result).toBe('skipped')
    expect(run.note).toBe('没有与我有关的原文')
    expect(pendingHours(t.ctx)).not.toContain(HOUR_09)
  })

  it('未来的小时直接失败', async () => {
    const t = makeCtx() // now = 2026-10-29 20:36
    const r = await runHour(t.ctx, '2026-10-29T21', 'scheduled')
    expect(r.result).toBe('failed')
    expect(r.note).toContain('还没有结束')
  })
})

describe('小时摘要：spec 测试 3 —— 引用校验', () => {
  it('引用上下文消息的引用被去掉；全部无效的条目被丢弃；邮件日程可引用', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    const s = scripted(t, [
      [
        { text: '预算定稿：砍 8% 执行', refs: ['m2', 'x1'] },
        { text: '无效条目', refs: ['zz'] },
        { text: '收到预算反馈并参加周会', refs: ['c1', 'e1'] },
      ],
    ])
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('success')
    expect(r.version).toBe(1)

    // 输入：上下文消息带标，本小时消息、邮件、日程是可引用行
    const input = s.hourlyCalls[0].input
    const byRef = new Map(input.lines.map((l) => [l.ref, l]))
    expect(byRef.get('x1')?.contextOnly).toBe(true)
    expect(byRef.get('x1')?.text).toBe('早上对齐')
    expect(byRef.get('m1')?.contextOnly).toBe(false)
    expect(byRef.get('m2')?.text).toContain('砍 8%')
    expect(byRef.get('c1')?.where).toBe('预算反馈')
    expect(byRef.get('e1')?.where).toBe('产品周会')

    // 版本：第 1 条只剩 m2，第 2 条整体丢弃，第 3 条保留
    const series = getSeries(t.db, 'hour', HOUR_09)!
    const v1 = getVersion(t.db, series.id, 1)!
    expect(v1.items.map((i) => i.text)).toEqual(['预算定稿：砍 8% 执行', '收到预算反馈并参加周会'])
    const refs = v1.refs.map((r2) => `${r2.item_id}:${r2.target_type}:${r2.raw_id}`).sort()
    expect(refs).toEqual(['1:im:m2', '2:event:ev1', '2:mail:mail1'])

    // 统计：本小时全部消息 2 条；与我有关的原文 4 条（m1、m2、mail1、ev1）
    expect(v1.meta.total_msgs).toBe(2)
    expect(v1.meta.related_msgs).toBe(4)
    expect(v1.meta.trigger).toBe('scheduled')
    expect(v1.meta.mode).toBe('full')
    expect(v1.meta.model).toBe('scripted')

    const run = row(t.db, 'SELECT result, note, outputs FROM task_runs WHERE job = ?', 'hourly')
    expect(run.result).toBe('success')
    expect(String(run.note)).toContain('v1')
    expect(JSON.parse(run.outputs as string)).toEqual([{ level: 'hour', period: HOUR_09, version: 1 }])
  })
})

describe('小时摘要：重试规则（spec 14）', () => {
  it('格式错误带 feedback 重试一次', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    const s = scripted(t, [new SummarizerFormatError('第 1 条的 refs 不是字符串数组'), [{ text: '预算定稿', refs: ['m1'] }]])
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('success')
    expect(s.hourlyCalls).toHaveLength(2)
    expect(s.hourlyCalls[0].feedback).toBeUndefined()
    expect(s.hourlyCalls[1].feedback).toBe('第 1 条的 refs 不是字符串数组')
  })

  it('格式错误两次仍失败：版本记失败，不占版本号', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    scripted(t, [new SummarizerFormatError('坏'), new SummarizerFormatError('还是坏')])
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('failed')
    const series = getSeries(t.db, 'hour', HOUR_09)!
    expect(series.state).toBe('failed')
    expect(series.last_error).toContain('还是坏')
    expect(series.current_version).toBe(0)
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM versions').n).toBe(0)
  })

  it('有效条目为 0：按失败处理', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    scripted(t, [[{ text: '没有引用', refs: [] }]])
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('failed')
    expect(r.note).toContain('有效条目')
    expect(getSeries(t.db, 'hour', HOUR_09)?.state).toBe('failed')
  })

  it('条目超上限：带提示重试一次，仍超保留前 3', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    const five = [1, 2, 3, 4, 5].map((i) => ({ text: `条目 ${i}`, refs: ['m1'] }))
    const s = scripted(t, [five, five])
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('success')
    expect(s.hourlyCalls).toHaveLength(2)
    expect(s.hourlyCalls[1].feedback).toContain('上限')
    const series = getSeries(t.db, 'hour', HOUR_09)!
    const v1 = getVersion(t.db, series.id, 1)!
    expect(v1.items.map((i) => i.text)).toEqual(['条目 1', '条目 2', '条目 3'])
  })

  it('客户端不可用：失败并记录原因', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    scripted(t, [[{ text: '条目', refs: ['m1'] }]])
    t.source.down = true
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('failed')
    expect(r.note).toContain('SourceUnavailableError')
    expect(getSeries(t.db, 'hour', HOUR_09)?.state).toBe('failed')
  })
})

describe('小时摘要：待处理清单', () => {
  it('过去 7 天内已结束、没有 success/skipped 记录的小时，按时间升序；失败的小时仍在清单里', () => {
    const t = makeCtx() // now = 2026-10-29 20:36
    const ins = (target: string, result: string) => t.db.prepare('INSERT INTO task_runs (job, target, started_at, result, trigger) VALUES (?,?,?,?,?)').run('hourly', target, 0, result, 'scheduled')
    ins('2026-10-29T19', 'success')
    ins('2026-10-29T18', 'skipped')
    ins('2026-10-29T17', 'failed') // 失败不算完成
    const pending = pendingHours(t.ctx)
    expect(pending[0]).toBe(hourKey(startOfHour(t.clock.now() - 7 * DAY_MS)))
    expect(pending).not.toContain('2026-10-29T18')
    expect(pending).not.toContain('2026-10-29T19')
    expect(pending).not.toContain('2026-10-29T20') // 当前小时未结束
    expect(pending).toContain('2026-10-29T17')
    expect(pending).toContain('2026-10-28T08')
    // 升序
    const sorted = [...pending].sort()
    expect(pending).toEqual(sorted)
  })
})

describe('saveVersion：原子性与条目编号', () => {
  it('中途抛错不留半个版本', () => {
    const t = makeCtx()
    const input = {
      level: 'hour' as const,
      period: HOUR_09,
      createdAt: 0,
      trigger: 'manual' as const,
      mode: 'full' as const,
      model: 'test',
      inputs: [],
      totalMsgs: 5,
      relatedMsgs: 3,
      items: [
        { text: 'a', op: 'add' as const, refs: [] },
        { text: 'b', op: 'add' as const, refs: [] },
      ],
    }
    expect(saveVersion(t.db, input)).toBe(1)
    // 重复 itemId → 主键冲突 → 整个版本回滚
    expect(() =>
      saveVersion(t.db, {
        ...input,
        items: [
          { itemId: 1, text: 'x', op: 'keep' as const, refs: [] },
          { itemId: 1, text: 'y', op: 'keep' as const, refs: [] },
        ],
      }),
    ).toThrow()
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM versions').n).toBe(1)
    expect(getSeries(t.db, 'hour', HOUR_09)?.current_version).toBe(1)
    expect(getSeries(t.db, 'hour', HOUR_09)?.next_item_id).toBe(3)
  })

  it('条目编号系列内永不复用：add 从 next_item_id 继续分配', () => {
    const t = makeCtx()
    const input = {
      level: 'hour' as const,
      period: HOUR_09,
      createdAt: 0,
      trigger: 'scheduled' as const,
      mode: 'full' as const,
      model: 'test',
      inputs: [],
      items: [
        { text: 'a', op: 'add' as const, refs: [] },
        { text: 'b', op: 'add' as const, refs: [] },
      ],
    }
    saveVersion(t.db, input)
    saveVersion(t.db, { ...input, items: [{ itemId: 2, text: 'b 改', op: 'edit' as const, refs: [] }, { text: 'c', op: 'add' as const, refs: [] }] })
    const series = getSeries(t.db, 'hour', HOUR_09)!
    const v2 = getVersion(t.db, series.id, 2)!
    expect(v2.items.map((i) => `${i.item_id}:${i.text}`)).toEqual(['2:b 改', '3:c'])
    expect(series.next_item_id).toBe(4)
  })

  it('旧引用不标新、新引用标新', () => {
    const t = makeCtx()
    const mk = (items: Array<{ itemId?: number; text: string; op: 'keep' | 'edit' | 'add'; refs: Array<{ type: 'im'; rawId: string }> }>) => ({
      level: 'hour' as const,
      period: HOUR_09,
      createdAt: 0,
      trigger: 'scheduled' as const,
      mode: 'incremental' as const,
      model: 'test',
      inputs: [],
      items,
    })
    saveVersion(t.db, mk([{ text: 'a', op: 'add', refs: [{ type: 'im', rawId: 'm1' }] }]))
    saveVersion(t.db, mk([{ itemId: 1, text: 'a 改', op: 'edit', refs: [{ type: 'im', rawId: 'm1' }, { type: 'im', rawId: 'm2' }] }]))
    const series = getSeries(t.db, 'hour', HOUR_09)!
    const refs = getVersion(t.db, series.id, 2)!.refs
    expect(refs.find((r) => r.raw_id === 'm1')?.is_new).toBe(0)
    expect(refs.find((r) => r.raw_id === 'm2')?.is_new).toBe(1)
  })
})

describe('小时摘要：上游已变更（spec 测试 8 的前半）', () => {
  it('重跑小时产生 v2 后，引用它的日结被标上游已变更', async () => {
    const t = makeCtx()
    setupParticipatingHour(t)
    scripted(t, [
      [{ text: '预算定稿', refs: ['m1'] }],
      [{ text: '预算定稿（更新）', refs: ['m2'] }],
    ])
    const r1 = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r1.version).toBe(1)

    // 测试里直接造一个引用小时 v1 条目的日结
    const hourSeries = getSeries(t.db, 'hour', HOUR_09)!
    const hourV1 = getVersion(t.db, hourSeries.id, 1)!
    const dayVersion = saveVersion(t.db, {
      level: 'day',
      period: '2026-10-29',
      createdAt: t.clock.now(),
      trigger: 'scheduled',
      mode: 'full',
      model: 'test',
      inputs: [{ seriesId: hourSeries.id, version: 1 }],
      items: [{ text: '日结条目', op: 'add', refs: [{ type: 'item', versionId: hourV1.meta.id, itemId: hourV1.items[0].item_id }] }],
    })
    expect(dayVersion).toBe(1)
    expect(getSeries(t.db, 'day', '2026-10-29')?.upstream_changed).toBe(0)

    const r2 = await runHour(t.ctx, HOUR_09, 'manual')
    expect(r2.version).toBe(2)
    expect(getSeries(t.db, 'day', '2026-10-29')?.upstream_changed).toBe(1)
  })
})
