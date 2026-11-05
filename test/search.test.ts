// 搜索（spec 第 10 节 / api-types 19）：范围、分词"与"、时间与来源筛选、只看与我有关、snippet 高亮、hint。
import { describe, expect, it } from 'vitest'
import { runBackup } from '../src/backup/run.js'
import { saveVersion } from '../src/summary/store.js'
import { makeSnippet, search, type SearchRange, type SearchSource } from '../src/search.js'
import { fromLocal } from '../src/time.js'
import { makeCtx } from './helpers.js'

const day = (mo: number, d: number, h = 0, mi = 0) => fromLocal(2026, mo, d, h, mi)

/** 造一个有摘要和备份原文的库 */
function setup() {
  const t = makeCtx({ now: day(10, 29, 20, 36) }) // 周四 20:36
  t.source.addSession('g1', '供应链对接')
  t.source.addSession('g2', '不相关群')
  t.source.addSession('p1', '王总', 'private')
  t.source.addMsg({ id: 'm_old', sessionId: 'g1', senderId: 'u_limin', time: day(10, 20, 9), text: '上周的预算口径文档我找不到了' })
  t.source.addMsg({ id: 'm0', sessionId: 'g1', senderId: 'u_me', time: day(10, 29, 10, 5), text: '我把预算初稿更新到共享文档了' }) // 我开口：g1 的 10 点参与
  t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_wang', time: day(10, 29, 10), text: '预算砍 8% 之后推广费再压一压' })
  t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_limin', time: day(10, 29, 10, 30), text: '收到，我看下明细' }) // 同会话×小时：随 m1 变成与我有关
  t.source.addMsg({ id: 'm3', sessionId: 'g2', senderId: 'u_zhaolei', time: day(10, 29, 11), text: '预算这事我不参与，只是提到预算两个字' }) // 不参与的会话
  t.source.addMsg({ id: 'm4', sessionId: 'p1', senderId: 'u_wang', time: day(10, 29, 10, 15), text: '私聊里聊预算' })

  t.source.mailsList.push({
    id: 'mail1', subject: '【预算】Q4 调整版', from: { name: '李敏', address: 'limin@corp.com' }, to: [{ name: '我', address: 'me@corp.com' }],
    cc: [], time: day(10, 29, 9), text: '调整后的预算明细见附件', folder: 'inbox',
  })
  t.source.eventsList.push({
    id: 'ev1', title: 'Q4 预算评审会', start: day(10, 29, 14), end: day(10, 29, 15), allDay: false,
    organizer: { id: 'u_me', name: '我' }, attendees: [{ id: 'u_me', name: '我', response: 'accepted' }],
    location: '会议室 C', notes: '过争议项', updatedAt: day(10, 29, 14),
  })

  return t
}

async function setupWithBackup() {
  const t = setup()
  await runBackup(t.ctx, 'im', 'manual')
  await runBackup(t.ctx, 'mail', 'manual')
  await runBackup(t.ctx, 'calendar', 'manual')
  saveVersion(t.db, {
    level: 'hour', period: '2026-10-29T10', createdAt: day(10, 29, 11, 5), trigger: 'scheduled', mode: 'full', model: 'fake',
    inputs: [], totalMsgs: 3, relatedMsgs: 3,
    items: [{ text: '在「供应链对接」推进：预算口径砍 8% 后调整推广费', op: 'add', refs: [{ type: 'im', rawId: 'm1' }] }],
  })
  saveVersion(t.db, {
    level: 'hour', period: '2026-10-20T09', createdAt: day(10, 20, 10, 5), trigger: 'scheduled', mode: 'full', model: 'fake',
    inputs: [], totalMsgs: 1, relatedMsgs: 1,
    items: [{ text: '找预算口径文档', op: 'add', refs: [{ type: 'im', rawId: 'm_old' }] }],
  })
  return t
}

const all = { q: '', range: 'all' as SearchRange, sources: ['summary', 'im', 'mail', 'event'] as SearchSource[], mine: true, page: 1 }

describe('搜索：范围与筛选', () => {
  it('关键词能命中摘要条目和已备份的原文，target 指向正确', async () => {
    const t = await setupWithBackup()
    const res = search(t.ctx, { ...all, q: '预算' })
    const types = res.items.map((h) => h.type).sort()
    expect(types).toContain('summary')
    expect(types).toContain('im')
    expect(types).toContain('mail')
    expect(types).toContain('event')
    const summary = res.items.find((h) => h.type === 'summary')!
    expect(summary.target).toEqual({ kind: 'item', ref: { level: 'hour', period: '2026-10-29T10', version: 1, itemId: 1 } })
    const im = res.items.find((h) => h.target.kind === 'im' && h.target.id === 'm1')!
    expect(im.target).toEqual({ kind: 'im', id: 'm1' })
    expect(im.source).toContain('供应链对接')
    // 与我有关的邮件详情字段
    expect(res.items.find((h) => h.type === 'mail')!.source).toBe('邮件「【预算】Q4 调整版」')
    expect(res.items.find((h) => h.type === 'event')!.source).toBe('日程「Q4 预算评审会」')
  })

  it('多个词按"与"组合；只看与我有关默认排除不参与会话的原文', async () => {
    const t = await setupWithBackup()
    const res = search(t.ctx, { ...all, q: '预算 初稿' })
    // 两个摘要都没有"初稿"，不命中；m0 两个词都有，m1 只有"预算"
    expect(res.items.some((h) => h.type === 'summary')).toBe(false)
    expect(res.items.filter((h) => h.type === 'im').map((h) => (h.target as { id: string }).id)).toEqual(['m0'])

    const mineOff = search(t.ctx, { ...all, q: '预算', mine: false })
    const ids = mineOff.items.filter((h) => h.type === 'im').map((h) => (h.target as { id: string }).id)
    expect(ids).toContain('m3') // 不参与的会话也能搜到
    expect(ids).toContain('m4') // 私聊
    const mineOn = search(t.ctx, { ...all, q: '预算', mine: true })
    expect(mineOn.items.filter((h) => h.type === 'im').map((h) => (h.target as { id: string }).id)).not.toContain('m3')
  })

  it('时间筛选：今天 / 本周 / 全部', async () => {
    const t = await setupWithBackup()
    const today = search(t.ctx, { ...all, q: '预算', range: 'today' })
    expect(today.items.every((h) => h.time >= day(10, 29))).toBe(true)
    expect(today.items.some((h) => h.time < day(10, 29))).toBe(false)
    // 本周从 10/26（周一）开始：10/20 的旧消息不出现
    const week = search(t.ctx, { ...all, q: '预算', range: 'week' })
    expect(week.items.every((h) => h.time >= day(10, 26))).toBe(true)
    const whole = search(t.ctx, { ...all, q: '预算', range: 'all' })
    expect(whole.items.some((h) => h.time < day(10, 26))).toBe(true)
  })

  it('来源多选：只搜 IM 时没有摘要结果', async () => {
    const t = await setupWithBackup()
    const res = search(t.ctx, { ...all, q: '预算', sources: ['im'] })
    expect(res.items.every((h) => h.type === 'im')).toBe(true)
    expect(res.total).toBe(res.items.length)
  })

  it('按时间倒序、每页 50 条；空结果给 hint，空关键词不给', async () => {
    const t = await setupWithBackup()
    const res = search(t.ctx, { ...all, q: '预算' })
    const times = res.items.map((h) => h.time)
    expect([...times].sort((a, b) => b - a)).toEqual(times)
    expect(res.pageSize).toBe(50)

    const none = search(t.ctx, { ...all, q: '绝不存在的词组' })
    expect(none.total).toBe(0)
    expect(none.hint).toBe('今天的原文会在下次 IM 备份后可搜')

    const empty = search(t.ctx, { ...all, q: '  ' })
    expect(empty.total).toBe(0)
    expect(empty.hint).toBeUndefined()
  })
})

describe('搜索：snippet 与高亮', () => {
  it('以第一个命中为中心截 80 字左右，highlights 标出所有命中', () => {
    const text = '前奏'.repeat(40) + '预算口径确认了，预算表在共享文档里，大家自己看预算' + '尾声'.repeat(40)
    const { snippet, highlights } = makeSnippet(text, ['预算'])
    expect(snippet.length).toBeLessThanOrEqual(82) // 80 字 + 可能的首尾省略号
    expect(snippet.startsWith('…')).toBe(true)
    for (const [s, e] of highlights) expect(snippet.slice(s, e)).toBe('预算')
    expect(highlights.length).toBe(3)
    // 命中在片段中心附近
    expect(highlights[0][0]).toBeGreaterThan(20)
  })

  it('片段内的高亮位置就是命中词本身（多词）', async () => {
    const t = await setupWithBackup()
    const res = search(t.ctx, { ...all, q: '预算 推广' })
    const im = res.items.find((h) => h.type === 'im')!
    expect(im.highlights.length).toBeGreaterThanOrEqual(2)
    for (const [s, e] of im.highlights) expect(['预算', '推广']).toContain(im.snippet.slice(s, e))
  })
})
