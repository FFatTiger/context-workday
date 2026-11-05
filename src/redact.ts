// 演示脱敏（spec 第 11 节）：只在 API 出口做（app.ts 的中间件），不改数据，也不影响生成。
// 规则：
//  - 人名：保留姓，其余每个字换 "*"（"李敏"→"李*"）；人名来自通讯录和消息发送者；长名字先换；
//  - 群名：换成"群 N"，编号用 sessions.alias_no 首次需要时分配并永久保存；私聊整个名字显示"私聊 · 王*"；
//    文本里出现的群名也要换；
//  - 金额：带货币单位的数字（元、万、亿、¥、$ 等）换"***"，百分比和时间不动；
//  - 邮箱：@ 前只保留第一个字符。
import type { Db } from './db/db.js'

/** 递归遍历时跳过的键：ID、周期键、枚举值等结构字段，脱敏规则一律不碰 */
const SKIP_KEYS = new Set([
  'id', 'rawId', 'sessionId', 'version', 'itemId', 'period', 'level', 'kind', 'type', 'op',
  'trigger', 'mode', 'state', 'result', 'folder', 'job', 'model', 'endpoint', 'when', 'day',
  'ref', 'target', 'week', 'month',
])

/** 人名：保留姓，其余每个字换 "*"（单字名字没法脱，跳过） */
export function redactName(name: string): string {
  return name.length < 2 ? name : name[0] + '*'.repeat(name.length - 1)
}

/** 邮箱：@ 前只留第一个字符 */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[A-Za-z]/g
function redactEmail(s: string): string {
  return s.replace(EMAIL_RE, (m) => `${m[0]}***${m.slice(m.indexOf('@'))}`)
}

/** 带货币单位的金额 → "***"。¥/$ 打头，或数字带 元 / 万 / 亿（百分比 % 和时间不匹配） */
const MONEY_RE = /[¥￥$]\s*\d[\d,]*(?:\.\d+)?(?:\s*[万亿])?|\d[\d,]*(?:\.\d+)?\s*(?:[万亿]\s*)?元|\d[\d,]*(?:\.\d+)?\s*[万亿](?![条人次天个件年月日字页倍步分秒])/g

export function redactMoney(s: string): string {
  return s.replace(MONEY_RE, '***')
}

export class Redactor {
  private names: string[] = []
  private groupIds = new Map<string, string>() // 群名 → 会话 ID
  private alias = new Map<string, string>() // 群名 → "群 N"
  private privateDisplay = new Map<string, string>() // 私聊会话名 → "私聊 · 王*"
  private nextAliasNo: number

  constructor(private db: Db) {
    const contacts = db.prepare('SELECT name FROM contacts').all() as unknown as Array<{ name: string }>
    const senders = db.prepare('SELECT DISTINCT sender_name AS name FROM im_messages').all() as unknown as Array<{ name: string }>
    const meRow = db.prepare("SELECT value FROM meta WHERE key = 'me'").get() as { value: string } | undefined
    const set = new Set<string>([...contacts, ...senders].map((r) => r.name).filter((n) => n.length >= 2))
    if (meRow) {
      try {
        const me = JSON.parse(meRow.value) as { name?: string }
        if (me.name && me.name.length >= 2) set.add(me.name)
      } catch {
        // meta 损坏就跳过
      }
    }
    this.names = [...set].sort((a, b) => b.length - a.length)

    const sessions = db.prepare('SELECT id, name, type, alias_no FROM sessions ORDER BY rowid').all() as unknown as Array<{
      id: string
      name: string
      type: string
      alias_no: number | null
    }>
    let max = 0
    for (const s of sessions) {
      if (s.type === 'private') {
        this.privateDisplay.set(s.name, `私聊 · ${redactName(s.name)}`)
      } else if (s.type === 'group') {
        this.groupIds.set(s.name, s.id)
        if (s.alias_no !== null) {
          this.alias.set(s.name, `群 ${s.alias_no}`)
          max = Math.max(max, s.alias_no)
        }
      }
    }
    this.nextAliasNo = max + 1
  }

  /** 群名首次需要时分配编号并持久保存（spec 第 11 节：同一个会话编号固定） */
  private aliasOf(groupName: string): string {
    let a = this.alias.get(groupName)
    if (!a) {
      const no = this.nextAliasNo++
      a = `群 ${no}`
      this.alias.set(groupName, a)
      const id = this.groupIds.get(groupName)
      if (id !== undefined) this.db.prepare('UPDATE sessions SET alias_no = ? WHERE id = ?').run(no, id)
    }
    return a
  }

  redactString(s: string, key?: string): string {
    if (!s) return s
    // 私聊会话名整串就是对方的名字：只在展示会话名的字段（session）里换成"私聊 · 王*"，
    // 参会人、发件人等普通人名字段仍按人名规则脱敏
    const priv = key === 'session' ? this.privateDisplay.get(s) : undefined
    if (priv !== undefined) return priv
    let out = redactEmail(s)
    // 群名（长名字先换）：文本里出现的群名也换
    for (const name of [...this.groupIds.keys()].sort((a, b) => b.length - a.length)) {
      if (out.includes(name)) out = out.split(name).join(this.aliasOf(name))
    }
    // 人名（长名字先换）
    for (const name of this.names) {
      if (out.includes(name)) out = out.split(name).join(redactName(name))
    }
    return redactMoney(out)
  }

  /** 递归替换 JSON 响应里的字符串值；结构字段（SKIP_KEYS）不动 */
  json(value: unknown): unknown {
    return this.walk(value)
  }

  private walk(value: unknown, key?: string): unknown {
    if (key !== undefined && SKIP_KEYS.has(key)) return value
    if (typeof value === 'string') return this.redactString(value, key)
    if (Array.isArray(value)) return value.map((v) => this.walk(v))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, k)
      return out
    }
    return value
  }
}
