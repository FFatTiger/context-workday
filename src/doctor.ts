// 数据源自检（doctor，内网对接的关键工具）：逐项检查数据源模块是否符合 src/source/types.ts 的合同。
// 打印 ✓ / ✗（带原因），有 ✗ 时退出码 1；警告（⚠）不失败，但提示内网同事检查字段映射。
// 返回值 true = 全部通过。
import { DEFAULT_SETTINGS } from './settings.js'
import { isRelatedEvent, isRelatedMail, myEmailAddress, participatingSessions } from './participation.js'
import type { CalendarEvent, Contact, ImMessage, Mail, Session, SourceAdapter } from './source/types.js'
import { DAY_MS, HOUR_MS, fmt } from './time.js'

const CHECK_TIMEOUT_MS = 30_000
/** 一类问题最多展示几条样例 */
const SAMPLES = 3
/** replyToId 找不到时最多反查多少条 findMessage */
const REPLY_LOOKUP_LIMIT = 20

class Report {
  passes = 0
  fails = 0
  warns = 0
  constructor(private log: (m: string) => void) {}
  ok(msg: string) {
    this.passes++
    this.log(`✓ ${msg}`)
  }
  fail(msg: string) {
    this.fails++
    this.log(`✗ ${msg}`)
  }
  warn(msg: string) {
    this.warns++
    this.log(`⚠ ${msg}`)
  }
}

async function step<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('超过 30 秒未返回')), CHECK_TIMEOUT_MS)),
    ])
    return { ok: true, value }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

// ───────── 形状校验（类型、必填、枚举值）─────────

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isStr = (v: unknown): v is string => typeof v === 'string'
const isMs = (v: unknown, now: number, maxFutureDays: number): boolean =>
  typeof v === 'number' && Number.isFinite(v) && v > 1e12 && v <= now + maxFutureDays * DAY_MS

function dupIds(rows: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const r of rows) {
    const id = r['id']
    if (!isStr(id)) continue
    if (seen.has(id)) dup.add(id)
    seen.add(id)
  }
  return [...dup]
}

/** 校验一批列表返回的共同部分：是数组、每项有 id（非空字符串）、id 不重复。返回逐条问题 */
function checkList(label: string, r: Report, raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    r.fail(`${label}：返回的不是数组（${typeof raw}）`)
    return []
  }
  const rows = raw.filter(isObj)
  if (rows.length !== raw.length) r.fail(`${label}：${raw.length - rows.length} 项不是对象`)
  const noId = rows.filter((row) => !isStr(row['id']) || row['id'] === '')
  if (noId.length) r.fail(`${label}：${noId.length} 项的 id 缺失或不是字符串`)
  const dup = dupIds(rows)
  if (dup.length) r.fail(`${label}：id 重复（${dup.slice(0, SAMPLES).join('、')}${dup.length > SAMPLES ? ' 等' : ''}）`)
  return rows
}

function checkMessage(m: Record<string, unknown>, now: number): string[] {
  const problems: string[] = []
  for (const key of ['sessionId', 'senderId', 'senderName', 'text', 'kind'] as const) {
    if (!isStr(m[key]) || (key !== 'text' && m[key] === '')) problems.push(`缺 ${key}`)
  }
  if (!isMs(m['time'], now, 1)) problems.push(`time 不是毫秒（值 ${String(m['time'])}）`)
  for (const key of ['isSystem', 'mentionAll', 'directedToMe'] as const) {
    if (typeof m[key] !== 'boolean') problems.push(`${key} 不是布尔值`)
  }
  if (!Array.isArray(m['mentions']) || m['mentions'].some((x) => !isStr(x))) problems.push('mentions 不是字符串数组')
  if (m['replyToId'] !== null && !isStr(m['replyToId'])) problems.push('replyToId 不是字符串或 null')
  return problems
}

function checkEvent(e: Record<string, unknown>, now: number): string[] {
  const problems: string[] = []
  if (!isStr(e['title']) || e['title'] === '') problems.push('缺 title')
  if (!isMs(e['start'], now, 31)) problems.push(`start 不是毫秒（值 ${String(e['start'])}）`)
  if (typeof e['end'] !== 'number' || !Number.isFinite(e['end'])) problems.push('end 不是数字')
  if (typeof e['allDay'] !== 'boolean') problems.push('allDay 不是布尔值')
  const org = e['organizer']
  if (!isObj(org) || !isStr(org['id']) || !isStr(org['name'])) problems.push('organizer 缺 id/name')
  const atts = e['attendees']
  if (!Array.isArray(atts)) problems.push('attendees 不是数组')
  else
    for (const a of atts) {
      if (!isObj(a) || !isStr(a['id']) || !isStr(a['name']) || !['accepted', 'tentative', 'declined', 'none'].includes(String(a['response'])))
        problems.push('attendee 缺 id/name 或 response 不在枚举里')
    }
  for (const key of ['location', 'notes'] as const) {
    if (!isStr(e[key])) problems.push(`缺 ${key}`)
  }
  if (!isMs(e['updatedAt'], now, 31)) problems.push(`updatedAt 不是毫秒（值 ${String(e['updatedAt'])}）`)
  return problems
}

function checkMail(m: Record<string, unknown>, now: number): string[] {
  const problems: string[] = []
  if (!isStr(m['subject'])) problems.push('缺 subject')
  const addrOk = (a: unknown) => isObj(a) && isStr(a['name']) && isStr(a['address'])
  if (!addrOk(m['from'])) problems.push('from 缺 name/address')
  for (const key of ['to', 'cc'] as const) {
    if (!Array.isArray(m[key]) || m[key].some((a) => !addrOk(a))) problems.push(`${key} 不是 MailAddress 数组`)
  }
  if (!isMs(m['time'], now, 1)) problems.push(`time 不是毫秒（值 ${String(m['time'])}）`)
  if (!isStr(m['text'])) problems.push('缺 text')
  if (!isStr(m['folder'])) problems.push('缺 folder')
  return problems
}

// ───────── doctor 主流程 ─────────

export async function runDoctor(source: SourceAdapter, log: (m: string) => void, now = Date.now()): Promise<boolean> {
  const r = new Report(log)
  log(`检查数据源：${source.name}`)

  // 1. retentionDays
  const ret = source.retentionDays as unknown
  if (
    isObj(ret) &&
    (['im', 'mail', 'calendar'] as const).every((k) => typeof ret[k] === 'number' && Number.isInteger(ret[k]) && (ret[k] as number) > 0)
  ) {
    r.ok(`retentionDays：IM ${ret['im']} 天 / 邮件 ${ret['mail']} 天 / 日程 ${ret['calendar']} 天`)
  } else {
    r.fail(`retentionDays：三个字段（im/mail/calendar）都要是正整数，实际 ${JSON.stringify(ret)}`)
  }

  // 2. 基础方法逐个调用（30s 超时）
  const meRes = await step(() => source.me())
  if (!meRes.ok) {
    r.fail(`me()：${meRes.error}`)
  } else if (!isObj(meRes.value) || !isStr(meRes.value['id']) || meRes.value['id'] === '' || !isStr(meRes.value['name'])) {
    r.fail(`me()：需要非空的 id 和 name，实际 ${JSON.stringify(meRes.value)}`)
  } else {
    r.ok(`me()：${String(meRes.value['name'])}（${String(meRes.value['id'])}）`)
  }

  const contactsRes = await step(() => source.contacts())
  let contacts: Contact[] = []
  if (!contactsRes.ok) r.fail(`contacts()：${contactsRes.error}`)
  else {
    const rows = checkList('contacts()', r, contactsRes.value)
    const badName = rows.filter((row) => !isStr(row['name']))
    if (badName.length) r.fail(`contacts()：${badName.length} 项缺 name`)
    else if (rows.length === 0) r.fail('contacts()：返回空数组。真实客户端的通讯录不会是空的，检查是否还没实现')
    else r.ok(`contacts()：${rows.length} 人`)
    // id/email 能用的先留下来，后面的关联检查和邮箱判定还要用
    contacts = rows.map((row) => ({ id: String(row['id']), name: isStr(row['name']) ? row['name'] : '', email: isStr(row['email']) ? row['email'] : undefined }))
  }

  const sessionsRes = await step(() => source.sessions())
  let sessions: Session[] = []
  if (!sessionsRes.ok) r.fail(`sessions()：${sessionsRes.error}`)
  else {
    const rows = checkList('sessions()', r, sessionsRes.value)
    const bad = rows.filter((row) => !isStr(row['name']) || row['type'] !== 'group' && row['type'] !== 'private')
    if (bad.length) r.fail(`sessions()：${bad.length} 项缺 name 或 type 不在 group/private 枚举里`)
    else if (Array.isArray(sessionsRes.value)) {
      sessions = rows.map((row) => ({ id: String(row['id']), name: String(row['name']), type: row['type'] as 'group' | 'private' }))
      if (sessions.length === 0) r.fail('sessions()：返回空数组。真实客户端不会一个会话都没有，检查是否还没实现')
      else r.ok(`sessions()：${sessions.length} 个会话`)
    }
  }

  const last24h = { from: now - 24 * HOUR_MS, to: now }
  const msgsRes = await step(() => source.messages(last24h))
  let msgs: ImMessage[] = []
  if (!msgsRes.ok) r.fail(`messages()：${msgsRes.error}`)
  else {
    const rows = checkList('messages()', r, msgsRes.value)
    const bad: Array<{ id: string; problems: string[] }> = []
    for (const row of rows) {
      const problems = checkMessage(row, now)
      if (problems.length) bad.push({ id: isStr(row['id']) ? row['id'] : '(无 id)', problems })
    }
    if (bad.length) {
      for (const b of bad.slice(0, SAMPLES)) r.fail(`messages()：${b.id} —— ${b.problems.join('、')}`)
      if (bad.length > SAMPLES) r.fail(`messages()：还有 ${bad.length - SAMPLES} 条形状不对`)
    } else if (Array.isArray(msgsRes.value)) {
      msgs = rows.map((row) => row as unknown as ImMessage)
      r.ok(`messages()：最近 24 小时 ${msgs.length} 条，形状全部合规`)
    }
  }

  // 日程：看最近 24 小时和未来 7 天
  const evRange = { from: last24h.from, to: now + 7 * DAY_MS }
  const eventsRes = await step(() => source.events(evRange))
  let events: CalendarEvent[] = []
  if (!eventsRes.ok) r.fail(`events()：${eventsRes.error}`)
  else {
    const rows = checkList('events()', r, eventsRes.value)
    const bad: Array<{ id: string; problems: string[] }> = []
    for (const row of rows) {
      const problems = checkEvent(row, now)
      if (problems.length) bad.push({ id: isStr(row['id']) ? row['id'] : '(无 id)', problems })
    }
    if (bad.length) {
      for (const b of bad.slice(0, SAMPLES)) r.fail(`events()：${b.id} —— ${b.problems.join('、')}`)
      if (bad.length > SAMPLES) r.fail(`events()：还有 ${bad.length - SAMPLES} 条形状不对`)
    } else if (Array.isArray(eventsRes.value)) {
      events = rows.map((row) => row as unknown as CalendarEvent)
      r.ok(`events()：最近 24 小时到未来 7 天 ${events.length} 场，形状全部合规`)
    }
  }

  const mailsRes = await step(() => source.mails(last24h))
  let mails: Mail[] = []
  if (!mailsRes.ok) r.fail(`mails()：${mailsRes.error}`)
  else {
    const rows = checkList('mails()', r, mailsRes.value)
    const bad: Array<{ id: string; problems: string[] }> = []
    for (const row of rows) {
      const problems = checkMail(row, now)
      if (problems.length) bad.push({ id: isStr(row['id']) ? row['id'] : '(无 id)', problems })
    }
    if (bad.length) {
      for (const b of bad.slice(0, SAMPLES)) r.fail(`mails()：${b.id} —— ${b.problems.join('、')}`)
      if (bad.length > SAMPLES) r.fail(`mails()：还有 ${bad.length - SAMPLES} 条形状不对`)
    } else if (Array.isArray(mailsRes.value)) {
      mails = rows.map((row) => row as unknown as Mail)
      r.ok(`mails()：最近 24 小时 ${mails.length} 封，形状全部合规`)
    }
  }

  // 3. 关联
  const meId = meRes.ok && isObj(meRes.value) && isStr(meRes.value['id']) ? meRes.value['id'] : null
  if (meId === 'TODO') r.fail('关联：me() 还是模板里的占位值 TODO')
  else if (meId && contacts.length) {
    if (contacts.some((c) => c.id === meId)) r.ok(`关联：me().id 在通讯录里`)
    else r.fail(`关联：me().id（${meId}）不在 contacts() 里`)
  }
  if (sessions.length && msgs.length) {
    const sessionIds = new Set(sessions.map((s) => s.id))
    const orphan = msgs.filter((m) => m.sessionId && !sessionIds.has(m.sessionId))
    if (orphan.length === 0) r.ok(`关联：消息的 sessionId 都能在 sessions() 里找到`)
    else r.fail(`关联：${orphan.length} 条消息的 sessionId 不在 sessions() 里（${orphan.slice(0, SAMPLES).map((m) => `${m.id}→${m.sessionId}`).join('、')}${orphan.length > SAMPLES ? ' 等' : ''}）`)
  }
  if (msgs.length) {
    const batchIds = new Set(msgs.map((m) => m.id))
    const missing = msgs.filter((m) => m.replyToId !== null && !batchIds.has(m.replyToId))
    if (missing.length === 0) {
      r.ok(`关联：replyToId 都能在同一批消息里找到`)
    } else {
      const unresolved: string[] = []
      for (const m of missing.slice(0, REPLY_LOOKUP_LIMIT)) {
        const found = source.findMessage ? await source.findMessage(m.replyToId!) : null
        if (!found) unresolved.push(m.replyToId!)
      }
      if (unresolved.length === 0) r.ok(`关联：replyToId 同批找不到的都能用 findMessage 找到（${missing.length} 条）`)
      else
        r.warn(
          `关联：replyToId 指向的消息找不到（${unresolved.slice(0, SAMPLES).join('、')}${missing.length > unresolved.length || unresolved.length > SAMPLES ? ' 等' : ''}，共查 ${Math.min(missing.length, REPLY_LOOKUP_LIMIT)} 条）`,
        )
    }
  }

  // 4. 统计：五种参与形态有为 0 的给警告
  if (msgs.length && meId) {
    const flags = DEFAULT_SETTINGS.participation
    const sessionTypes = new Map(sessions.map((s) => [s.id, s.type]))
    const myMsgIds = new Set(msgs.filter((m) => m.senderId === meId).map((m) => m.id))
    const form = (cond: (m: ImMessage) => boolean) => msgs.filter((m) => !m.isSystem && cond(m)).length
    const counts = {
      speak: form((m) => m.senderId === meId),
      mention: form((m) => m.mentions.includes(meId)),
      reply: form((m) => m.replyToId !== null && myMsgIds.has(m.replyToId)),
      private: form((m) => sessionTypes.get(m.sessionId) === 'private'),
      directed: form((m) => m.directedToMe),
    }
    const names: Record<keyof typeof counts, string> = { speak: '我开口', mention: '@我', reply: '回复我', private: '私聊', directed: '定向发给我' }
    const fields: Record<keyof typeof counts, string> = {
      speak: 'senderId / me().id',
      mention: 'mentions / mentionAll',
      reply: 'replyToId',
      private: 'sessions().type',
      directed: 'directedToMe',
    }
    r.ok(`统计：最近 24 小时消息 ${msgs.length} 条，其中系统消息 ${msgs.filter((m) => m.isSystem).length} 条`)
    const relatedEvents = events.filter((e) => e.start >= last24h.from && e.start < last24h.to && isRelatedEvent(e, meId, flags)).length
    const meEmail = contacts.length ? myEmailAddress({ id: meId, name: '' }, contacts) : null
    const relatedMails = meEmail !== null ? mails.filter((m) => m.time >= last24h.from && m.time < last24h.to && isRelatedMail(m, meEmail, flags)).length : 0
    r.ok(
      `统计：参与会话 ${participatingSessions(msgs, meId, sessionTypes, flags).size} 个；与我有关的日程 ${relatedEvents} 场、与我有关的邮件 ${relatedMails} 封`,
    )
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) {
      if (counts[key] === 0) r.warn(`统计：参与形态「${names[key]}」最近 24 小时命中 0 条 —— 请内网适配时检查字段映射（${fields[key]}）`)
    }

    // 5. 样例消息
    const samples = msgs.filter((m) => !m.isSystem).slice(0, 3)
    if (samples.length) {
      log('样例消息：')
      samples.forEach((m, i) => {
        const text = m.text.length > 30 ? `${m.text.slice(0, 30)}…` : m.text
        log(`  ${i + 1}. ${fmt(m.time, 'MM/DD HH:mm')} ${m.senderName}：${text}`)
      })
    }
  } else if (!meId) {
    r.warn('统计：me() 没通过检查，跳过参与统计')
  } else {
    r.warn('统计：最近 24 小时没有可用的消息，跳过参与统计')
  }

  log(`检查完成：${r.passes} 项通过 · ${r.fails} 项失败 · ${r.warns} 项警告`)
  return r.fails === 0
}
