import { describe, expect, it } from 'vitest'
import type { ImMessage } from '../src/source/types.js'
import { DEFAULT_SETTINGS } from '../src/settings.js'
import { denoise, isRelatedEvent, isRelatedMail, participatingSessions } from '../src/participation.js'

const flags = DEFAULT_SETTINGS.participation
const ME = 'u_me'

function msg(partial: Partial<ImMessage> & Pick<ImMessage, 'id' | 'sessionId' | 'senderId'>): ImMessage {
  return {
    senderName: partial.senderId,
    time: Date.UTC(2026, 9, 29, 9, 30),
    text: '内容',
    kind: 'text',
    isSystem: false,
    mentions: [],
    mentionAll: false,
    replyToId: null,
    directedToMe: false,
    ...partial,
  }
}
const types = (ids: string[], type: 'group' | 'private' = 'group') => new Map(ids.map((id) => [id, type]))

describe('口径：参与会话（spec 第 1 节 / spec 测试 2）', () => {
  it('别人没 @我 的拍板消息，所在会话因为我开过口而算参与', () => {
    const msgs = [
      msg({ id: 'm1', sessionId: 'g1', senderId: ME, text: '预算调整版我发大家了' }),
      msg({ id: 'm2', sessionId: 'g1', senderId: 'u_wang', text: '就这么定了，按这版报上去' }), // 拍板，没 @我
    ]
    expect(participatingSessions(msgs, ME, types(['g1']), flags)).toEqual(new Set(['g1']))
  })

  it('只有 @所有人 的会话不算参与（系统播报也不算）', () => {
    const msgs = [
      msg({ id: 'm1', sessionId: 'g_big', senderId: 'u_a', text: '@所有人 明晚机房割接', mentionAll: true }),
      msg({ id: 'm2', sessionId: 'g_big', senderId: 'u_b', text: '收到' }),
      msg({ id: 'm3', sessionId: 'g_big', senderId: 'u_bot', text: 'xx 撤回了一条消息', isSystem: true }),
    ]
    expect(participatingSessions(msgs, ME, types(['g_big']), flags)).toEqual(new Set())
  })

  it('五种形态各自都能开启参与，@我 不含 @所有人', () => {
    const mk = (id: string, extra: Partial<ImMessage>) => [msg({ id, sessionId: `g_${id}`, senderId: 'u_a', ...extra })]
    const t = types(['g_a', 'g_b', 'g_c', 'g_d', 'g_e', 'g_f'])
    expect(participatingSessions(mk('a', {}), ME, t, flags)).toEqual(new Set()) // 别人说话不算
    expect(participatingSessions([{ ...msg({ id: 'm', sessionId: 'g_a', senderId: ME }) }], ME, t, flags)).toEqual(new Set(['g_a'])) // 我开口
    expect(participatingSessions(mk('b', { mentions: [ME] }), ME, t, flags)).toEqual(new Set(['g_b'])) // @我
    expect(participatingSessions(mk('c', { replyToId: 'm_mine' }), ME, t, flags)).toEqual(new Set()) // 回复的不是我的消息
    const mine = msg({ id: 'm_mine', sessionId: 'g_d', senderId: ME })
    expect(participatingSessions([mine, msg({ id: 'm2', sessionId: 'g_d', senderId: 'u_a', replyToId: 'm_mine' })], ME, t, flags)).toEqual(new Set(['g_d'])) // 回复我
    expect(participatingSessions(mk('e', { directedToMe: true }), ME, t, flags)).toEqual(new Set(['g_e'])) // 定向发给我
    expect(participatingSessions([msg({ id: 'm1', sessionId: 'p1', senderId: 'u_a' })], ME, types(['p1'], 'private'), flags)).toEqual(new Set(['p1'])) // 私聊任何消息
  })

  it('关闭对应开关后该形态不再触发；系统消息在私聊里也不触发', () => {
    const off = { ...flags, mention: false, private: false }
    const t = types(['g1', 'p1'], 'group')
    t.set('p1', 'private')
    const msgs = [
      msg({ id: 'm1', sessionId: 'g1', senderId: 'u_a', mentions: [ME] }),
      msg({ id: 'm2', sessionId: 'p1', senderId: 'u_a' }),
      msg({ id: 'm3', sessionId: 'p1', senderId: 'u_sys', isSystem: true }),
    ]
    expect(participatingSessions(msgs, ME, t, off)).toEqual(new Set())
  })
})

describe('口径：日程与邮件', () => {
  const ev = (p: Partial<Parameters<typeof isRelatedEvent>[0]>) =>
    ({
      id: 'e1',
      title: '会',
      start: 0,
      end: 1,
      allDay: false,
      organizer: { id: 'u_a', name: 'a' },
      attendees: [],
      location: '',
      notes: '',
      updatedAt: 0,
      ...p,
    }) as Parameters<typeof isRelatedEvent>[0]

  it('组织者或未拒绝的参会人算，拒绝和全天不算', () => {
    expect(isRelatedEvent(ev({ organizer: { id: ME, name: '我' } }), ME, flags)).toBe(true)
    expect(isRelatedEvent(ev({ attendees: [{ id: ME, name: '我', response: 'accepted' }] }), ME, flags)).toBe(true)
    expect(isRelatedEvent(ev({ attendees: [{ id: ME, name: '我', response: 'declined' }] }), ME, flags)).toBe(false)
    expect(isRelatedEvent(ev({ allDay: true, attendees: [{ id: ME, name: '我', response: 'accepted' }] }), ME, flags)).toBe(false)
    expect(isRelatedEvent(ev({}), ME, flags)).toBe(false)
  })

  const mail = (p: Partial<Parameters<typeof isRelatedMail>[0]>) =>
    ({
      id: 'mail1',
      subject: '',
      from: { name: 'a', address: 'a@corp.com' },
      to: [],
      cc: [],
      time: 0,
      text: '',
      folder: 'inbox',
      ...p,
    }) as Parameters<typeof isRelatedMail>[0]
  const ME_ADDR = 'me@corp.com'

  it('我发出的或 To 有我的算；抄送、密送不算', () => {
    expect(isRelatedMail(mail({ from: { name: '我', address: ME_ADDR }, folder: 'sent' }), ME_ADDR, flags)).toBe(true)
    expect(isRelatedMail(mail({ to: [{ name: '我', address: ME_ADDR }] }), ME_ADDR, flags)).toBe(true)
    expect(isRelatedMail(mail({ cc: [{ name: '我', address: ME_ADDR }] }), ME_ADDR, flags)).toBe(false)
    expect(isRelatedMail(mail({}), ME_ADDR, flags)).toBe(false)
    expect(isRelatedMail(mail({ from: { name: '我', address: ME_ADDR } }), ME_ADDR, { ...flags, sentMail: false })).toBe(false)
  })
})

describe('口径：降噪', () => {
  it('系统消息不进输入；同会话同文本只留第一条，不同会话互不影响', () => {
    const msgs = [
      msg({ id: 'm1', sessionId: 'g1', senderId: 'u_a', text: '看板 2.0 灰度开了' }),
      msg({ id: 'm2', sessionId: 'g1', senderId: 'u_sys', text: 'xx 撤回了一条消息', isSystem: true }),
      msg({ id: 'm3', sessionId: 'g1', senderId: 'u_b', text: '看板 2.0 灰度开了' }), // 同文本转发
      msg({ id: 'm4', sessionId: 'g2', senderId: 'u_b', text: '看板 2.0 灰度开了' }), // 别的会话保留
    ]
    expect(denoise(msgs).map((m) => m.id)).toEqual(['m1', 'm4'])
  })
})
