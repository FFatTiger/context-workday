// 回顾页（ui.md 5.3）：层级分段控件、周期导航、当前版本摘要卡、下层输入、版本轨与差异框。
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { CardResponse, ChildPeriod, DiffResponse, ItemView, Level, TimelineResponse } from '../../../src/api-types'
import { periodKey, periodRange } from '../../../src/time'
import { getCard, getChildren, getDiff, getTimeline, getVersions, regenerate, todayKey } from '../api'
import { ChildCards } from '../components/ChildCards'
import { useDrawer } from '../components/Drawer'
import { ItemRow } from '../components/ItemRow'
import { ConfirmDialog } from '../components/Modal'
import {
  Button,
  EmptyState,
  ErrorState,
  FailedState,
  Skeleton,
  StatusPill,
  type PillTone,
} from '../components/primitives'
import { Timeline } from '../components/Timeline'
import { useToast } from '../components/Toast'
import { CompareDialog, DiffBox, VersionTrack } from '../components/VersionPanel'
import {
  dateStart,
  dayFooter,
  dayTitle,
  hhmm,
  md,
  mdhm,
  periodName,
  periodRangeLabel,
  periodTitle,
  shiftPeriod,
  upperFooter,
  weekdayOf,
} from '../format'
import { errorText, useApi } from '../hooks/useApi'
import { navigate, type Route } from '../router'

const LEVELS: Level[] = ['hour', 'day', 'week', 'month', 'year']
const LEVEL_LABEL: Record<Level, string> = { hour: '小时', day: '日', week: '周', month: '月', year: '年' }
const PERIOD_PATTERN: Record<Exclude<Level, 'hour'>, RegExp> = {
  day: /^\d{4}-\d{2}-\d{2}$/,
  week: /^\d{4}-W\d{2}$/,
  month: /^\d{4}-\d{2}$/,
  year: /^\d{4}$/,
}
const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/

interface ParsedRoute {
  level: Level
  period: string
  /** 时间线用的日期：只有小时、日层级有 */
  date: string
  hour: string | null
}

function parseRoute(route: Route): ParsedRoute {
  const rawLevel = route.segments[1]
  const level = LEVELS.includes(rawLevel as Level) ? (rawLevel as Level) : 'week'
  const raw = decodeURIComponent(route.segments[2] ?? '')
  const today = todayKey()

  if (level === 'hour') {
    if (HOUR_PATTERN.test(raw)) return { level, period: raw, date: raw.slice(0, 10), hour: raw }
    const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : today
    return { level, period: date, date, hour: null }
  }
  const period = PERIOD_PATTERN[level].test(raw) ? raw : periodKey(level, dateStart(today))
  return { level, period, date: level === 'day' ? period : '', hour: null }
}

const CHILD_TITLE: Record<'week' | 'month' | 'year', { title: string; note: string }> = {
  week: { title: '本周日结', note: '周摘要的输入' },
  month: { title: '本月日结', note: '月摘要的输入' },
  year: { title: '本年月摘要', note: '年摘要的输入' },
}

type Confirming = { kind: 'series' } | { kind: 'hour'; period: string }

export function Review({ route }: { route: Route }) {
  const parsed = parseRoute(route)
  const today = todayKey()
  const drawer = useDrawer()
  const toast = useToast()
  const initialVersion = Number(route.query.get('version'))
  const [activeHour, setActiveHour] = useState<string | null>(parsed.hour)
  const [selected, setSelected] = useState<number | null>(
    Number.isFinite(initialVersion) && initialVersion > 0 ? initialVersion : null,
  )
  const [pendingSelect, setPendingSelect] = useState<number | null>(null)
  const [compare, setCompare] = useState<{ a: number; b: number } | null>(null)
  const [compareOpen, setCompareOpen] = useState(false)
  const [hl, setHl] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [busy, setBusy] = useState(false)

  const isHour = parsed.level === 'hour'
  const seriesPeriod = isHour ? activeHour : parsed.period
  const showTimeline = isHour || parsed.level === 'day'

  useEffect(() => {
    setActiveHour(parsed.hour)
    setSelected(Number.isFinite(initialVersion) && initialVersion > 0 ? initialVersion : null)
    setPendingSelect(null)
    setCompare(null)
  }, [parsed.level, parsed.date, parsed.hour, parsed.period, initialVersion])

  const timeline = useApi<TimelineResponse | null>(
    () => (showTimeline && parsed.date ? getTimeline(parsed.date) : Promise.resolve(null)),
    [parsed.date, showTimeline],
  )
  const versions = useApi(
    () =>
      seriesPeriod
        ? getVersions(parsed.level, seriesPeriod)
        : Promise.resolve({ level: parsed.level, period: '', upstreamChanged: false, versions: [] }),
    [parsed.level, seriesPeriod],
  )
  const latestVersion = versions.data?.versions[0]?.version ?? null
  // 选中旧版本时摘要卡换成那个版本的条目（ui.md 5.3）
  const versionParam = selected !== null && selected !== latestVersion ? selected : undefined
  const card = useApi<CardResponse | null>(
    () =>
      isHour
        ? Promise.resolve(null)
        : getCard(parsed.level, { period: parsed.period, version: versionParam }),
    [parsed.level, parsed.period, isHour, versionParam],
  )
  const children = useApi(
    () =>
      parsed.level === 'week' || parsed.level === 'month' || parsed.level === 'year'
        ? getChildren(parsed.level, parsed.period)
        : Promise.resolve({ children: [] as ChildPeriod[] }),
    [parsed.level, parsed.period],
  )

  useEffect(() => {
    if (!isHour || activeHour) return
    const last = timeline.data?.hours[timeline.data.hours.length - 1]
    if (last) setActiveHour(last.period)
  }, [isHour, activeHour, timeline.data])

  useEffect(() => {
    if (!versions.data) return
    const list = versions.data.versions
    if (!list.length) {
      setSelected(null)
      return
    }
    if (pendingSelect !== null && list.some((item) => item.version === pendingSelect)) {
      setSelected(pendingSelect)
      setPendingSelect(null)
      return
    }
    setSelected((prev) => (prev && list.some((item) => item.version === prev) ? prev : list[0].version))
  }, [versions.data, pendingSelect])

  const itemParam = route.query.get('item')
  useEffect(() => {
    if (!itemParam) return
    const id = Number(itemParam)
    setHl(Number.isFinite(id) ? id : null)
    const timer = window.setTimeout(() => setHl(null), 2000)
    return () => window.clearTimeout(timer)
  }, [itemParam, parsed.level, parsed.period])

  useEffect(() => {
    if (hl === null) return
    document.querySelector('.rv-items .hl, .entry .it.hl')?.scrollIntoView({ block: 'center' })
  }, [hl, card.data, timeline.data])

  const diffTarget = compare ?? (selected !== null && selected > 1 ? { a: selected, b: selected - 1 } : null)
  const diff = useApi<DiffResponse | null>(
    () =>
      diffTarget && seriesPeriod
        ? getDiff(parsed.level, seriesPeriod, diffTarget.a, diffTarget.b)
        : Promise.resolve(null),
    [parsed.level, seriesPeriod, diffTarget?.a, diffTarget?.b],
  )

  const beforeById = useMemo(() => {
    const map = new Map<number, string>()
    const data = diff.data
    if (!data || data.mode !== 'items') return map
    for (const row of data.rows) if (row.kind === 'edit') map.set(row.itemId, row.before)
    return map
  }, [diff.data])

  const latest = versions.data?.versions[0]
  const cardVersion = card.data?.version ?? null
  const viewingOld = versionParam !== undefined && cardVersion?.version === versionParam

  /** 选中版本对应差异框时，条目上显示的本版操作 */
  const opById = useMemo(() => {
    const map = new Map<number, ItemView['op']>()
    const data = diff.data
    if (!data || data.mode !== 'items' || !cardVersion || diffTarget?.a !== cardVersion.version) return map
    for (const row of data.rows) {
      map.set(row.itemId, row.kind === 'add' ? 'add' : row.kind === 'edit' ? 'edit' : 'keep')
    }
    return map
  }, [diff.data, cardVersion, diffTarget?.a])

  const changeNote =
    (versions.data?.versions.length ?? 0) > 1
      ? latest
        ? [
            latest.changes.added ? `新增 ${latest.changes.added}` : '',
            latest.changes.edited ? `修改 ${latest.changes.edited}` : '',
            latest.changes.deleted ? `删除 ${latest.changes.deleted}` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : ''
      : ''

  const todayStart = dateStart(today)
  const nextPeriod = isHour ? shiftPeriod('hour', parsed.date, 1) : shiftPeriod(parsed.level, parsed.period, 1)
  const canGoNext = isHour ? nextPeriod <= today : periodRange(parsed.level, nextPeriod).from <= todayStart

  function go(delta: number) {
    if (isHour) {
      navigate(`/review/hour/${shiftPeriod('hour', parsed.date, delta)}`)
      return
    }
    navigate(`/review/${parsed.level}/${shiftPeriod(parsed.level, parsed.period, delta)}`)
  }

  function switchLevel(level: Level) {
    if (level === 'hour') {
      const date = isHour ? parsed.date : parsed.period.slice(0, 10)
      navigate(`/review/hour/${date}`)
      return
    }
    navigate(`/review/${level}`)
  }

  function reloadAll() {
    card.reload()
    versions.reload()
    children.reload()
    diff.reload()
    timeline.reload()
  }

  async function regenerateNow(target: Confirming) {
    setBusy(true)
    try {
      const level: Level = target.kind === 'hour' ? 'hour' : parsed.level
      const period = target.kind === 'hour' ? target.period : seriesPeriod
      if (!period) return
      const result = await regenerate(level, period)
      toast(`已生成 v${result.version}`)
      if (target.kind === 'series') setPendingSelect(result.version)
      setCompare(null)
      reloadAll()
    } catch (error) {
      toast(`重新生成失败：${errorText(error)}`)
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  const headline = isHour
    ? activeHour
      ? periodName('hour', activeHour)
      : '小时摘要'
    : periodName(parsed.level, parsed.period)
  const rangeLabel = isHour
    ? `${dayTitle(parsed.date)} ${weekdayOf(parsed.date)}`
    : periodRangeLabel(parsed.level, parsed.period)

  let pillText = '还没有版本'
  let pillTone: PillTone = 'muted'
  if (versions.data?.upstreamChanged) {
    pillText = '上游已变更'
    pillTone = 'warn'
  } else if (latest?.isFinal) {
    pillText = '最终版'
    pillTone = 'ok'
  } else if (latest) {
    pillText = `进行中 · 截至 ${md(todayStart)}`
    pillTone = 'accent'
  }

  const hourHl = activeHour && hl !== null ? `${activeHour}:${hl}` : null

  return (
    <>
      <div className="dayhead">
        <h1>
          {headline}
          <span>{rangeLabel}</span>
        </h1>
        <button type="button" className="navbtn" aria-label="上一个周期" onClick={() => go(-1)}>
          ‹
        </button>
        <button type="button" className="navbtn" aria-label="下一个周期" disabled={!canGoNext} onClick={() => go(1)}>
          ›
        </button>
        <div className="seg review-seg">
          {LEVELS.map((level) => (
            <button
              type="button"
              key={level}
              className={level === parsed.level ? 'on' : ''}
              onClick={() => switchLevel(level)}
            >
              {LEVEL_LABEL[level]}
            </button>
          ))}
        </div>
        <div className="meta">
          <StatusPill tone={pillTone} dot={pillTone !== 'muted'}>
            {pillText}
          </StatusPill>
        </div>
      </div>

      <div className="rv-grid">
        <div className="rv-left">
          {!isHour ? (
            <ReviewCard
              level={parsed.level}
              title={periodTitle(parsed.level, parsed.period, today)}
              card={card.data}
              loading={card.loading}
              error={card.error}
              versionLabel={cardVersion ? `v${cardVersion.version}` : undefined}
              viewingOld={viewingOld}
              hasRecords={parsed.level === 'day' && (timeline.data?.hours.length ?? 0) > 0}
              opById={opById}
              changeNote={changeNote}
              prevVersion={latest ? latest.version - 1 : 0}
              hl={hl}
              beforeById={beforeById}
              onReload={card.reload}
              onOpenItem={(item) => {
                if (!cardVersion) return
                drawer.open({
                  ref: { level: parsed.level, period: parsed.period, version: cardVersion.version, itemId: item.itemId },
                })
              }}
              onBackToLatest={() => setSelected(latest?.version ?? null)}
              onRetry={() => setConfirming({ kind: 'series' })}
            />
          ) : null}

          {showTimeline ? (
            <Timeline
              isToday={parsed.date === today}
              timeline={timeline.data}
              loading={timeline.loading}
              error={timeline.error}
              hl={hourHl}
              onReload={timeline.reload}
              onOpenItem={(ref) => drawer.open({ ref })}
              onSelectHour={(period) => navigate(`/review/hour/${period}`)}
              selectedHour={activeHour}
              onRegenerate={(period) => setConfirming({ kind: 'hour', period })}
              title={isHour ? '这一天的时间线' : '当天小时摘要'}
              scroll={false}
            />
          ) : null}

          {parsed.level === 'week' || parsed.level === 'month' || parsed.level === 'year' ? (
            <div className="card">
              <div className="card-h">
                <h2>{CHILD_TITLE[parsed.level].title}</h2>
                <span className="sub">{CHILD_TITLE[parsed.level].note}</span>
              </div>
              {children.loading ? (
                <div className="days-skel">
                  <Skeleton rows={3} />
                </div>
              ) : children.error ? (
                <ErrorState message={children.error} onRetry={children.reload} />
              ) : (
                <ChildCards
                  level={parsed.level}
                  children={children.data?.children ?? []}
                  selectedVersion={selected}
                  onOpen={(child) => {
                    if (child.state === 'future') return
                    if (parsed.level === 'year') navigate(`/review/month/${child.period}`)
                    else navigate(`/today/${child.period}`)
                  }}
                />
              )}
            </div>
          ) : null}
        </div>

        <aside className="card verscard">
          <div className="card-h">
            <h2>版本</h2>
            <Button
              variant="accent"
              className="r"
              disabled={busy || !seriesPeriod}
              onClick={() => setConfirming({ kind: 'series' })}
            >
              {busy ? '生成中…' : `重新生成 v${(latest?.version ?? 0) + 1}`}
            </Button>
          </div>
          <VersionTrack
            versions={versions.data?.versions ?? []}
            selected={selected}
            loading={versions.loading}
            error={versions.error}
            onReload={versions.reload}
            onSelect={(version) => {
              setSelected(version)
              setCompare(null)
            }}
          />
          {diffTarget ? (
            <DiffBox
              a={diffTarget.a}
              b={diffTarget.b}
              diff={diff.data}
              loading={diff.loading}
              error={diff.error}
              onRetry={diff.reload}
            />
          ) : (
            <div className="diffwrap">
              <div className="diffh">差异</div>
              <div className="diff">
                <p className="muted">{latest ? '这是这个系列的初版，没有可对比的上一版。' : '还没有版本。'}</p>
              </div>
            </div>
          )}
          <div className="vers-foot">
            <Button disabled={(versions.data?.versions.length ?? 0) < 2} onClick={() => setCompareOpen(true)}>
              对比两个版本
            </Button>
          </div>
        </aside>
      </div>

      {compareOpen ? (
        <CompareDialog
          open
          versions={versions.data?.versions ?? []}
          initialA={selected}
          initialB={selected !== null ? Math.max(1, selected - 1) : null}
          onCancel={() => setCompareOpen(false)}
          onConfirm={(a, b) => {
            setCompare({ a, b })
            setSelected(a)
            setCompareOpen(false)
          }}
        />
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={
          confirming?.kind === 'hour'
            ? `重新生成 ${confirming.period.slice(11)}:00 小时摘要`
            : `重新生成 v${(latest?.version ?? 0) + 1}`
        }
        body={
          confirming?.kind === 'hour'
            ? '将用这个小时的原文完整重新生成。'
            : `将用最新的下层摘要完整重新生成，产生 v${(latest?.version ?? 0) + 1}。`
        }
        confirmText="重新生成"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) void regenerateNow(confirming)
        }}
      />
    </>
  )
}

function ReviewCard({
  level,
  title,
  card,
  loading,
  error,
  versionLabel,
  viewingOld,
  hasRecords,
  opById,
  changeNote,
  prevVersion,
  hl,
  beforeById,
  onReload,
  onOpenItem,
  onBackToLatest,
  onRetry,
}: {
  level: Level
  title: string
  card: CardResponse | null
  loading: boolean
  error: string | null
  versionLabel?: string
  /** 选中的是旧版本：卡片顶部提示并可回到最新 */
  viewingOld: boolean
  /** 这一天已经有小时摘要：empty 状态不说"没有记录" */
  hasRecords: boolean
  /** 本版操作，来自选中版本的差异 */
  opById: Map<number, ItemView['op']>
  changeNote: string
  prevVersion: number
  hl: number | null
  beforeById: Map<number, string>
  onReload: () => void
  onOpenItem: (item: ItemView) => void
  onBackToLatest: () => void
  onRetry: () => void
}) {
  let body: ReactNode = null
  if (loading) {
    body = (
      <div className="rv-body">
        <Skeleton rows={4} />
      </div>
    )
  } else if (error) {
    body = <ErrorState message={error} onRetry={onReload} />
  } else if (card) {
    switch (card.state) {
      case 'generating':
        body = (
          <div className="rv-body">
            <Skeleton rows={4} />
            <p className="gennote">正在生成…</p>
          </div>
        )
        break
      case 'failed':
        body = <FailedState message={card.error} onRetry={onRetry} />
        break
      case 'none':
        body = (
          <div className="sum-state">
            <p>{card.scheduledAt ? `${hhmm(card.scheduledAt)} 生成` : '尚未生成'}</p>
            <Button variant="primary" onClick={onRetry}>
              立即生成
            </Button>
          </div>
        )
        break
      case 'empty':
        body = hasRecords ? (
          <div className="sum-state">
            <p>日结还没有生成</p>
            <Button variant="primary" onClick={onRetry}>
              立即生成
            </Button>
          </div>
        ) : (
          <EmptyState title="这个周期没有与我有关的记录" />
        )
        break
      case 'ok':
        body = (
          <ul className="rv-items">
            {card.items.map((item, index) => {
              const op = opById.get(item.itemId)
              return (
                <ItemRow
                  key={item.itemId}
                  item={op ? { ...item, op } : item}
                  level={level}
                  variant="review"
                  ordinal={index + 1}
                  highlight={hl === item.itemId}
                  showOp={versionLabel}
                  before={beforeById.get(item.itemId)}
                  onOpen={() => onOpenItem(item)}
                />
              )
            })}
          </ul>
        )
        break
    }
  }

  return (
    <div className="card rvcard">
      <div className="card-h">
        <h2>{title}</h2>
        {card?.version ? (
          <span className="ver">
            <b>v{card.version.version}</b> · {mdhm(card.version.createdAt)}
          </span>
        ) : null}
        {changeNote && prevVersion > 0 && !viewingOld ? (
          <span className="sub r">
            相比 v{prevVersion}：{changeNote}
          </span>
        ) : null}
      </div>
      {viewingOld && card ? (
        <div className="rv-upstream">
          <span>正在查看 v{card?.version?.version}（历史版本）</span>
          <Button onClick={onBackToLatest}>回到最新</Button>
        </div>
      ) : null}
      {card?.upstreamChanged ? (
        <div className="rv-upstream">
          <span>上游已变更 · 下层摘要出了新版本</span>
          <Button onClick={onRetry}>重建</Button>
        </div>
      ) : null}
      {body}
      {card && card.state === 'ok' ? (
        <div className="rv-foot">
          {level === 'day'
            ? dayFooter(card.inputCount, card.dayStats)
            : level === 'year'
              ? upperFooter(card.inputCount, '月摘要')
              : upperFooter(card.inputCount)}
        </div>
      ) : null}
    </div>
  )
}
