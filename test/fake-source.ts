// 可编程的假客户端：测试往里推消息、日程、邮件，能设 down、能删某条模拟过期/撤回。
// 后面的票（摘要流水线、调度）都复用这个文件。
import type { CalendarEvent, Contact, ImMessage, Mail, Person, Session, SourceAdapter, TimeRange } from '../src/source/types.js'
import { SourceUnavailableError } from '../src/source/types.js'

export class FakeSource implements SourceAdapter {
  readonly name = '假客户端（测试）'
  readonly retentionDays = { im: 7, mail: 90, calendar: 90 }

  mePerson: Person = { id: 'u_me', name: '我' }
  sessionsList: Session[] = []
  contactsList: Contact[] = [{ id: 'u_me', name: '我', email: 'me@corp.com' }]
  msgs: ImMessage[] = []
  eventsList: CalendarEvent[] = []
  mailsList: Mail[] = []

  down = false
  imDownDays = new Set<string>()
  /** 从客户端消失的消息 ID（模拟撤回/过期），findMessage 也查不到 */
  deletedIds = new Set<string>()
  /** 逐次脚本化 messages() 的返回（用完回落到 msgs）。元素 = 该次调用返回的消息 */
  messagesScript: Array<ImMessage[]> = []
  /** 整体接管 messages() 的返回（优先于 messagesScript/msgs），参数是调用序号 */
  messagesImpl: ((call: number, range: TimeRange) => ImMessage[]) | null = null
  /** 每次 messages() 调用后自增，配合脚本/接管模拟"读和核对之间又来了消息" */
  messagesCalls = 0

  private throwIfDown() {
    if (this.down) throw new SourceUnavailableError('假客户端：down')
  }
  private throwIfImDown(range: TimeRange) {
    for (const day of this.imDownDays) {
      const [y, mo, d] = day.split('-').map(Number)
      const from = Date.UTC(y, mo - 1, d) - 8 * 3600_000
      if (from < range.to && from + 86_400_000 > range.from) throw new SourceUnavailableError(`假客户端：${day} IM 不可用`)
    }
  }

  me(): Promise<Person> {
    this.throwIfDown()
    return Promise.resolve(this.mePerson)
  }
  contacts(): Promise<Contact[]> {
    this.throwIfDown()
    return Promise.resolve(this.contactsList)
  }
  sessions(): Promise<Session[]> {
    this.throwIfDown()
    return Promise.resolve(this.sessionsList)
  }

  async messages(range: TimeRange): Promise<ImMessage[]> {
    this.throwIfDown()
    this.throwIfImDown(range)
    const call = this.messagesCalls++
    const base =
      this.messagesImpl ? this.messagesImpl(call, range)
      : call < this.messagesScript.length ? this.messagesScript[call]
      : this.msgs
    return base.filter((m) => m.time >= range.from && m.time < range.to && !this.deletedIds.has(m.id))
  }
  async events(range: TimeRange): Promise<CalendarEvent[]> {
    this.throwIfDown()
    return this.eventsList.filter((e) => e.start >= range.from && e.start < range.to)
  }
  async mails(range: TimeRange): Promise<Mail[]> {
    this.throwIfDown()
    return this.mailsList.filter((m) => m.time >= range.from && m.time < range.to)
  }

  async findMessage(id: string): Promise<ImMessage | null> {
    this.throwIfDown()
    const m = this.msgs.find((x) => x.id === id)
    return m && !this.deletedIds.has(m.id) ? m : null
  }
  async findMail(id: string): Promise<Mail | null> {
    this.throwIfDown()
    return this.mailsList.find((x) => x.id === id) ?? null
  }
  async findEvent(id: string): Promise<CalendarEvent | null> {
    this.throwIfDown()
    return this.eventsList.find((x) => x.id === id) ?? null
  }

  // ── 便捷构造 ──
  addSession(id: string, name: string, type: 'group' | 'private' = 'group'): Session {
    const s = { id, name, type }
    this.sessionsList.push(s)
    return s
  }
  addMsg(partial: Partial<ImMessage> & Pick<ImMessage, 'id' | 'sessionId' | 'senderId' | 'time'>): ImMessage {
    const m: ImMessage = {
      senderName: partial.senderId === 'u_me' ? '我' : partial.senderId,
      text: '内容',
      kind: 'text',
      isSystem: false,
      mentions: [],
      mentionAll: false,
      replyToId: null,
      directedToMe: false,
      ...partial,
    }
    this.msgs.push(m)
    return m
  }
}
