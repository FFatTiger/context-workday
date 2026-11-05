// 口径（spec 第 1 节、CONTEXT.md「参与」）：纯函数，备份和摘要流水线共用。
// 规则：@所有人不算；系统播报不算定向；全天日程不算；抄送、密送不算；私聊里任何消息都算。
import type { Settings } from './api-types.js'
import type { CalendarEvent, Contact, ImMessage, Mail } from './source/types.js'

export type ParticipationFlags = Settings['participation']

/** 一条消息是否触发某种开启的参与形态（系统消息一律不触发） */
export function triggersParticipation(msg: ImMessage, meId: string, myMsgIds: Set<string>, flags: ParticipationFlags): boolean {
  if (msg.isSystem) return false
  if (msg.senderId === meId) return flags.speak
  if (msg.mentions.includes(meId)) return flags.mention
  if (msg.replyToId !== null && myMsgIds.has(msg.replyToId)) return flags.reply
  if (msg.directedToMe) return flags.directed
  return false
}

/**
 * 参与会话：输入是同一个小时的消息（可跨会话）。
 * 某个会话该小时里有任一条消息满足一种开启的形态，就加入返回集合（ADR-0003）。
 */
export function participatingSessions(
  msgs: ImMessage[],
  meId: string,
  sessionTypes: ReadonlyMap<string, 'group' | 'private'>,
  flags: ParticipationFlags,
): Set<string> {
  const myMsgIds = new Set(msgs.filter((m) => m.senderId === meId).map((m) => m.id))
  const out = new Set<string>()
  for (const m of msgs) {
    const type = sessionTypes.get(m.sessionId)
    // 私聊里任何消息都算（系统消息除外）
    if (type === 'private' && !m.isSystem && flags.private) {
      out.add(m.sessionId)
      continue
    }
    if (type !== 'group') continue // 未知会话按群处理
    if (triggersParticipation(m, meId, myMsgIds, flags)) out.add(m.sessionId)
  }
  return out
}

/** 日程：我是组织者，或我是参会人且没有拒绝；全天日程不算 */
export function isRelatedEvent(ev: CalendarEvent, meId: string, flags: ParticipationFlags): boolean {
  if (!flags.events || ev.allDay) return false
  if (ev.organizer.id === meId) return true
  return ev.attendees.some((a) => a.id === meId && a.response !== 'declined')
}

/** 邮件：我发出的（folder/发件人判定），或收件人（To）里有我；抄送、密送不算 */
export function isRelatedMail(mail: Mail, meAddress: string, flags: ParticipationFlags): boolean {
  if (flags.sentMail && mail.from.address === meAddress) return true
  if (flags.toMail && mail.to.some((a) => a.address === meAddress)) return true
  return false
}

/** 我的邮箱：me().email 优先，否则通讯录里按 id 找（备份和小时摘要共用） */
export function myEmailAddress(me: Contact, contacts: Contact[]): string | null {
  return me.email ?? contacts.find((c) => c.id === me.id)?.email ?? null
}

/** 降噪：去掉系统消息；同一会话内文本完全相同的只留第一条（转发去重） */
export function denoise(msgs: ImMessage[]): ImMessage[] {
  const seen = new Set<string>()
  const out: ImMessage[] = []
  for (const m of msgs) {
    if (m.isSystem) continue
    const key = `${m.sessionId}\u0000${m.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}
