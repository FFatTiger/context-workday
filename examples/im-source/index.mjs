// Context 数据源模板：把内网 IM 包的数据映射成 Context 的数据源合同。
// 合同全文见 context-workday 包里的 docs/intranet.md 第 3 节（或 src/source/types.ts）。
// 只改标了 TODO 的地方。时间一律 epoch 毫秒；ID 一律字符串。
//
// 用法：
//   1. 把本目录复制到 ~/.context-workday/source/
//   2. 在该目录 npm i <内网 IM 包>，并在下面 import
//   3. ~/.context-workday/config.json 写 { "source": "./source/index.mjs" }
//   4. context-workday doctor   全部 ✓ 再 start

// TODO: 换成内网 IM 包
// import { createClient } from '@your-org/im-client'

class SourceUnavailableError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'SourceUnavailableError' // 名字必须是这个，Context 按名字识别"客户端不可用"
  }
}

/** @param {{ options: Record<string, unknown>, now(): number, log(m: string): void }} ctx */
export default async function createSource(ctx) {
  // TODO: 连接客户端。ctx.options 是 config.json 里的 sourceOptions，原样传进来
  // const client = await createClient(ctx.options)
  const client = null

  /** 把内网包的报错统一成 SourceUnavailableError（客户端没开、没登录、IPC 断开） */
  async function call(what, fn) {
    try {
      return await fn()
    } catch (e) {
      throw new SourceUnavailableError(`客户端 ${what} 失败：${e?.message ?? e}`, { cause: e })
    }
  }

  const toMs = (t) => (t < 1e12 ? t * 1000 : t) // 如果内网包给的是秒

  let meCache = null
  async function me() {
    // TODO: 当前登录用户
    meCache ??= await call('me', async () => ({ id: 'TODO', name: 'TODO' }))
    return meCache
  }

  return {
    name: '企业 IM 本机客户端',
    retentionDays: { im: 7, mail: 90, calendar: 90 },

    me,

    async contacts() {
      // TODO: 通讯录 → [{ id, name, email? }]
      return call('contacts', async () => [])
    },

    async sessions() {
      // TODO: 全部会话 → [{ id, name, type: 'group' | 'private' }]
      return call('sessions', async () => [])
    },

    async messages({ from, to }) {
      // TODO: 全部会话里 from <= time < to 的消息，含系统消息、含没参与的会话。
      // 内网包如果只能按会话取历史：遍历 sessions()，每个会话取这个时间段，再合并。
      const self = await me()
      const raw = await call('messages', async () => [])
      return raw.map((m) => ({
        id: String(m.id),
        sessionId: String(m.sessionId),
        senderId: String(m.senderId),
        senderName: m.senderName ?? '',
        time: toMs(m.time),
        text: m.text ?? '', // 非文本消息给可读描述，例如 "[图片]"、"[文件] 方案.pdf"
        kind: m.type ?? 'text',
        isSystem: Boolean(m.isSystem), // 入群、退群、撤回提示、系统播报、机器人通知
        mentions: (m.atList ?? []).filter((id) => id !== 'all').map(String), // 不含 @所有人
        mentionAll: (m.atList ?? []).includes('all'),
        replyToId: m.quoteId ? String(m.quoteId) : null, // 引用回复的原消息 ID
        directedToMe: Boolean(m.directedTo?.includes?.(self.id)), // 群里"定向发给我"
      }))
    },

    async events({ from, to }) {
      // TODO: 开始时间 from <= start < to 的日程
      return call('events', async () => [])
      // 每项：{ id, title, start, end, allDay, organizer: {id,name},
      //        attendees: [{id, name, response: 'accepted'|'tentative'|'declined'|'none'}],
      //        location, notes, updatedAt }
    },

    async mails({ from, to }) {
      // TODO: from <= time < to 的邮件，含已发送
      return call('mails', async () => [])
      // 每项：{ id, subject, from: {name,address}, to: [...], cc: [...], time, text(纯文本), folder: 'inbox'|'sent'|... }
    },

    // 可选：按 ID 查单条。实现了，证据链能更准确地区分"客户端还有"和"已丢失"
    // async findMessage(id) { return null },
    // async findMail(id) { return null },
    // async findEvent(id) { return null },

    async close() {
      // TODO: 断开客户端连接（没有就删掉）
    },
  }
}
