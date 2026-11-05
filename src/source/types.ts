// 数据源合同：Context 读取 企业 IM 客户端的唯一入口。
// 内网只需要实现这个接口（见 docs/intranet.md），系统其余部分都不碰客户端。
// 时间一律是 epoch 毫秒。ID 一律是客户端给的稳定 ID（字符串）。

export interface Person {
  id: string
  name: string
}

export interface Session {
  id: string
  name: string
  /** group = 群聊，private = 一对一私聊 */
  type: 'group' | 'private'
}

export interface ImMessage {
  id: string
  sessionId: string
  senderId: string
  senderName: string
  time: number
  /** 文本内容；非文本消息填可读描述，例如 "[图片]"、"[文件] 方案.pdf" */
  text: string
  /** text = 文本，其他值原样记录（image / file / card / ...） */
  kind: string
  /** 系统消息：入群、退群、撤回提示、系统播报等 */
  isSystem: boolean
  /** 被 @ 的人的 ID 列表（不含 @所有人） */
  mentions: string[]
  mentionAll: boolean
  /** 引用回复的那条消息 ID，没有就是 null */
  replyToId: string | null
  /** 客户端标记为"定向发给我"的群消息 */
  directedToMe: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: number
  end: number
  allDay: boolean
  organizer: Person
  attendees: Array<Person & { response: 'accepted' | 'tentative' | 'declined' | 'none' }>
  location: string
  notes: string
  /** 客户端里的最后修改时间；没有就填 start。用于判断日程变更 */
  updatedAt: number
}

export interface MailAddress {
  name: string
  address: string
}

export interface Mail {
  id: string
  subject: string
  from: MailAddress
  to: MailAddress[]
  cc: MailAddress[]
  time: number
  /** 纯文本正文（HTML 邮件请先转成纯文本） */
  text: string
  /** inbox / sent / 其他文件夹名 */
  folder: string
}

export interface Contact extends Person {
  email?: string
}

export interface TimeRange {
  /** 包含 */
  from: number
  /** 不包含 */
  to: number
}

/** 客户端没开、未登录、接口不可达时抛这个错。系统会记为失败并按规则重试。 */
export class SourceUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SourceUnavailableError'
  }
}

export interface SourceAdapter {
  /** 显示在设置页，例如 "企业 IM 本机客户端" */
  readonly name: string
  /** 客户端保留原文的天数。例如：IM 7 天，邮件 90 天，日程按实际 */
  readonly retentionDays: { im: number; mail: number; calendar: number }

  /** 当前登录的我。email 用来判断"我发出的 / 收件人是我"的邮件；不填就去通讯录里按 id 找 */
  me(): Promise<Contact>
  /** 通讯录（用于演示脱敏的人名识别） */
  contacts(): Promise<Contact[]>
  /** 客户端能看到的全部会话 */
  sessions(): Promise<Session[]>
  /** 全部会话里发送时间落在 range 内的消息（含系统消息、含没参与的会话） */
  messages(range: TimeRange): Promise<ImMessage[]>
  /** 开始时间落在 range 内的日程 */
  events(range: TimeRange): Promise<CalendarEvent[]>
  /** 收发时间落在 range 内的邮件，含已发送 */
  mails(range: TimeRange): Promise<Mail[]>

  /** 可选：按 ID 查单条原文，用于判断"本机没有时客户端还有没有"。不实现就视为客户端里没有 */
  findMessage?(id: string): Promise<ImMessage | null>
  findMail?(id: string): Promise<Mail | null>
  findEvent?(id: string): Promise<CalendarEvent | null>

  /** 可选：进程退出时调用 */
  close?(): Promise<void>
}

/**
 * 数据源模块的形状：默认导出一个工厂函数。
 * 配置里 `source` 指向模块路径或包名，系统用 import() 加载它。
 */
export type SourceFactory = (ctx: SourceContext) => SourceAdapter | Promise<SourceAdapter>

export interface SourceContext {
  /** 配置文件里 sourceOptions 原样传入 */
  options: Record<string, unknown>
  /** 当前时间（演示和测试时是虚拟时钟） */
  now(): number
  log(message: string): void
}
