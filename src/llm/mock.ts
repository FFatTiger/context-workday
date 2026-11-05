// 不联网的确定性摘要器（演示和测试用）。规则拼装，同一输入输出永远相同。
// 小时：按会话分组，每组挑一条最像结论的消息；日程、邮件各自成条。
// 上层全量：按工作线（「…」）去重挑前 N 条；增量：同工作线改写，新工作线新增，超上限删最旧。
import type { DraftItem, HourlyInput, LowerItem, RollupInput, RollupOp, SourceLine, Summarizer } from './types.js'

/** 结论性词汇：含这些词的消息优先当作该组的核心消息 */
const CONCLUSION_WORDS = ['定', '确认', '通过', '结论', '上线', '同意', '安排']

const trim = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`)
/** 条目是一句话：换行和连续空白折叠成一个空格 */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** 工作线：文本里第一个「…」；没有就整段文本 */
function worklineOf(text: string): string {
  const m = text.match(/「([^」]+)」/)
  return m ? m[1] : text
}

/** 下层条目自带的外层框架（"在「X」推进：…"、"发邮件「X」说明：…"），上层改写时先剥掉，不然会套两层 */
function unframe(text: string): string {
  const m = text.match(/^(?:在「[^」]+」推进|推进「[^」]+」|发邮件「[^」]+」说明)：([\s\S]*)$/)
  return m ? m[1] : text
}

function rewrite(it: LowerItem): string {
  // 已经是完整句子（日程、收到的邮件）的，不再套一层工作线框架
  if (/^(?:参加「|收到 [^的]+的邮件「)/.test(it.text)) return trim(oneLine(it.text), 40)
  const key = worklineOf(it.text)
  return key === it.text ? `处理：${trim(it.text, 40)}` : `推进「${key}」：${trim(oneLine(unframe(it.text)), 36)}`
}

function pickCore(lines: SourceLine[], me: string): SourceLine {
  const byKeyword = lines.find((l) => CONCLUSION_WORDS.some((w) => l.text.includes(w)))
  if (byKeyword) return byKeyword
  const mine = lines.filter((l) => l.who === me)
  const pool = mine.length > 0 ? mine : lines
  return pool.reduce((best, l) => (l.text.length > best.text.length ? l : best))
}

function mockHourly(input: HourlyInput): DraftItem[] {
  const quotable = input.lines.filter((l) => !l.contextOnly)
  const groups = new Map<string, SourceLine[]>()
  for (const l of quotable) {
    if (l.type !== 'im') continue
    const list = groups.get(l.where) ?? []
    list.push(l)
    groups.set(l.where, list)
  }
  const items: DraftItem[] = []
  for (const [where, lines] of groups) {
    const core = pickCore(lines, input.me)
    const extra = lines.filter((l) => l !== core).slice(0, 2)
    items.push({ text: `在「${where}」推进：${trim(oneLine(core.text), 36)}`, refs: [core, ...extra].map((l) => l.ref) })
  }
  for (const l of quotable) {
    if (l.type === 'event') items.push({ text: `参加「${l.where}」`, refs: [l.ref] })
  }
  for (const l of quotable) {
    if (l.type === 'mail') {
      const mine = l.who === input.me || l.who.startsWith('我 → ') // 流水线给我发邮件的 who 是“我 → 收件人”
      items.push({
        text: mine ? `发邮件「${l.where}」说明：${trim(oneLine(l.text), 24)}` : `收到 ${l.who} 的邮件「${l.where}」`,
        refs: [l.ref],
      })
    }
  }
  return items.slice(0, input.maxItems)
}

function mockRollupFull(input: RollupInput): DraftItem[] {
  const seen = new Set<string>()
  const items: DraftItem[] = []
  for (const it of input.inputs) {
    const key = worklineOf(it.text)
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ text: rewrite(it), refs: [it.ref] })
  }
  return items.slice(0, input.maxItems)
}

function mockRollupIncremental(input: RollupInput): RollupOp[] {
  const used = new Map<number, LowerItem>() // 被改写的上一版条目 → 命中的输入
  const adds: RollupOp[] = []
  const seenKeys = new Set<string>()
  for (const it of input.inputs) {
    const key = worklineOf(it.text)
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const prev = input.previous.find((p) => !used.has(p.id) && worklineOf(p.text) === key)
    if (prev) {
      used.set(prev.id, it)
      adds.push({ op: 'edit', id: prev.id, text: rewrite(it), refs: [it.ref] })
    } else {
      adds.push({ op: 'add', text: rewrite(it), refs: [it.ref] })
    }
  }
  // 超上限删最旧：优先删本轮没更新的幸存条目（编号最小），都是新信息时才删编号最小的
  const survivors = input.previous.map((p) => p.id) // keep 或 edit
  const extra = adds.filter((a) => a.op === 'add').length
  const deletes = new Set<number>()
  while (survivors.length - deletes.size + extra > input.maxItems) {
    const candidates = survivors.filter((id) => !deletes.has(id) && !used.has(id))
    const pool = candidates.length > 0 ? candidates : survivors.filter((id) => !deletes.has(id))
    const oldest = pool.sort((a, b) => a - b)[0]
    if (oldest === undefined) break
    deletes.add(oldest)
  }
  const ops: RollupOp[] = []
  for (const p of input.previous) {
    if (deletes.has(p.id)) {
      ops.push({ op: 'delete', id: p.id })
      continue
    }
    const hit = used.get(p.id)
    ops.push(hit ? { op: 'edit', id: p.id, text: rewrite(hit), refs: [hit.ref] } : { op: 'keep', id: p.id })
  }
  ops.push(...adds.filter((a) => a.op === 'add'))
  return ops
}

export function createMockSummarizer(): Summarizer {
  return {
    model: 'mock',
    endpoint: null,
    hourly: async (input) => mockHourly(input),
    rollupFull: async (input) => mockRollupFull(input),
    rollupIncremental: async (input) => mockRollupIncremental(input),
    ping: async () => ({ ok: true, ms: 0 }),
  }
}
