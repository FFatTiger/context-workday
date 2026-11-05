import { describe, expect, it } from 'vitest'
import type { SourceContext } from '../src/source/types.js'
import { SourceUnavailableError } from '../src/source/types.js'
import { createMockSource } from '../src/source/mock.js'
import { DAY_MS, HOUR_MS, fromLocal, hourKey } from '../src/time.js'

// 固定的"现在"：2026-10-29 周四 20:36（与效果图同一天）
const NOW = fromLocal(2026, 10, 29, 20, 36)
const mk = (options: Record<string, unknown> = {}) => createMockSource({ options, now: () => NOW, log: () => {} } as SourceContext)

describe('仿真客户端：确定性', () => {
  it('同一范围查两次结果完全一致（任意切法）', async () => {
    const src = mk()
    const week = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    const again = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    expect(again).toEqual(week)

    // 换一种范围切法，重叠部分逐条一致
    const part = await src.messages({ from: NOW - 3 * DAY_MS, to: NOW - 1 * DAY_MS })
    const from3 = week.filter((m) => m.time >= NOW - 3 * DAY_MS && m.time < NOW - 1 * DAY_MS)
    expect(part).toEqual(from3)

    // 不同实例（不同调用历史）结果一致
    const src2 = mk()
    expect(await src2.messages({ from: NOW - 7 * DAY_MS, to: NOW })).toEqual(week)
  })

  it('findMessage / findMail / findEvent 按 ID 反查一致', async () => {
    const src = mk()
    const week = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    const m = week[Math.floor(week.length / 2)]
    expect(await src.findMessage?.(m.id)).toEqual(m)
    const mails = await src.mails({ from: NOW - 90 * DAY_MS, to: NOW })
    expect(await src.findMail?.(mails[10].id)).toEqual(mails[10])
    const evs = await src.events({ from: NOW - 90 * DAY_MS, to: NOW + 30 * DAY_MS })
    expect(await src.findEvent?.(evs[5].id)).toEqual(evs[5])
    expect(await src.findMessage?.('m_1999010100_000')).toBeNull()
  })
})

describe('仿真客户端：保留期与未来数据', () => {
  it('消息只返回 now-7d 之后、now 之前；邮件 90 天；日程 now-90d..now+30d', async () => {
    const src = mk()
    const msgs = await src.messages({ from: NOW - 90 * DAY_MS, to: NOW + 2 * DAY_MS })
    expect(msgs.length).toBeGreaterThan(0)
    for (const m of msgs) {
      expect(m.time).toBeGreaterThan(NOW - 7 * DAY_MS)
      expect(m.time).toBeLessThanOrEqual(NOW)
    }
    const mails = await src.mails({ from: NOW - 365 * DAY_MS, to: NOW + 2 * DAY_MS })
    for (const m of mails) {
      expect(m.time).toBeGreaterThan(NOW - 90 * DAY_MS)
      expect(m.time).toBeLessThanOrEqual(NOW)
    }
    const evs = await src.events({ from: NOW - 365 * DAY_MS, to: NOW + 60 * DAY_MS })
    expect(evs.length).toBeGreaterThan(0)
    for (const e of evs) {
      expect(e.start).toBeGreaterThanOrEqual(NOW - 90 * DAY_MS)
      expect(e.start).toBeLessThan(NOW + 31 * DAY_MS)
    }
  })

  it('retentionDays = im 7 / mail 90 / calendar 90', async () => {
    expect(mk().retentionDays).toEqual({ im: 7, mail: 90, calendar: 90 })
  })
})

describe('仿真客户端：工作流形态', () => {
  const src = mk()

  it('一周内五种参与形态都出现过', async () => {
    const week = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    const sessions = await src.sessions()
    const privIds = new Set(sessions.filter((s) => s.type === 'private').map((s) => s.id))
    const myIds = new Set(week.filter((m) => m.senderId === 'u_me').map((m) => m.id))

    expect(week.some((m) => m.senderId === 'u_me')).toBe(true) // 我开口
    expect(week.some((m) => m.mentions.includes('u_me'))).toBe(true) // @我
    expect(week.some((m) => m.replyToId !== null && myIds.has(m.replyToId))).toBe(true) // 回复我
    expect(week.some((m) => privIds.has(m.sessionId))).toBe(true) // 私聊
    expect(week.some((m) => m.directedToMe)).toBe(true) // 定向发给我
  })

  it('有撤回：存在撤回系统提示，且原消息查不到', async () => {
    const week = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    const recalls = week.filter((m) => m.kind === 'recall' && m.isSystem)
    expect(recalls.length).toBeGreaterThan(0)
    expect(recalls[0].text).toMatch(/撤回了一条消息/)
    // 撤回发生在原消息 30 分钟后，原消息 ID 在同小时内不存在
    const hourStart = recalls[0].time - (recalls[0].time % HOUR_MS)
    const hour = await src.messages({ from: hourStart, to: hourStart + HOUR_MS })
    const prefix = `m_${hourKey(recalls[0].time).replaceAll('-', '').replace('T', '')}`
    expect(hour.every((m) => m.id.startsWith(prefix))).toBe(true)
  })

  it('吵闹群以系统播报和闲聊为主；有只 @所有人 的会话；有非文本消息和同文本转发', async () => {
    const week = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    const dept = week.filter((m) => m.sessionId === 'g_dept')
    expect(dept.length).toBeGreaterThan(200) // 每小时十几条
    const ann = week.filter((m) => m.sessionId === 'g_ann' && !m.isSystem)
    expect(ann.length).toBeGreaterThan(0)
    expect(ann.every((m) => m.mentionAll)).toBe(true)
    expect(week.some((m) => m.kind === 'image' || m.kind === 'file')).toBe(true)
    // 同会话同小时同文本的转发
    const seen = new Set<string>()
    let dupFound = false
    for (const m of week) {
      const key = `${m.sessionId}|${hourKey(m.time)}|${m.text}`
      if (seen.has(key)) dupFound = true
      seen.add(key)
    }
    expect(dupFound).toBe(true)
  })

  it('节奏：工作时段密集，深夜稀疏，存在整小时无我参与的空档', async () => {
    const week = await src.messages({ from: NOW - 7 * DAY_MS, to: NOW })
    const byHour = new Map<number, number>()
    for (const m of week) byHour.set(m.time - (m.time % HOUR_MS), (byHour.get(m.time - (m.time % HOUR_MS)) ?? 0) + 1)
    const work = [...byHour.entries()].filter(([t]) => {
      const h = new Date(t + 8 * HOUR_MS).getUTCHours()
      return h >= 9 && h < 12
    })
    const night = [...byHour.entries()].filter(([t]) => {
      const h = new Date(t + 8 * HOUR_MS).getUTCHours()
      return h >= 0 && h < 6
    })
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
    expect(avg(work.map(([, n]) => n))).toBeGreaterThan(avg(night.map(([, n]) => n)))

    const mine = new Set(week.filter((m) => m.senderId === 'u_me').map((m) => m.time - (m.time % HOUR_MS)))
    expect(mine.size).toBeLessThan(byHour.size) // 大多数小时我没有参与
  })

  it('通讯录约 20 人、会话 14 个、我是陈思远', async () => {
    expect(await src.me()).toEqual({ id: 'u_me', name: '陈思远' })
    const contacts = await src.contacts()
    expect(contacts.length).toBeGreaterThanOrEqual(20)
    expect(contacts.every((c) => c.email?.endsWith('@example.com'))).toBe(true)
    const sessions = await src.sessions()
    expect(sessions).toHaveLength(14)
    expect(sessions.filter((s) => s.type === 'private')).toHaveLength(5)
  })

  it('日程：工作日 1–3 个，有全天/拒绝/与我无关，邮件有我发的和只抄送我的', async () => {
    const evs = await src.events({ from: NOW - 60 * DAY_MS, to: NOW })
    const byDay = new Map<string, number>()
    for (const e of evs) byDay.set(new Date(e.start + 8 * HOUR_MS).toISOString().slice(0, 10), (byDay.get(new Date(e.start + 8 * HOUR_MS).toISOString().slice(0, 10)) ?? 0) + 1)
    for (const n of byDay.values()) expect(n).toBeLessThanOrEqual(3)
    expect(evs.some((e) => e.allDay)).toBe(true)
    expect(evs.some((e) => e.attendees.some((a) => a.id === 'u_me' && a.response === 'declined'))).toBe(true)
    expect(evs.some((e) => e.organizer.id !== 'u_me' && !e.attendees.some((a) => a.id === 'u_me'))).toBe(true)

    const mails = await src.mails({ from: NOW - 30 * DAY_MS, to: NOW })
    expect(mails.some((m) => m.from.address === 'chensiyuan@example.com' && m.folder === 'sent')).toBe(true)
    expect(mails.some((m) => m.cc.some((a) => a.address === 'chensiyuan@example.com') && !m.to.some((a) => a.address === 'chensiyuan@example.com'))).toBe(true)
    for (const m of mails) expect(m.text.split('\n').length).toBeGreaterThanOrEqual(2)
  })
})

describe('仿真客户端：故障注入', () => {
  it('imDownDays 里的日期抛 SourceUnavailableError，其他来源不受影响', async () => {
    const src = mk({ imDownDays: ['2026-10-28'] })
    await expect(src.messages({ from: NOW - 3 * DAY_MS, to: NOW })).rejects.toThrow(SourceUnavailableError)
    // 不碰那天的范围不抛
    await expect(src.messages({ from: fromLocal(2026, 10, 29, 0, 30), to: NOW })).resolves.toBeDefined()
    await expect(src.mails({ from: NOW - 3 * DAY_MS, to: NOW })).resolves.toBeDefined()
  })

  it('down 时全部方法抛错', async () => {
    const src = mk({ down: true })
    await expect(src.me()).rejects.toThrow(SourceUnavailableError)
    await expect(src.messages({ from: NOW - DAY_MS, to: NOW })).rejects.toThrow(SourceUnavailableError)
    await expect(src.events({ from: NOW - DAY_MS, to: NOW })).rejects.toThrow(SourceUnavailableError)
    await expect(src.mails({ from: NOW - DAY_MS, to: NOW })).rejects.toThrow(SourceUnavailableError)
    await expect(src.findMessage?.('m_2026102909_000')).rejects.toThrow(SourceUnavailableError)
  })
})

describe('仿真客户端：消息字段完整', () => {
  it('每条消息都有发送者（回归：只有一个发言人的阶段里，同文本转发素材曾缺 senderId）', async () => {
    const src = createMockSource({
      options: {},
      now: () => fromLocal(2026, 9, 12, 20, 0),
      log: () => {},
    } as SourceContext)
    const msgs = await src.messages({ from: fromLocal(2026, 9, 10, 0, 0), to: fromLocal(2026, 9, 12, 23, 0) })
    expect(msgs.length).toBeGreaterThan(0)
    for (const m of msgs) {
      expect(m.senderId).toBeTruthy()
      expect(m.senderName).toBeTruthy()
    }
  })
})
