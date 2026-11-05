// 演示脱敏（spec 第 11 节 / spec 测试 12）：规则逐条 + 出口中间件下各接口结果一致、群编号固定。
import { describe, expect, it } from 'vitest'
import { runBackup } from '../src/backup/run.js'
import { saveVersion } from '../src/summary/store.js'
import { Redactor, redactMoney, redactName } from '../src/redact.js'
import { createApp } from '../src/server/app.js'
import { fromLocal } from '../src/time.js'
import { makeCtx } from './helpers.js'

const day = (mo: number, d: number, h = 0, mi = 0) => fromLocal(2026, mo, d, h, mi)

function seedDb(t: ReturnType<typeof makeCtx>) {
  const db = t.db
  const contact = db.prepare('INSERT INTO contacts (id, name, email) VALUES (?, ?, ?)')
  contact.run('u_me', '陈思远', 'chensiyuan@corp.com')
  contact.run('u_limin', '李敏', 'limin@corp.com')
  contact.run('u_liminmin', '李敏敏', 'liminmin@corp.com')
  contact.run('u_wang', '王总', 'wangzong@corp.com')
  const sess = db.prepare('INSERT INTO sessions (id, name, type) VALUES (?, ?, ?)')
  sess.run('g_budget', 'Q4 预算评审', 'group')
  sess.run('g_supply', '供应链对接', 'group')
  sess.run('p_wang', '王总', 'private')
  const msg = db.prepare(`INSERT INTO im_messages
    (id, session_id, sender_id, sender_name, time, text, kind, is_system, mentions, mention_all, directed_to_me, related_to_me, backed_up_at)
    VALUES (?, ?, ?, ?, ?, ?, 'text', 0, '[]', 0, 0, 1, ?)`)
  msg.run('m1', 'g_budget', 'u_limin', '李敏敏', day(10, 29, 10), '预算砍 8% 之后推广费再压', day(10, 29, 20))
}

describe('脱敏规则', () => {
  it('人名：保留姓其余每字换 *，长名字先换', () => {
    const t = makeCtx()
    seedDb(t)
    const r = new Redactor(t.db)
    expect(r.redactString('李敏提到李敏敏')).toBe('李*提到李**')
    expect(r.redactString('王总在群里说话')).toBe('王*在群里说话')
    expect(redactName('李敏')).toBe('李*')
    expect(redactName('王总')).toBe('王*')
  })

  it('群名换成「群 N」，编号用 alias_no 持久保存；私聊字段显示「私聊 · 王*」', () => {
    const t = makeCtx()
    seedDb(t)
    const r1 = new Redactor(t.db)
    expect(r1.redactString('在「Q4 预算评审」推进，供应链对接同步处理')).toBe('在「群 1」推进，群 2同步处理')
    // 新建 Redactor（下一次请求）编号不变
    const r2 = new Redactor(t.db)
    expect(r2.redactString('Q4 预算评审')).toBe('群 1')
    expect(t.db.prepare('SELECT alias_no FROM sessions WHERE id = ?').get('g_budget')).toEqual({ alias_no: 1 })
    expect(t.db.prepare('SELECT alias_no FROM sessions WHERE id = ?').get('g_supply')).toEqual({ alias_no: 2 })
    // 私聊只在 session 字段整串替换；普通位置按人名规则
    expect(r2.redactString('王总', 'session')).toBe('私聊 · 王*')
    expect(r2.redactString('发给王总')).toBe('发给王*')
  })

  it('金额换 ***，百分比和时间不动；邮箱 @ 前只留第一个字符', () => {
    const t = makeCtx()
    seedDb(t)
    const r = new Redactor(t.db)
    expect(r.redactString('服务器 300 元和 ¥1,200 的费用')).toBe('服务器 ***和 *** 的费用')
    expect(r.redactString('预算 500 万砍到 3.5 万元')).toBe('预算 ***砍到 ***')
    expect(r.redactString('砍 8%，明天 14:00 评审')).toBe('砍 8%，明天 14:00 评审')
    expect(r.redactString('加载时长降了 40%，P99 210ms')).toBe('加载时长降了 40%，P99 210ms')
    expect(redactMoney('100 万人在线')).toBe('100 万人在线') // 万后跟量词不算金额
    expect(r.redactString('发到 limin@corp.com 抄送 chensiyuan@corp.com')).toBe('发到 l***@corp.com 抄送 c***@corp.com')
  })

  it('递归替换 JSON 里的字符串，结构字段（id、period 等）不动', () => {
    const t = makeCtx()
    seedDb(t)
    const r = new Redactor(t.db)
    const out = r.json({
      id: 'm_2026102910_000',
      period: '2026-10-29T10',
      level: 'hour',
      version: 2,
      time: 1770000000000,
      text: '李敏在 Q4 预算评审提到 300 元',
      nested: { items: [{ itemId: 1, text: '王总拍板', session: '王总' }] },
    }) as Record<string, unknown>
    expect(out['id']).toBe('m_2026102910_000')
    expect(out['period']).toBe('2026-10-29T10')
    expect(out['text']).toBe('李*在 群 1提到 ***')
    const nested = out['nested'] as { items: Array<{ itemId: number; text: string; session: string }> }
    expect(nested.items[0].itemId).toBe(1)
    expect(nested.items[0].text).toBe('王*拍板')
    expect(nested.items[0].session).toBe('私聊 · 王*')
  })
})

describe('脱敏：出口中间件（spec 测试 12）', () => {
  it('开启后各接口一致替换，群编号固定；关闭后恢复', async () => {
    const t = makeCtx({ now: day(10, 29, 20, 36) })
    t.source.addSession('g_budget', 'Q4 预算评审')
    t.source.addMsg({ id: 'm1', sessionId: 'g_budget', senderId: 'u_me', time: day(10, 29, 10), text: '预算口径确认，发给王总' })
    await runBackup(t.ctx, 'im', 'manual')
    saveVersion(t.db, {
      level: 'hour', period: '2026-10-29T10', createdAt: day(10, 29, 11, 5), trigger: 'scheduled', mode: 'full', model: 'fake',
      inputs: [], totalMsgs: 1, relatedMsgs: 1,
      items: [{ text: '在「Q4 预算评审」推进：预算口径确认', op: 'add', refs: [{ type: 'im', rawId: 'm1' }] }],
    })
    const app = createApp(t.ctx, null)

    // 关：原文照出
    const rawSearch = await (await app.request('/api/search?q=预算&range=all')).json() as { items: Array<{ source: string; snippet: string; target: { kind: string; ref?: { period: string } } }> }
    expect(JSON.stringify(rawSearch)).toContain('Q4 预算评审')

    // 开：保存 redact=true 后所有 /api 出口统一替换
    const put = await app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redact: true }) })
    expect(put.status).toBe(200)

    const search2 = await (await app.request('/api/search?q=预算&range=all')).json() as typeof rawSearch
    const body2 = JSON.stringify(search2)
    expect(body2).toContain('群 1')
    expect(body2).not.toContain('Q4 预算评审')
    // 结构字段不动：周期键原样
    const hit = search2.items.find((i) => i.target.kind === 'item')!
    expect(hit.target.ref!.period).toBe('2026-10-29T10')

    // 时间线同样替换，且同一个群编号一致
    const timeline = await (await app.request('/api/timeline?date=2026-10-29')).json() as { hours: Array<{ items: Array<{ text: string }> }> }
    const tlBody = JSON.stringify(timeline)
    expect(tlBody).toContain('在「群 1」推进')
    expect(tlBody).not.toContain('Q4 预算评审')

    // 状态接口同步开关
    const status = await (await app.request('/api/status')).json() as { redact: boolean }
    expect(status.redact).toBe(true)

    // 关掉恢复
    await app.request('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redact: false }) })
    const search3 = await (await app.request('/api/search?q=预算&range=all')).text()
    expect(search3).toContain('Q4 预算评审')
    expect(search3).not.toContain('群 1」')
  })
})
