// 提示词（中文）。要求模型只输出 JSON；不依赖 response_format，由 openai.ts 自己从回复里剥出 JSON。
// feedback 是上一次输出的问题提示（格式错误重试 / 条目超上限重试时带上）。
import type { HourlyInput, RollupInput, SourceLine } from './types.js'
import { fmt } from '../time.js'

export interface PromptMessage {
  role: 'system' | 'user'
  content: string
}

const SYSTEM = `你是"Context · 工作日镜"的摘要器，帮我整理"我做了什么"。
规则：只输出 JSON，不要输出任何其他文字。条目用简体中文，站在"我"的视角写我做了什么、推进了什么，不要写成旁观记录。`

const TYPE_NAME: Record<SourceLine['type'], string> = { im: 'IM', mail: '邮件', event: '日程' }

function fmtLine(l: SourceLine): string {
  const when = fmt(l.time, 'HH:mm')
  const head = l.contextOnly
    ? `${l.ref} [前情，仅供理解，不可引用]`
    : `${l.ref} [${TYPE_NAME[l.type]} ${when} 「${l.where}」]`
  return `${head} ${l.who}：${l.text}`
}

function feedbackBlock(feedback?: string): string {
  return feedback ? `\n【上次输出的问题】${feedback}\n请修正这个问题后重新输出。\n` : ''
}

export function hourlyMessages(input: HourlyInput, feedback?: string): PromptMessage[] {
  const user = `【时间段】${input.label}
【我是】${input.me}
【原文】每行开头的编号（m1、e1、c1……）用于引用：
${input.lines.map(fmtLine).join('\n')}

【任务】根据上面的原文，总结这一个小时里我做了什么、推进了什么。
- 最多 ${input.maxItems} 条，按重要性从高到低；
- 每条一句话，建议 40 字以内、最多 80 字；
- 每条给出 refs：引用的原文编号，1 到 3 个；
- 标了"仅供理解"的消息只能帮你理解上下文，不能出现在 refs 里；
- 群里别人拍板、定结论的消息也是我的工作证据，可以引用。
【输出】只输出 JSON 数组：[{"text":"…","refs":["m1","m2"]}]${feedbackBlock(feedback)}`
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ]
}

function lowerLines(input: RollupInput): string {
  return input.inputs.map((it) => `${it.ref} [${it.from}] ${it.text}`).join('\n')
}

export function rollupMessages(input: RollupInput, feedback?: string): PromptMessage[] {
  if (input.previous.length === 0) {
    const user = `【周期】${input.label}
【下层条目】
${lowerLines(input)}

【任务】把这些下层条目汇聚成本周期的摘要。
- 最多 ${input.maxItems} 条，同一件事只留一条，保留最新进展；
- 每条一句话，建议 40 字以内、最多 80 字；
- 每条给出 refs：引用的下层条目编号。
【输出】只输出 JSON 数组：[{"text":"…","refs":["d3"]}]${feedbackBlock(feedback)}`
    return [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ]
  }
  const user = `【周期】${input.label}
【上一版条目】id 是固定编号：
${input.previous.map((p) => `#${p.id} ${p.text}`).join('\n')}
【本次新增的下层条目】
${lowerLines(input)}

【任务】用新的下层条目更新上一版，对上一版逐条给出操作：
- keep：仍然成立，原样保留；
- edit：有新进展，改写文本（保留原意并并入新信息），引用本次输入；
- delete：已不成立或不再重要；
- add：新出现的工作，必须引用本次输入里的条目；
- 操作完成后保留下来的条目（keep + edit + add）不超过 ${input.maxItems} 条，同一件事只留一条。
【输出】只输出 JSON 数组，按 id 从小到大排列：[{"op":"keep","id":1},{"op":"edit","id":3,"text":"…","refs":["d2"]},{"op":"delete","id":5},{"op":"add","text":"…","refs":["d4"]}]${feedbackBlock(feedback)}`
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ]
}
