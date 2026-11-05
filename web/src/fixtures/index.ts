// 假数据入口：按 ?scenario=empty|error|generating 切换展示状态。
// api.ts 在 fixtures 模式下只调这里，接口形状与 src/api-types.ts 一致。
import type {
  CardResponse,
  ChildrenResponse,
  EventDetail,
  EvidenceResponse,
  HourBlock,
  ImContextResponse,
  ItemRef,
  Level,
  MailDetail,
  SearchResponse,
  SettingsResponse,
  StatusResponse,
  TaskRun,
  TimelineResponse,
  VersionListResponse,
} from '../../../src/api-types'
import { dayKey } from '../../../src/time'
import {
  DAY_ITEMS,
  NOW,
  TODAY,
  cardFor,
  dayCardFor,
  findHourBlock,
  findHourItem,
  overrideCard,
  overrideHour,
  statusFor,
  timelineFor,
  version,
} from './core'
import { evidenceFor, eventDetail, imContext, mailDetail } from './evidence'
import {
  fixtureChildren as childrenOf,
  fixtureDiff as diffOf,
  fixtureVersions as versionsOf,
  itemsForVersion,
  recordRegeneratedVersion,
  versionMetaFor,
} from './series'
import { currentScenario, isErrorScenario, setScenario, type Scenario } from './scenario'
import { PAGE_SIZE, searchFixtures, type SearchQuery } from './search'
import { fixtureSettings, fixtureSettingsSave, fixtureTestModel, isRedactOn } from './settings'

export { isErrorScenario, setScenario }
export type { Scenario }
export {
  fixtureAffected,
  fixtureBackupRuns,
  fixtureBackupStatus,
  fixtureCoverage,
  fixtureRunBackup,
  fixtureStorage,
} from './backup'
export { fixtureJobs, fixturePatchJob, fixtureRunJob, fixtureRuns } from './jobs'
export { fixtureSettings, fixtureSettingsSave, fixtureTestModel } from './settings'

export function fixtureDiff(level: Level, period: string, a: number, b: number) {
  return diffOf(level, period, a, b)
}

export function fixtureVersions(level: Level, period: string): VersionListResponse {
  const list = versionsOf(level, period)
  const scenario = currentScenario()
  if (scenario === 'empty') return { ...list, versions: [] }
  if (scenario === 'generating' && level === 'month') return { ...list, upstreamChanged: true }
  return list
}

export function fixtureChildren(level: Level, period: string): ChildrenResponse {
  const out = childrenOf(level, period)
  if (currentScenario() !== 'empty') return out
  return {
    children: out.children.map((child) =>
      child.state === 'future' ? child : { ...child, state: 'empty' as const, preview: [], mergedIn: undefined },
    ),
  }
}

export function fixtureStatus(): StatusResponse {
  return statusFor({ failed: scenarioFailed(), redact: isRedactOn() })
}

function scenarioFailed(): boolean {
  return currentScenario() === 'error'
}

export function fixtureTimeline(date: string): TimelineResponse {
  if (currentScenario() === 'empty') {
    return { ...timelineFor(date), hours: [], gaps: [], activity: new Array<number>(24).fill(0) }
  }
  if (currentScenario() === 'generating' && date === TODAY) {
    const generating: HourBlock = {
      period: '2026-10-29T19',
      hour: 19,
      state: 'generating',
      items: [],
      related: 0,
    }
    return timelineFor(date, [generating])
  }
  return timelineFor(date)
}

export function fixtureCard(
  level: Level,
  period: string,
  asOf: number,
  versionNo?: number,
): CardResponse | null {
  const card = cardFor(level, period, asOf)
  if (!card) return null
  if (versionNo !== undefined) {
    const items = itemsForVersion(level, period, versionNo)
    const meta = versionMetaFor(level, period, versionNo)
    if (!items || !meta) return null
    return {
      ...card,
      state: 'ok',
      error: undefined,
      scheduledAt: undefined,
      upstreamChanged: false,
      version: meta,
      items: items.map((entry) => {
        const current = card.items.find((item) => item.itemId === entry.itemId)
        return {
          itemId: entry.itemId,
          text: entry.text,
          op: 'keep' as const,
          counts: current?.counts ?? { evidence: 1 },
          degraded: current?.degraded ?? 0,
        }
      }),
    }
  }
  if (currentScenario() === 'empty') {
    return { ...card, state: 'empty', items: [], inputCount: 0, dayStats: undefined, version: undefined }
  }
  if (currentScenario() === 'generating') {
    if (level === 'month') return { ...card, upstreamChanged: true }
    return { ...card, state: 'generating', items: [], version: undefined, error: undefined }
  }
  return card
}

export function fixtureEvidence(ref: ItemRef, expandRaw: boolean): EvidenceResponse {
  return evidenceFor(ref, expandRaw)
}

export function fixtureSearch(query: SearchQuery): SearchResponse {
  if (currentScenario() === 'empty') {
    return { items: [], total: 0, page: 1, pageSize: PAGE_SIZE, hint: '今天的原文会在下次 IM 备份后可搜' }
  }
  return searchFixtures(query)
}

export function fixtureImContext(id: string): ImContextResponse {
  const context = imContext(id)
  if (context) return context
  return {
    session: '【核心迁移】项目群',
    messages: [
      { id, sender: '赵磊', time: fromNow(-9 * 60_000), text: '上午的评审材料我发群里了', isMine: false, isTarget: false },
      { id: `${id}-target`, sender: '我', time: fromNow(-4 * 60_000), text: '收到，我看完回复', isMine: true, isTarget: true },
      { id: `${id}-after`, sender: '周婷', time: fromNow(60_000), text: '排期记得同步一下', isMine: false, isTarget: false },
    ],
  }
}

function fromNow(delta: number): number {
  return NOW + delta
}

export function fixtureMail(id: string): MailDetail {
  return (
    mailDetail(id) ?? {
      id,
      subject: '数据安全整改通知',
      from: '周婷',
      to: ['我'],
      cc: ['王总'],
      time: NOW - 4 * 3600_000,
      folder: '收件箱',
      text: '（演示邮件正文）',
    }
  )
}

export function fixtureEvent(id: string): EventDetail {
  return (
    eventDetail(id) ?? {
      id,
      title: '迁移方案评审会',
      start: NOW - 10 * 3600_000,
      end: NOW - 9 * 3600_000,
      location: '总部大楼 32F 会议室 B',
      organizer: '赵磊',
      attendees: [{ name: '我', response: '已接受' }],
      notes: '（演示日程）',
    }
  )
}

export function fixtureRegenerate(level: Level, period: string): { version: number } | null {
  if (level === 'hour') {
    const block = findHourBlock(period)
    if (!block) return null
    const next: HourBlock = {
      ...block,
      state: 'ok',
      error: undefined,
      version: version((block.version?.version ?? 1) + 1, NOW, { trigger: 'manual' }),
    }
    overrideHour(next)
    recordRegeneratedVersion(
      'hour',
      period,
      next.version!.version,
      NOW,
      next.items.map((item) => ({ itemId: item.itemId, text: item.text })),
    )
    return { version: next.version!.version }
  }
  const card = cardFor(level, period)
  if (!card) return null
  const items = card.items.length ? card.items : level === 'day' ? dayCardFor(TODAY).items : card.items
  const next: CardResponse = {
    ...card,
    state: 'ok',
    error: undefined,
    scheduledAt: undefined,
    upstreamChanged: false,
    version: version((card.version?.version ?? 0) + 1, NOW, { trigger: 'manual' }),
    items,
  }
  overrideCard(next)
  recordRegeneratedVersion(
    level,
    card.period,
    next.version!.version,
    NOW,
    items.map((item) => ({ itemId: item.itemId, text: item.text })),
  )
  return { version: next.version!.version }
}

export function fixtureRunDaily(): TaskRun {
  const card = cardFor('day', TODAY)
  const next = {
    ...(card ?? dayCardFor(TODAY)),
    state: 'ok' as const,
    error: undefined,
    scheduledAt: undefined,
    version: version((card?.version?.version ?? 0) + 1, NOW, { trigger: 'manual' }),
    items: DAY_ITEMS,
  }
  overrideCard(next)
  return {
    id: 1,
    job: 'daily',
    target: TODAY,
    scheduledAt: null,
    startedAt: NOW,
    endedAt: NOW + 24_000,
    result: 'success',
    trigger: 'manual',
    note: `生成日结 v${next.version.version}`,
    outputs: [{ level: 'day', period: TODAY, version: next.version.version }],
  }
}

export function fixturesToday(): string {
  return dayKey(NOW)
}

function levelOfPeriod(period: string): Level {
  if (/^\d{4}$/.test(period)) return 'year'
  if (period.includes('W')) return 'week'
  if (period.includes('T')) return 'hour'
  if (period.length === 7) return 'month'
  return 'day'
}

/** 假数据模式下解析 &open=<period>:<itemId>，给截图用 */
export function resolveOpenParam(param: string): { ref: ItemRef } | null {
  const at = param.lastIndexOf(':')
  if (at < 0) return null
  const period = param.slice(0, at)
  const itemId = Number(param.slice(at + 1))
  if (!Number.isFinite(itemId)) return null
  const level = levelOfPeriod(period)
  if (level === 'hour') {
    const found = findHourItem(period, itemId)
    if (!found) return null
    return { ref: { level, period, version: found.block.version?.version ?? 1, itemId } }
  }
  const card = cardFor(level, period)
  if (!card) return null
  const index = card.items.findIndex((it) => it.itemId === itemId)
  if (index < 0) return null
  return { ref: { level, period, version: card.version?.version ?? 1, itemId } }
}
