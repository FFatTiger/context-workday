// 唯一调接口的地方。URL 带 ?fixtures=1（或 VITE_FIXTURES=1）时改走 web/src/fixtures/，
// 并模拟 300ms 延迟；其余情况按 src/api-types.ts 里的路径打后端。
import type {
  AffectedResponse,
  BackupRun,
  BackupSource,
  BackupSourceStatus,
  CardResponse,
  ChildrenResponse,
  CoverageResponse,
  DiffResponse,
  EventDetail,
  EvidenceResponse,
  ImContextResponse,
  ItemRef,
  Job,
  JobName,
  Level,
  MailDetail,
  Page,
  ScheduleRule,
  SearchResponse,
  Settings,
  SettingsResponse,
  StatusResponse,
  StorageResponse,
  TaskRun,
  TimelineResponse,
  VersionListResponse,
} from '../../src/api-types'
import { dayKey, periodKey } from '../../src/time'
import {
  fixtureAffected,
  fixtureBackupRuns,
  fixtureBackupStatus,
  fixtureCard,
  fixtureChildren,
  fixtureCoverage,
  fixtureDiff,
  fixtureEvent,
  fixtureEvidence,
  fixtureImContext,
  fixtureJobs,
  fixtureMail,
  fixturePatchJob,
  fixtureRegenerate,
  fixtureRunBackup,
  fixtureRunDaily,
  fixtureRunJob,
  fixtureRuns,
  fixtureSearch,
  fixtureSettings,
  fixtureSettingsSave,
  fixtureStatus,
  fixtureStorage,
  fixtureTestModel,
  fixtureTimeline,
  fixtureVersions,
  fixturesToday,
  isErrorScenario,
  resolveOpenParam,
  setScenario,
} from './fixtures'
import { dateStart } from './format'

const bootParams = new URLSearchParams(location.search)
const fixturesMode = bootParams.get('fixtures') === '1' || import.meta.env.VITE_FIXTURES === '1'
if (fixturesMode) setScenario(bootParams.get('scenario'))

export type { ItemRef }

const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 300))

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try {
      const body = (await response.json()) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // 响应不是 JSON 时保留状态码
    }
    throw new Error(message)
  }
  return (await response.json()) as T
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

function fixtureFailure(): never {
  throw new Error('IM 客户端接口超时')
}

/** 今天的日期键（上海时区）；fixtures 模式固定 2026-10-29 */
export function todayKey(): string {
  return fixturesMode ? fixturesToday() : dayKey(Date.now())
}

export async function getStatus(): Promise<StatusResponse> {
  if (fixturesMode) {
    await delay()
    return fixtureStatus()
  }
  return request<StatusResponse>('/api/status')
}

export async function getTimeline(date: string): Promise<TimelineResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureTimeline(date)
  }
  return request<TimelineResponse>(`/api/timeline?date=${encodeURIComponent(date)}`)
}

export async function getCard(
  level: Level,
  query: { date?: string; period?: string; version?: number },
): Promise<CardResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    const period =
      query.period ?? periodKey(level, dateStart(query.date ?? todayKey()))
    const asOf = dateStart(query.date ?? todayKey())
    const card = fixtureCard(level, period, asOf, query.version)
    if (!card) throw new Error('没有这个周期')
    return card
  }
  const search = new URLSearchParams({ level })
  if (query.period) search.set('period', query.period)
  if (query.date) search.set('date', query.date)
  if (query.version !== undefined) search.set('version', String(query.version))
  return request<CardResponse>(`/api/card?${search.toString()}`)
}

export async function getEvidence(ref: ItemRef, expandRaw = false): Promise<EvidenceResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureEvidence(ref, expandRaw)
  }
  const search = new URLSearchParams({
    level: ref.level,
    period: ref.period,
    version: String(ref.version),
    itemId: String(ref.itemId),
  })
  if (expandRaw) search.set('expand', 'raw')
  return request<EvidenceResponse>(`/api/evidence?${search.toString()}`)
}

export async function getImContext(id: string): Promise<ImContextResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureImContext(id)
  }
  return request<ImContextResponse>(`/api/raw/im/${encodeURIComponent(id)}/context`)
}

export async function getMailDetail(id: string): Promise<MailDetail> {
  if (fixturesMode) {
    await delay()
    return fixtureMail(id)
  }
  return request<MailDetail>(`/api/raw/mail/${encodeURIComponent(id)}`)
}

export async function getEventDetail(id: string): Promise<EventDetail> {
  if (fixturesMode) {
    await delay()
    return fixtureEvent(id)
  }
  return request<EventDetail>(`/api/raw/event/${encodeURIComponent(id)}`)
}

export async function regenerate(level: Level, period: string): Promise<{ version: number }> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    const result = fixtureRegenerate(level, period)
    if (!result) throw new Error('没有这个周期')
    return result
  }
  return request<{ version: number }>(
    `/api/series/${encodeURIComponent(level)}/${encodeURIComponent(period)}/regenerate`,
    jsonInit('POST'),
  )
}

export async function runDaily(): Promise<TaskRun> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureRunDaily()
  }
  return request<TaskRun>('/api/daily/run', jsonInit('POST'))
}

export async function getSettings(): Promise<SettingsResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureSettings()
  }
  return request<SettingsResponse>('/api/settings')
}

export async function saveSettings(patch: Partial<Settings>): Promise<SettingsResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureSettingsSave(patch)
  }
  return request<SettingsResponse>('/api/settings', jsonInit('PUT', patch))
}

export interface ModelTestResult {
  ok: boolean
  ms: number
  error?: string
}

export async function testModel(): Promise<ModelTestResult> {
  if (fixturesMode) {
    await delay()
    return fixtureTestModel()
  }
  return request<ModelTestResult>('/api/settings/test-model', jsonInit('POST'))
}

// ───── 回顾：版本、比较、下层输入 ─────

export async function getVersions(level: Level, period: string): Promise<VersionListResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureVersions(level, period)
  }
  return request<VersionListResponse>(
    `/api/series/${encodeURIComponent(level)}/${encodeURIComponent(period)}/versions`,
  )
}

export async function getDiff(level: Level, period: string, a: number, b: number): Promise<DiffResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureDiff(level, period, a, b)
  }
  const search = new URLSearchParams({ a: String(a), b: String(b) })
  return request<DiffResponse>(
    `/api/series/${encodeURIComponent(level)}/${encodeURIComponent(period)}/diff?${search.toString()}`,
  )
}

export async function getChildren(level: Level, period: string): Promise<ChildrenResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureChildren(level, period)
  }
  return request<ChildrenResponse>(
    `/api/series/${encodeURIComponent(level)}/${encodeURIComponent(period)}/children`,
  )
}

// ───── 任务 ─────

export async function getJobs(): Promise<Job[]> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureJobs()
  }
  return request<Job[]>('/api/jobs')
}

export async function patchJob(
  name: JobName,
  patch: { enabled?: boolean; rule?: ScheduleRule },
): Promise<Job> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixturePatchJob(name, patch)
  }
  return request<Job>(`/api/jobs/${encodeURIComponent(name)}`, jsonInit('PATCH', patch))
}

export async function runJob(name: JobName): Promise<{ runId: number }> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureRunJob(name)
  }
  return request<{ runId: number }>(`/api/jobs/${encodeURIComponent(name)}/run`, jsonInit('POST'))
}

export async function getRuns(query: { job?: string; result?: string; page?: number }): Promise<Page<TaskRun>> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureRuns(query)
  }
  const search = new URLSearchParams()
  if (query.job) search.set('job', query.job)
  if (query.result) search.set('result', query.result)
  if (query.page && query.page > 1) search.set('page', String(query.page))
  return request<Page<TaskRun>>(`/api/runs?${search.toString()}`)
}

// ───── 备份 ─────

export async function getBackupStatus(): Promise<BackupSourceStatus[]> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureBackupStatus()
  }
  return request<BackupSourceStatus[]>('/api/backup/status')
}

export async function getCoverage(source: BackupSource, days: number): Promise<CoverageResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureCoverage(source, days)
  }
  const search = new URLSearchParams({ source, days: String(days) })
  return request<CoverageResponse>(`/api/backup/coverage?${search.toString()}`)
}

export async function getAffected(): Promise<AffectedResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureAffected()
  }
  return request<AffectedResponse>('/api/backup/affected')
}

export async function getBackupRuns(query: {
  source?: string
  result?: string
  page?: number
}): Promise<Page<BackupRun>> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureBackupRuns(query)
  }
  const search = new URLSearchParams()
  if (query.source) search.set('source', query.source)
  if (query.result) search.set('result', query.result)
  if (query.page && query.page > 1) search.set('page', String(query.page))
  return request<Page<BackupRun>>(`/api/backup/runs?${search.toString()}`)
}

export async function runBackup(): Promise<{ started: boolean }> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureRunBackup()
  }
  return request<{ started: boolean }>('/api/backup/run', jsonInit('POST'))
}

export async function getStorage(): Promise<StorageResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureStorage()
  }
  return request<StorageResponse>('/api/backup/storage')
}

/** fixtures 模式下解析 ?open=<period>:<itemId>；截图用 */
export function resolveOpen(param: string): { ref: ItemRef } | null {
  return fixturesMode ? resolveOpenParam(param) : null
}

// ───── 搜索 ─────

export type SearchRange = 'today' | 'week' | 'month' | 'all'
export type SearchSource = 'summary' | 'im' | 'mail' | 'event'

export interface SearchQuery {
  q: string
  range: SearchRange
  sources: SearchSource[]
  mine: boolean
  page: number
}

export async function search(query: SearchQuery): Promise<SearchResponse> {
  if (fixturesMode) {
    await delay()
    if (isErrorScenario()) fixtureFailure()
    return fixtureSearch(query)
  }
  const params = new URLSearchParams({
    q: query.q,
    range: query.range,
    sources: query.sources.join(','),
    mine: query.mine ? '1' : '0',
    page: String(query.page),
  })
  return request<SearchResponse>(`/api/search?${params.toString()}`)
}
