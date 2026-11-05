// 证据链假数据。月度第 1 条按原型 drawer.png 逐节点还原；其余条目用可展开的
// 简化证据树（小时条目落到 IM / 邮件 / 日程原文），够把抽屉的每种节点都点出来。
import type {
  EventDetail,
  EvidenceNode,
  EvidenceResponse,
  ImContextResponse,
  ItemRef,
  ItemView,
  LostReason,
  MailDetail,
} from '../../../src/api-types'
import { fromLocal } from '../../../src/time'
import { LEVEL_NAME, dayTitle, md } from '../format'
import { TODAY, dayCardFor, findCardItem, findHourItem } from './core'
import { itemsForVersion } from './series'

export function refKey(ref: ItemRef): string {
  return `${ref.level}|${ref.period}|${ref.version}|${ref.itemId}`
}

interface ItemInfo {
  text: string
  counts: ItemView['counts']
}

const registry = new Map<string, ItemInfo>()

export function rememberItem(ref: ItemRef, text: string, counts: ItemView['counts'] = { evidence: 0 }) {
  registry.set(refKey(ref), { text, counts })
}

interface Conversation {
  session: string
  people: string[]
  texts: string[]
  /** 第一条消息在整点的第几分钟 */
  minute: number
}

const CONVERSATIONS: Record<string, Conversation> = {
  '2026-10-29T09': {
    session: '【核心迁移】项目群',
    people: ['赵磊', '王总', '我', '周婷'],
    texts: [
      '11月8日凌晨这个窗口，大促那边能接受吗',
      '大促期间不做切换，时间从晚上挪到凌晨',
      '确认了，11月8日 02:00 开始，回滚窗口留 40 分钟',
      '周婷把演练排期同步一下',
      '收到，我来跟进',
      '银行 11月7日封网，提前一天要对齐',
      '封网只影响机房进出，不影响线上切换',
      '凌晨切换的话，值班表我来排',
    ],
    minute: 21,
  },
  '2026-10-29T10': {
    session: '迁移评审群',
    people: ['赵磊', '孙浩', '我', '陈工'],
    texts: [
      '评审材料我先过一遍，回滚方案还差一页',
      '回滚脚本昨天演练过，40 分钟能回来',
      '签字前把回滚负责人写清楚',
      '我这边补完就发群里',
      '11月8日这个窗口大促能接受吗',
      '可以，凌晨切换影响最小',
    ],
    minute: 12,
  },
  '2026-10-29T11': {
    session: '智能客服项目组',
    people: ['周婷', '我', '刘洋', '何静'],
    texts: [
      '灰度 5% 这三天指标平稳',
      '提到 20% 之前要不要再过一遍兜底',
      '兜底话术已经上线了',
      '那就周一提到 20%，看一周指标',
      '我同步给王总',
    ],
    minute: 10,
  },
  '2026-10-29T14': {
    session: '陈工',
    people: ['陈工', '我'],
    texts: [
      '回滚方案周五前能补齐吗',
      '演练脚本还差最后一段',
      '我把负责人和时间点补上',
      '周五上午发你 review',
      '好，我先把风险表更新一版',
    ],
    minute: 22,
  },
  '2026-10-29T15': {
    session: '数据中台周会',
    people: ['李敏', '我', '王总', '孙浩'],
    texts: [
      'Q4 非核心项先砍 15%，预算要重新排',
      '指标口径统一以后再谈扩容',
      '预算表用哪一版口径，现在这版还是财务那版',
      '我下班前给李敏回复',
      '财务那版是最终口径',
      '扩容的事等口径定了一起提',
    ],
    minute: 5,
  },
  '2026-10-29T16': {
    session: '周婷',
    people: ['周婷', '我'],
    texts: ['整改通知邮件发你了，周五前反馈自查结果', '收到，我今天过一遍'],
    minute: 8,
  },
  '2026-10-29T18': {
    session: '【核心迁移】项目群',
    people: ['我', '赵磊'],
    texts: ['演练排期草稿我整理好了', '周一上午先做一次全链路演练', '值班表我今晚发出来', '收到'],
    minute: 40,
  },
  '2026-10-28T10': {
    session: '迁移评审群',
    people: ['孙浩', '陈工', '我'],
    texts: ['回滚演练脚本看完了', '40 分钟够用吗', '按 40 分钟估算，留 10 分钟缓冲', '那就按这个写进方案'],
    minute: 30,
  },
  '2026-10-28T15': {
    session: '产品周会',
    people: ['周婷', '我', '王总'],
    texts: ['周会时间改到周四上午可以吗', '我这边可以', '那就周四 10 点'],
    minute: 5,
  },
  '2026-10-27T11': {
    session: '陈工',
    people: ['陈工', '我'],
    texts: ['风险表还差回滚细节', '我下午补', '大促封网要不要单独列一行', '列一行，标成待确认'],
    minute: 26,
  },
  '2026-10-26T10': {
    session: '【核心迁移】项目群',
    people: ['王总', '赵磊', '我'],
    texts: ['大促期间肯定不能切', '那窗口只能往凌晨挪', '先把回滚方案补齐再说'],
    minute: 15,
  },
  '2026-10-09T15': {
    session: '数据中台周会',
    people: ['李敏', '我'],
    texts: ['口径就按财务那版来', '好，我同步给王总'],
    minute: 12,
  },
  '2026-10-13T16': {
    session: '数据看板 2.0 项目组',
    people: ['周婷', '李敏', '我'],
    texts: ['23 个指标都按财务口径', '周五发布', '发布说明我来写'],
    minute: 18,
  },
}

const MAILS: Record<string, MailDetail> = {
  'mail-2026-10-29-1': {
    id: 'mail-2026-10-29-1',
    subject: '数据安全整改通知',
    from: '周婷',
    to: ['我'],
    cc: ['王总'],
    time: fromLocal(2026, 10, 29, 16, 8),
    folder: '收件箱',
    text: '各位：\n\n信息安全部将于本周开展数据安全自查，请各项目组在周五 18:00 前反馈自查结果。\n重点检查：指标口径说明、对外数据导出审批记录、测试环境数据脱敏。\n\n周婷',
  },
  'mail-2026-10-21-1': {
    id: 'mail-2026-10-21-1',
    subject: '数据中台指标口径 v1.0 发布',
    from: '周婷',
    to: ['我'],
    cc: ['李敏', '王总'],
    time: fromLocal(2026, 10, 21, 10, 3),
    folder: '收件箱',
    text: '《数据中台指标口径 v1.0》已评审通过并发布，共 23 个指标，全部按财务口径对齐。\n后续新增指标请走口径评审。\n\n周婷',
  },
}

const EVENTS: Record<string, EventDetail> = {
  'event-2026-10-29T10-1': {
    id: 'event-2026-10-29T10-1',
    title: '迁移方案评审会',
    start: fromLocal(2026, 10, 29, 10, 0),
    end: fromLocal(2026, 10, 29, 11, 0),
    location: '总部大楼 32F 会议室 B',
    organizer: '赵磊',
    attendees: [
      { name: '赵磊', response: '已接受' },
      { name: '陈工', response: '已接受' },
      { name: '王总', response: '已接受' },
      { name: '孙浩', response: '已接受' },
      { name: '我', response: '已接受' },
      { name: '周婷', response: '待回复' },
    ],
    notes: '评审通过；回滚方案补齐后签字，切换窗口 11月8日 02:00。',
  },
}

const imStore = new Map<string, { session: string; messages: ImContextResponse['messages']; index: number }>()

function conversationFor(period: string): Conversation {
  return (
    CONVERSATIONS[period] ?? {
      session: '【核心迁移】项目群',
      people: ['赵磊', '我', '周婷'],
      texts: ['时间我再确认一下', '收到，按这个来'],
      minute: 10,
    }
  )
}

function conversationTime(period: string, minute: number): number {
  const [date, hourPart] = period.split('T')
  const [y, mo, d] = date.split('-').map(Number)
  return fromLocal(y, mo, d, Number(hourPart), minute)
}

function imNodes(ref: ItemRef, count: number, expandRaw: boolean): EvidenceNode[] {
  if (count <= 0) return []
  const conversation = conversationFor(ref.period)
  const base = conversationTime(ref.period, conversation.minute)
  const messages = Array.from({ length: count }, (_, i) => {
    const sender = conversation.people[i % conversation.people.length]
    return {
      id: `im-${ref.period}-${ref.itemId}-${i}`,
      sender,
      time: base + i * 3 * 60_000,
      text: conversation.texts[i % conversation.texts.length],
      isMine: sender === '我',
    }
  })
  const context: ImContextResponse['messages'] = messages.map((m) => ({ ...m, isTarget: false }))
  messages.forEach((m, i) => imStore.set(m.id, { session: conversation.session, messages: context, index: i }))
  const nodes: EvidenceNode[] = messages.map((m) => ({
    kind: 'im',
    id: m.id,
    session: conversation.session,
    sender: m.sender,
    time: m.time,
    text: m.text,
    isMine: m.isMine,
  }))
  if (!expandRaw && nodes.length > 8) return [...nodes.slice(0, 8), { kind: 'more', count: nodes.length - 8 }]
  return nodes
}

function mailNode(id: string): EvidenceNode | null {
  const mail = MAILS[id]
  if (!mail) return null
  return { kind: 'mail', id, subject: mail.subject, from: mail.from, to: mail.to.join('、'), time: mail.time }
}

function eventNode(id: string): EvidenceNode | null {
  const event = EVENTS[id]
  if (!event) return null
  return {
    kind: 'event',
    id,
    title: event.title,
    start: event.start,
    end: event.end,
    attendeeCount: event.attendees.length,
  }
}

function itemInfo(ref: ItemRef): ItemInfo & { itemIndex: number } {
  const items = itemsForVersion(ref.level, ref.period, ref.version)
  const at = items ? items.findIndex((item) => item.itemId === ref.itemId) : -1
  const remembered = registry.get(refKey(ref))
  const current =
    ref.level === 'hour'
      ? findHourItem(ref.period, ref.itemId)?.item
      : findCardItem(ref.level, ref.period, ref.itemId)
  const counts = remembered?.counts ?? current?.counts ?? { evidence: 0 }
  if (items && at >= 0) return { text: items[at].text, counts, itemIndex: at + 1 }
  if (remembered) return { text: remembered.text, counts, itemIndex: 1 }
  if (current) return { text: current.text, counts, itemIndex: 1 }
  return { text: '（演示条目）', counts: { evidence: 0 }, itemIndex: 1 }
}

interface ItemOpts {
  children?: EvidenceNode[]
  counts?: ItemView['counts']
  degraded?: { generatedAt: number; reason: LostReason; count: number }
}

function mkItem(ref: ItemRef, when: string, text: string, opts: ItemOpts = {}): EvidenceNode {
  rememberItem(ref, text, opts.counts ?? { evidence: 0 })
  const node: Extract<EvidenceNode, { kind: 'item' }> = {
    kind: 'item',
    ref,
    when,
    levelName: LEVEL_NAME[ref.level],
    text,
  }
  if (opts.children?.length) node.children = opts.children
  if (opts.degraded) node.degraded = opts.degraded
  return node
}

function rawForHour(ref: ItemRef, expandRaw: boolean): EvidenceNode[] {
  const { counts } = itemInfo(ref)
  const nodes: EvidenceNode[] = []
  if (counts.event) {
    const event = eventNode(`event-${ref.period}-1`)
    if (event) nodes.push(event)
  }
  nodes.push(...imNodes(ref, counts.im ?? 0, expandRaw))
  if (counts.mail) {
    const id = `mail-${ref.period.split('T')[0]}-${ref.itemId}`
    const mail = mailNode(id) ?? mailNode('mail-2026-10-29-1')
    if (mail) nodes.push(mail)
  }
  if (!nodes.length) {
    nodes.push(...imNodes(ref, 2, expandRaw))
  }
  return nodes
}

interface DayChildHour {
  period: string
  itemId: number
}

const DAY_CHILD_HOURS: Record<string, Record<number, DayChildHour[]>> = {
  [TODAY]: {
    1: [
      { period: '2026-10-29T09', itemId: 1 },
      { period: '2026-10-29T10', itemId: 1 },
    ],
    2: [{ period: '2026-10-29T11', itemId: 1 }],
    3: [{ period: '2026-10-29T15', itemId: 2 }],
  },
  '2026-10-28': { 1: [{ period: '2026-10-28T10', itemId: 1 }] },
  '2026-10-27': { 1: [{ period: '2026-10-27T11', itemId: 1 }] },
}

interface WeekDaySeed {
  date: string
  text: string
  hourPeriod: string
}

const WEEK_DAY_SEEDS: WeekDaySeed[] = [
  { date: '2026-10-26', text: '提出切换推迟；预算先砍 15%', hourPeriod: '2026-10-26T10' },
  { date: '2026-10-27', text: '陈工评估回滚约 40 分钟', hourPeriod: '2026-10-27T11' },
  { date: '2026-10-28', text: '预算口径讨论', hourPeriod: '2026-10-28T10' },
  { date: '2026-10-29', text: '定窗口 11/8；灰度 20%', hourPeriod: '2026-10-29T09' },
]

function dayChildren(ref: ItemRef, expandRaw: boolean): EvidenceNode[] {
  const mapped = DAY_CHILD_HOURS[ref.period]?.[ref.itemId]
  if (mapped) {
    return mapped.map((child) => {
      const found = findHourItem(child.period, child.itemId)
      if (!found) return null
      const hourRef: ItemRef = {
        level: 'hour',
        period: child.period,
        version: found.block.version?.version ?? 1,
        itemId: child.itemId,
      }
      return mkItem(hourRef, `${String(found.block.hour).padStart(2, '0')}:00`, found.item.text, {
        counts: found.item.counts,
        children: rawForHour(hourRef, expandRaw),
      })
    }).filter((n): n is EvidenceNode => n !== null)
  }
  const seed = WEEK_DAY_SEEDS.find((s) => s.date === ref.period)
  if (!seed) return []
  const found = findHourItem(seed.hourPeriod, 1)
  if (!found) return []
  const hourRef: ItemRef = {
    level: 'hour',
    period: seed.hourPeriod,
    version: found.block.version?.version ?? 1,
    itemId: 1,
  }
  return [
    mkItem(hourRef, `${String(found.block.hour).padStart(2, '0')}:00`, found.item.text, {
      counts: found.item.counts,
      children: rawForHour(hourRef, expandRaw),
    }),
  ]
}

function dayNode(seed: WeekDaySeed, expandRaw: boolean): EvidenceNode {
  const ref: ItemRef = { level: 'day', period: seed.date, version: 1, itemId: 1 }
  const text = dayCardFor(seed.date).items[0]?.text ?? seed.text
  return mkItem(ref, md(fromLocal(Number(seed.date.slice(0, 4)), Number(seed.date.slice(5, 7)), Number(seed.date.slice(8, 10)))), text, {
    counts: { evidence: 1 },
    children: dayChildren(ref, expandRaw).slice(0, 1),
  })
}

function weekChildren(expandRaw: boolean): EvidenceNode[] {
  return WEEK_DAY_SEEDS.map((seed) => dayNode(seed, expandRaw))
}

const MONTH_WEEKS = [
  { period: '2026-W42', text: '迁移方案初稿完成，切换窗口待定' },
  { period: '2026-W43', text: '回滚方案补齐，评审排期确定' },
  { period: '2026-W44', text: '评审通过，切换窗口定为 11月8日' },
]

const MONTH_DAYS = [
  { period: '2026-10-14', text: '智能客服灰度方案评审通过' },
  { period: '2026-10-19', text: '灰度 5% 上线，观察指标' },
]

function monthChildren(ref: ItemRef, expandRaw: boolean): EvidenceNode[] {
  if (ref.itemId === 1) {
    const lostRef: ItemRef = { level: 'hour', period: '2026-10-13T16', version: 1, itemId: 1 }
    rememberItem(lostRef, '与李敏、周婷确认 23 个指标统一按财务口径，周五发布', { evidence: 0 })
    return [
      mkItem(
        { level: 'day', period: '2026-10-09', version: 1, itemId: 1 },
        '10/09',
        '口径初稿评审，以财务口径为基准',
        {
          counts: { evidence: 1 },
          children: [
            mkItem(
              { level: 'hour', period: '2026-10-09T15', version: 1, itemId: 1 },
              '15:00',
              '数据中台周会',
              {
                counts: { evidence: 2, im: 2 },
                children: imNodes({ level: 'hour', period: '2026-10-09T15', version: 1, itemId: 1 }, 2, expandRaw),
              },
            ),
          ],
        },
      ),
      mkItem({ level: 'day', period: '2026-10-13', version: 1, itemId: 1 }, '10/13', '23 个指标统一按财务口径', {
        counts: { evidence: 0 },
        degraded: { generatedAt: fromLocal(2026, 10, 13, 17, 5), reason: 'backup_gap', count: 2 },
        children: [
          {
            kind: 'lost',
            rawType: 'im',
            id: 'im-lost-1013',
            reason: 'backup_gap',
            count: 2,
            text: '23 个指标统一按财务口径',
            generatedAt: fromLocal(2026, 10, 13, 17, 5),
          },
        ],
      }),
      mkItem({ level: 'day', period: '2026-10-21', version: 1, itemId: 1 }, '10/21', '口径 v1.0 正式发布', {
        counts: { evidence: 1 },
        children: [mailNode('mail-2026-10-21-1')].filter((n): n is EvidenceNode => n !== null),
      }),
    ]
  }
  if (ref.itemId === 3) {
    return MONTH_DAYS.map((day) =>
      mkItem({ level: 'day', period: day.period, version: 1, itemId: 1 }, day.period.slice(5).replace('-', '/'), day.text, {
        counts: { evidence: 1 },
      }),
    )
  }
  return MONTH_WEEKS.map((week) =>
    mkItem({ level: 'week', period: week.period, version: 1, itemId: 1 }, `第 ${Number(week.period.split('-W')[1])} 周`, week.text, {
      counts: { evidence: 2 },
    }),
  )
}

function childrenFor(ref: ItemRef, expandRaw: boolean): EvidenceNode[] {
  switch (ref.level) {
    case 'hour':
      return rawForHour(ref, expandRaw)
    case 'day':
      return dayChildren(ref, expandRaw)
    case 'week':
      return weekChildren(expandRaw)
    case 'month':
      return monthChildren(ref, expandRaw)
    case 'year':
      return []
  }
}

interface Totals {
  items: number
  im: number
  mail: number
  event: number
  degradedItems: number
  lost: number
}

function totalsOf(nodes: EvidenceNode[]): Totals {
  const totals: Totals = { items: 0, im: 0, mail: 0, event: 0, degradedItems: 0, lost: 0 }
  for (const node of nodes) {
    if (node.kind === 'item') {
      totals.items++
      if (node.degraded) totals.degradedItems++
      if (node.children) {
        const child = totalsOf(node.children)
        totals.im += child.im
        totals.mail += child.mail
        totals.event += child.event
        totals.degradedItems += child.degradedItems
        totals.lost += child.lost
      }
    } else if (node.kind === 'im') totals.im++
    else if (node.kind === 'mail') totals.mail++
    else if (node.kind === 'event') totals.event++
    else if (node.kind === 'lost') totals.lost++
  }
  return totals
}

function pathFor(ref: ItemRef): EvidenceResponse['path'] {
  const dayLabel = ref.period.startsWith(TODAY) ? '今天' : dayTitle(ref.period.slice(0, 10))
  switch (ref.level) {
    case 'hour':
      return [{ label: '小时摘要' }]
    case 'day':
      return [{ label: dayLabel }, { label: '小时摘要' }]
    case 'week':
      return [{ label: '本周' }, { label: '日结' }, { label: '小时摘要' }]
    case 'month':
      return [{ label: '本月' }, { label: '日结' }, { label: '小时摘要' }]
    case 'year':
      return [{ label: '本年' }, { label: '月摘要' }, { label: '日结' }]
  }
}

export function evidenceFor(ref: ItemRef, expandRaw: boolean): EvidenceResponse {
  const info = itemInfo(ref)
  const nodes = childrenFor(ref, expandRaw)
  const totals = totalsOf(nodes)
  return {
    item: {
      ...ref,
      text: info.text,
      levelName: LEVEL_NAME[ref.level],
      createdAt: fromLocal(2026, 10, 29, 20, 30),
      itemIndex: info.itemIndex,
    },
    path: pathFor(ref),
    totals: {
      items: totals.items,
      im: totals.im,
      mail: totals.mail,
      event: totals.event,
      degraded: totals.lost || totals.degradedItems,
    },
    nodes,
  }
}

export function imContext(id: string): ImContextResponse | null {
  const found = imStore.get(id)
  if (!found) return null
  const from = Math.max(0, found.index - 3)
  const to = Math.min(found.messages.length, found.index + 4)
  return {
    session: found.session,
    messages: found.messages.slice(from, to).map((m, i) => ({ ...m, isTarget: from + i === found.index })),
  }
}

export interface ImMessageSeed {
  id: string
  session: string
  sender: string
  time: number
  text: string
  isMine: boolean
}

/** 搜索假数据用的原文：把每个会话摊平成消息列表（同时登记上下文，弹窗里能看到前后消息） */
export function allImMessages(): ImMessageSeed[] {
  const out: ImMessageSeed[] = []
  for (const period of Object.keys(CONVERSATIONS)) {
    const conversation = conversationFor(period)
    const base = conversationTime(period, conversation.minute)
    const messages: ImMessageSeed[] = conversation.texts.map((text, index) => {
      const sender = conversation.people[index % conversation.people.length]
      return {
        id: `search-im-${period}-${index}`,
        session: conversation.session,
        sender,
        time: base + index * 3 * 60_000,
        text,
        isMine: sender === '我',
      }
    })
    const context: ImContextResponse['messages'] = messages.map((message) => ({ ...message, isTarget: false }))
    messages.forEach((message, index) =>
      imStore.set(message.id, { session: message.session, messages: context, index }),
    )
    out.push(...messages)
  }
  return out
}

export function allMails(): MailDetail[] {
  return Object.values(MAILS)
}

export function allEvents(): EventDetail[] {
  return Object.values(EVENTS)
}

export function mailDetail(id: string): MailDetail | null {
  return MAILS[id] ?? null
}

export function eventDetail(id: string): EventDetail | null {
  return EVENTS[id] ?? null
}
