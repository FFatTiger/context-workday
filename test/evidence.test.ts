// 证据链测试：spec 测试 9（原文本机和客户端都找不到 → 降级信息和原因）、
// 证据树展开、祖先路径、原文上下文/详情、受缺口影响的条目、便宜的降级计数。
import { describe, expect, it } from 'vitest'
import { coverage } from '../src/backup/coverage.js'
import type { DraftItem } from '../src/llm/types.js'
import { runHour } from '../src/summary/hourly.js'
import { affectedItems, evidenceTree, eventDetail, imContext, itemViews, mailDetail } from '../src/summary/evidence.js'
import { getSeries, getVersion, saveVersion } from '../src/summary/store.js'
import { fromLocal } from '../src/time.js'
import { ScriptedSummarizer, makeCtx } from './helpers.js'

const day = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi)
const HOUR_09 = '2026-10-29T09'
const row = (db: ReturnType<typeof makeCtx>['db'], sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as Record<string, unknown>
function setupHour(t: ReturnType<typeof makeCtx>, refs: string[]) {
  t.source.addSession('g1', '群 1')
  t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '初稿已发，大家看下' })
  t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 40), text: '定了：按砍 8% 执行' })
  const s = new ScriptedSummarizer()
  s.hourlyScript = [[{ text: '预算定稿：砍 8% 执行', refs }]]
  t.ctx.summarizer = s
  return s
}

async function runHourV1(t: ReturnType<typeof makeCtx>): Promise<{ seriesId: number; versionId: number }> {
  const r = await runHour(t.ctx, HOUR_09, 'scheduled')
  expect(r.result).toBe('success')
  const series = getSeries(t.db, 'hour', HOUR_09)!
  const v1 = getVersion(t.db, series.id, 1)!
  return { seriesId: series.id, versionId: v1.meta.id }
}

/** 造一个引用小时 v1 第 1 条的日结（测试用 saveVersion 直接造） */
async function linkDayVersion(t: ReturnType<typeof makeCtx>, hourSeriesId: number, hourVersionId: number): Promise<void> {
  const v = saveVersion(t.db, {
    level: 'day',
    period: '2026-10-29',
    createdAt: t.clock.now(),
    trigger: 'scheduled',
    mode: 'full',
    model: 'test',
    inputs: [{ seriesId: hourSeriesId, version: 1 }],
    items: [{ text: '日结：预算定稿', op: 'add', refs: [{ type: 'item', versionId: hourVersionId, itemId: 1 }] }],
  })
  expect(v).toBe(1)
}

describe('证据链：spec 测试 9 —— 原文丢失的降级信息与原因', () => {
  it('本机和客户端都没有、当天也没有备份记录：backup_gap，判定写 raw_lost 后不再查客户端', async () => {
    const t = makeCtx() // now = 2026-10-29 20:36
    setupHour(t, ['m1', 'm2'])
    await runHourV1(t)

    // 没备份；m1 从客户端消失（撤回），但保留期内会查一次
    t.source.deletedIds.add('m1')
    const callsFor: Record<string, number> = {}
    const orig = t.source.findMessage.bind(t.source)
    t.source.findMessage = async (id: string) => {
      callsFor[id] = (callsFor[id] ?? 0) + 1
      return orig(id)
    }

    const res = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(res.item).toMatchObject({ level: 'hour', period: HOUR_09, version: 1, itemId: 1, itemIndex: 1, text: '预算定稿：砍 8% 执行', levelName: '小时摘要' })
    expect(res.item.degraded).toEqual({ generatedAt: res.item.createdAt, reason: 'backup_gap', count: 1 })
    expect(res.nodes[0]).toMatchObject({ kind: 'lost', rawType: 'im', id: 'm1', reason: 'backup_gap', count: 1, text: '预算定稿：砍 8% 执行', generatedAt: res.item.createdAt })
    expect(res.nodes[0]).not.toHaveProperty('mixedReasons')
    expect(res.nodes[1]).toMatchObject({ kind: 'im', id: 'm2', text: '定了：按砍 8% 执行', isMine: false })
    expect(res.totals).toEqual({ items: 0, im: 2, mail: 0, event: 0, degraded: 1 })
    expect(callsFor['m1']).toBe(1)
    expect(callsFor['m2']).toBe(1) // 可用性判定和展示共用一次反查
    expect(row(t.db, 'SELECT reason FROM raw_lost WHERE raw_id = ?', 'm1').reason).toBe('backup_gap')

    // 第二次不再查客户端（raw_lost 已判定）
    await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(callsFor['m1']).toBe(1)
  })

  it('那天备份覆盖是 ok：gone_at_backup（备份时客户端里已没有）', async () => {
    const t = makeCtx()
    setupHour(t, ['m1', 'm2'])
    await runHourV1(t)
    t.source.deletedIds.add('m1')
    t.db.prepare('INSERT INTO backup_days (source, day, client_count, local_count, run_id) VALUES (?,?,?,?,?)').run('im', '2026-10-29', 2, 2, 1)

    const res = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(res.nodes[0]).toMatchObject({ kind: 'lost', reason: 'gone_at_backup' })
  })

  it('邮件超保留期未备份：expired_unbacked；便宜的 degraded 计数不调客户端', async () => {
    const t = makeCtx()
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '发初稿' })
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
    const s = new ScriptedSummarizer()
    s.hourlyScript = [[{ text: '发出初稿并收到反馈', refs: ['c1'] }]]
    t.ctx.summarizer = s
    await runHourV1(t)

    // 快进 91 天：邮件超出客户端保留期，本机也没备份过
    t.clock.set(day(2027, 1, 28, 12, 0))
    const res = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(res.nodes[0]).toMatchObject({ kind: 'lost', rawType: 'mail', id: 'mail1', reason: 'expired_unbacked', count: 1 })
    expect(res.item.createdAt).toBeGreaterThan(0)

    // 便宜计数：客户端挂了也能算 degraded
    t.source.down = true
    const series = getSeries(t.db, 'hour', HOUR_09)!
    const v1 = getVersion(t.db, series.id, 1)!
    const views = itemViews(t.ctx, v1.meta.id)
    expect(views).toHaveLength(1)
    expect(views[0].counts).toEqual({ evidence: 1, im: 0, mail: 1, event: 0 })
    expect(views[0].degraded).toBe(1)
  })

  it('本机备份过：原文可用', async () => {
    const t = makeCtx()
    setupHour(t, ['m1', 'm2'])
    await runHourV1(t)
    const { runBackup } = await import('../src/backup/run.js')
    await runBackup(t.ctx, 'im', 'manual')
    const res = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(res.nodes.every((n) => n.kind === 'im')).toBe(true)
    expect(res.nodes[0]).toMatchObject({ kind: 'im', id: 'm1', isMine: true, session: '群 1' })
  })
})

describe('证据链：展开、祖先路径、最新版提示', () => {
  it('小时重跑出 v2 后，日结展开看到 latestVersion，小时条目路径含日结', async () => {
    const t = makeCtx()
    setupHour(t, ['m1', 'm2'])
    const s = t.ctx.summarizer as ScriptedSummarizer
    s.hourlyScript.push([{ text: '预算定稿（更新）', refs: ['m1'] }])
    const { seriesId, versionId } = await runHourV1(t)
    await linkDayVersion(t, seriesId, versionId)
    const r2 = await runHour(t.ctx, HOUR_09, 'manual')
    expect(r2.version).toBe(2)
    expect(getSeries(t.db, 'day', '2026-10-29')?.upstream_changed).toBe(1)

    // 日结条目展开到原文
    const dayTree = await evidenceTree(t.ctx, { level: 'day', period: '2026-10-29', version: 1, itemId: 1 }, true)
    const hourNode = dayTree.nodes[0] as Extract<import('../src/api-types.js').EvidenceNode, { kind: 'item' }>
    expect(hourNode).toMatchObject({ kind: 'item', levelName: '小时摘要', text: '预算定稿：砍 8% 执行' })
    expect(hourNode).toHaveProperty('latestVersion', 2)
    expect(hourNode.children?.map((n) => (n as { id?: string }).id)).toEqual(['m1', 'm2'])
    expect(dayTree.totals).toEqual({ items: 1, im: 2, mail: 0, event: 0, degraded: 0 })
    expect(dayTree.path).toEqual([{ label: '今天' }])

    // 小时条目自己的路径：祖先在前，自己是 09:00
    const hourTree = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(hourTree.path).toEqual([{ label: '今天 v1', ref: { level: 'day', period: '2026-10-29', version: 1, itemId: 1 } }, { label: '09:00' }])
  })

  it('上层条目的 degraded 计数累计证据链下已降级的小时条目（不展开也算）', async () => {
    const t = makeCtx()
    setupHour(t, ['m1', 'm2'])
    const { seriesId, versionId } = await runHourV1(t)
    await linkDayVersion(t, seriesId, versionId)
    t.source.deletedIds.add('m1')
    t.source.deletedIds.add('m2')

    // 证据抽屉先判定（写 raw_lost），时间线/卡片的便宜计数随后就能看到降级
    const tree = await evidenceTree(t.ctx, { level: 'day', period: '2026-10-29', version: 1, itemId: 1 }, false)
    expect(tree.totals.degraded).toBe(1)
    expect(tree.nodes[0]).toMatchObject({ kind: 'item' })
    expect((tree.nodes[0] as { degraded?: unknown }).degraded).toMatchObject({ reason: 'backup_gap' })

    const daySeries = getSeries(t.db, 'day', '2026-10-29')!
    const dayV1 = getVersion(t.db, daySeries.id, 1)!
    const views = itemViews(t.ctx, dayV1.meta.id)
    expect(views[0].counts).toEqual({ evidence: 1 })
    expect(views[0].degraded).toBe(1)
  })
})

describe('证据链：原文上下文与详情', () => {
  it('IM 上下文：前后 30 分钟，本机 + 客户端合并去重', async () => {
    const t = makeCtx()
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm0', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 5), text: '前一条' })
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '目标消息' })
    t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 20), text: '被撤回的' })
    t.source.addMsg({ id: 'm3', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 10, 0), text: '窗口外' })
    const { runBackup } = await import('../src/backup/run.js')
    await runBackup(t.ctx, 'im', 'manual')
    t.source.deletedIds.add('m2') // 备份后撤回：客户端没了，本机还有

    const res = await imContext(t.ctx, 'm1')
    expect(res?.session).toBe('群 1')
    expect(res?.messages.map((m) => m.id)).toEqual(['m0', 'm1', 'm2'])
    expect(res?.messages.find((m) => m.id === 'm1')?.isTarget).toBe(true)
    expect(res?.messages.every((m) => m.id === 'm1' ? m.isTarget : !m.isTarget)).toBe(true)
  })

  it('没备份的消息也能从客户端拿到上下文', async () => {
    const t = makeCtx()
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'c0', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 0), text: '客户端里的' })
    t.source.addMsg({ id: 'c1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '目标' })
    const res = await imContext(t.ctx, 'c1')
    expect(res?.messages.map((m) => m.id)).toEqual(['c0', 'c1'])
    expect(res?.messages.find((m) => m.id === 'c1')?.isMine).toBe(true)
    expect(await imContext(t.ctx, 'nope')).toBeNull()
  })

  it('邮件和日程详情：客户端拿不到时回落客户端反查', async () => {
    const t = makeCtx()
    t.source.mailsList.push({
      id: 'mail1',
      subject: '预算反馈',
      from: { name: '李敏', address: 'limin@corp.com' },
      to: [{ name: '我', address: 'me@corp.com' }],
      cc: [{ name: '王总', address: 'wang@corp.com' }],
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
      organizer: { id: 'u_wang', name: '王总' },
      attendees: [
        { id: 'u_me', name: '我', response: 'accepted' },
        { id: 'u_limin', name: '李敏', response: 'tentative' },
      ],
      location: '5 号会议室',
      notes: '周例会',
      updatedAt: day(2026, 10, 29, 9, 0),
    })
    // 未备份：走客户端 findMail / findEvent
    const mail = await mailDetail(t.ctx, 'mail1')
    expect(mail).toMatchObject({ id: 'mail1', subject: '预算反馈', from: '李敏 <limin@corp.com>', time: day(2026, 10, 29, 9, 20) })
    expect(mail?.to).toEqual(['我 <me@corp.com>'])
    const ev = await eventDetail(t.ctx, 'ev1')
    expect(ev).toMatchObject({ id: 'ev1', title: '产品周会', organizer: '王总', location: '5 号会议室' })
    expect(ev?.attendees).toEqual([
      { name: '我', response: 'accepted' },
      { name: '李敏', response: 'tentative' },
    ])
    expect(await mailDetail(t.ctx, 'nope')).toBeNull()
    expect(await eventDetail(t.ctx, 'nope')).toBeNull()
  })
})

describe('受缺口影响的条目（api-types 14 / 15）', () => {
  it('返回被降级的小时条目和引用它的上层条目；coverage 按来源计数', async () => {
    const t = makeCtx()
    setupHour(t, ['m1', 'm2'])
    const { seriesId, versionId } = await runHourV1(t)
    await linkDayVersion(t, seriesId, versionId)
    t.source.deletedIds.add('m1')
    t.db.prepare('INSERT INTO backup_days (source, day, client_count, local_count, run_id) VALUES (?,?,?,?,?)').run('im', '2026-10-29', 2, 2, 1)

    // /affected 用便宜规则：先经过一次证据抽屉判定，raw_lost 里就有了记录
    await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)

    const affected = affectedItems(t.ctx)
    expect(affected).toHaveLength(1)
    expect(affected[0].ref).toEqual({ level: 'hour', period: HOUR_09, version: 1, itemId: 1 })
    expect(affected[0].reason).toBe('gone_at_backup')
    expect(affected[0].usedBy).toEqual([{ ref: { level: 'day', period: '2026-10-29', version: 1, itemId: 1 }, text: '日结：预算定稿' }])

    expect(coverage(t.ctx, 'im', 30).degradedItems).toBe(1)
    expect(coverage(t.ctx, 'mail', 30).degradedItems).toBe(0)
    expect(coverage(t.ctx, 'calendar', 30).degradedItems).toBe(0)
  })
})

describe('同一小时条目的多条丢失原文合并成一个降级框（票 11 / ADR-0002）', () => {
  it('3 条原文丢 2 条：1 个 lost 节点（count=2）+ 1 个 im 节点；原因不同标 mixedReasons', async () => {
    const t = makeCtx() // now = 2026-10-29 20:36
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '初稿已发' })
    t.source.addMsg({ id: 'm3', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 50), text: '收到' })
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
    const s = new ScriptedSummarizer()
    s.hourlyScript = [[{ text: '推进预算并收到反馈', refs: ['m1', 'c1', 'm2'] }]] // m2 = 原文 m3，c1 = 邮件
    t.ctx.summarizer = s
    const r = await runHour(t.ctx, HOUR_09, 'scheduled')
    expect(r.result).toBe('success')

    // m1 从客户端消失（当天无备份记录 → backup_gap）；邮件也从客户端消失（邮件无记录 → expired_unbacked）
    t.source.deletedIds.add('m1')
    t.source.mailsList.splice(0, t.source.mailsList.length)

    const res = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, false)
    expect(res.item.degraded).toEqual({ generatedAt: res.item.createdAt, reason: 'backup_gap', count: 2 })
    expect(res.nodes.map((n) => n.kind)).toEqual(['lost', 'im'])
    const lost = res.nodes[0] as Extract<import('../src/api-types.js').EvidenceNode, { kind: 'lost' }>
    expect(lost).toMatchObject({ rawType: 'im', id: 'm1', reason: 'backup_gap', count: 2, text: '推进预算并收到反馈', mixedReasons: true })
    expect(res.nodes[1]).toMatchObject({ kind: 'im', id: 'm3' })
    expect(res.totals).toEqual({ items: 0, im: 2, mail: 1, event: 0, degraded: 1 })
  })

  it('展开上层条目时，小时条目的丢失原文同样只出一个降级框', async () => {
    const t = makeCtx()
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 10), text: '初稿已发' })
    t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 30), text: '又发一版' })
    t.source.addMsg({ id: 'm3', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 50), text: '收到' })
    const s = new ScriptedSummarizer()
    s.hourlyScript = [[{ text: '推进预算', refs: ['m1', 'm2', 'm3'] }]]
    t.ctx.summarizer = s
    const { seriesId, versionId } = await runHourV1(t)
    await linkDayVersion(t, seriesId, versionId)
    t.source.deletedIds.add('m1')
    t.source.deletedIds.add('m2')

    const tree = await evidenceTree(t.ctx, { level: 'day', period: '2026-10-29', version: 1, itemId: 1 }, true)
    const hourNode = tree.nodes[0] as Extract<import('../src/api-types.js').EvidenceNode, { kind: 'item' }>
    expect(hourNode.degraded).toEqual({ generatedAt: expect.any(Number), reason: 'backup_gap', count: 2 })
    expect(hourNode.children?.map((n) => n.kind)).toEqual(['lost', 'im'])
    const lost = hourNode.children![0] as Extract<import('../src/api-types.js').EvidenceNode, { kind: 'lost' }>
    expect(lost.count).toBe(2)
    expect(lost.text).toBe('推进预算')
    expect(lost).not.toHaveProperty('mixedReasons') // 同一天同原因
  })
})

describe('客户端不可用时的证据链（票 03 补）', () => {
  it('反查客户端抛错不 500：保留期内按可用处理，返回“暂不可读”节点，不写 raw_lost、不降级', async () => {
    const t = makeCtx() // now = 2026-10-29 20:36，保留期内
    setupHour(t, ['m1', 'm2'])
    await runHourV1(t)
    t.source.deletedIds.add('m1') // 本机没备份，只能靠客户端反查
    t.source.down = true // 客户端不可用

    const res = await evidenceTree(t.ctx, { level: 'hour', period: HOUR_09, version: 1, itemId: 1 }, true)
    // 本机没有备份的原文（m1、m2）都只能靠客户端反查，客户端不可用时全部“暂不可读”
    const unreadable = res.nodes.filter((n) => n.kind === 'unreadable')
    expect(unreadable).toEqual([
      { kind: 'unreadable', rawType: 'im', id: 'm1' },
      { kind: 'unreadable', rawType: 'im', id: 'm2' },
    ])
    // 不判丢失、不写 raw_lost、不降级
    expect(res.nodes.some((n) => n.kind === 'lost')).toBe(false)
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM raw_lost').n).toBe(0)
    expect(res.totals.degraded).toBe(0)
  })
})
