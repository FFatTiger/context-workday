// 今天页（ui.md 5.1）：日期切换、24 小时活动条、时间线、右侧三张摘要卡。
import { useEffect, useState } from 'react'
import type { CardResponse, ItemView, Level } from '../../../src/api-types'
import { periodKey, local } from '../../../src/time'
import { getCard, getTimeline, regenerate, runDaily, todayKey } from '../api'
import { useDrawer } from '../components/Drawer'
import { IconChevronLeft, IconChevronRight } from '../components/icons'
import { ConfirmDialog } from '../components/Modal'
import { StatusPill } from '../components/primitives'
import { SummaryCard } from '../components/SummaryCard'
import { Timeline } from '../components/Timeline'
import { useToast } from '../components/Toast'
import {
  dateStart,
  dayTitle,
  hhmm,
  num,
  periodTitle,
  shiftDate,
  weekdayOf,
} from '../format'
import { errorText, useApi } from '../hooks/useApi'
import { navigate } from '../router'

interface Confirming {
  title: string
  body: string
  confirmText: string
  action: () => Promise<void>
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function Today({ date, hlParam }: { date: string; hlParam: string | null }) {
  const today = todayKey()
  const drawer = useDrawer()
  const toast = useToast()
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [highlight, setHighlight] = useState<string | null>(hlParam)

  const timeline = useApi(() => getTimeline(date), [date])
  const dayCard = useApi(() => getCard('day', { date }), [date])
  const weekCard = useApi(() => getCard('week', { date }), [date])
  const monthCard = useApi(() => getCard('month', { date }), [date])

  const start = dateStart(date)
  const weekPeriod = periodKey('week', start)
  const monthPeriod = periodKey('month', start)

  useEffect(() => {
    if (date > today) navigate(`/today/${today}`, { replace: true })
  }, [date, today])

  useEffect(() => {
    if (!hlParam) return
    setHighlight(hlParam)
    const timer = window.setTimeout(() => setHighlight(null), 2000)
    return () => window.clearTimeout(timer)
  }, [hlParam])

  useEffect(() => {
    if (!highlight) return
    document.querySelector('.hl')?.scrollIntoView({ block: 'center' })
  }, [highlight, timeline.data, dayCard.data, weekCard.data, monthCard.data])

  function reloadAll() {
    timeline.reload()
    dayCard.reload()
    weekCard.reload()
    monthCard.reload()
  }

  function confirmRegenerateSummary(level: Level, card: CardResponse | null, title: string) {
    if (!card) return
    const next = (card.version?.version ?? 0) + 1
    setConfirming({
      title: `重新生成${title}`,
      body: `将用最新的下层摘要完整重新生成，产生 v${next}。`,
      confirmText: '重新生成',
      action: async () => {
        try {
          await regenerate(level, card.period)
          toast('已重新生成')
          reloadAll()
        } catch (error) {
          toast(`重新生成失败：${errorText(error)}`)
        }
      },
    })
  }

  function confirmRegenerateHour(period: string) {
    const block = timeline.data?.hours.find((hour) => hour.period === period)
    const next = (block?.version?.version ?? 1) + 1
    setConfirming({
      title: `重新生成 ${period.slice(11)}:00 小时摘要`,
      body: `将用这个小时的原文完整重新生成，产生 v${next}。`,
      confirmText: '重新生成',
      action: async () => {
        try {
          await regenerate('hour', period)
          toast('已重新生成')
          reloadAll()
        } catch (error) {
          toast(`重新生成失败：${errorText(error)}`)
        }
      },
    })
  }

  async function generateDay(card: CardResponse | null) {
    if (!card) return
    try {
      if (date === today) {
        const run = await runDaily()
        if (run.result === 'success') toast('已生成日结')
        else if (run.result === 'skipped') toast(run.note || '没有可生成的内容')
        else toast(`生成失败：${run.note}`)
      } else {
        await regenerate('day', card.period)
        toast('已生成日结')
      }
      reloadAll()
    } catch (error) {
      toast(`生成失败：${errorText(error)}`)
    }
  }

  function openItem(level: Level, period: string, version: number, item: ItemView) {
    drawer.open({ ref: { level, period, version, itemId: item.itemId } })
  }

  const isToday = date === today
  const previousDate = shiftDate(date, -1)
  const nextDate = shiftDate(date, 1)

  function dateLink(next: string): string {
    const params = new URLSearchParams(location.search)
    params.delete('hl')
    params.delete('open')
    const search = params.toString()
    return `/today/${next}${search ? `?${search}` : ''}`
  }

  const day = dayCard.data
  let dailyText = '日结 …'
  let dailyTone: 'ok' | 'bad' | 'warn' | 'muted' = 'muted'
  if (dayCard.error) {
    dailyText = '日结 加载失败'
    dailyTone = 'bad'
  } else if (day) {
    switch (day.state) {
      case 'ok':
        dailyText = day.version ? `日结 ${hhmm(day.version.createdAt)} 已生成` : '日结 已生成'
        dailyTone = 'ok'
        break
      case 'generating':
        dailyText = '日结 生成中'
        dailyTone = 'warn'
        break
      case 'failed':
        dailyText = '日结 生成失败'
        dailyTone = 'bad'
        break
      case 'none':
        dailyText = day.scheduledAt ? `日结 ${hhmm(day.scheduledAt)} 生成` : '日结 未生成'
        dailyTone = 'muted'
        break
      case 'empty':
        dailyText = '日结 无记录'
        dailyTone = 'muted'
        break
    }
  }

  return (
    <>
      <div className="dayhead">
        <h1>
          {dayTitle(date)}
          <span>{weekdayOf(date)}</span>
        </h1>
        <button
          type="button"
          className="navbtn"
          aria-label="前一天"
          onClick={() => navigate(dateLink(previousDate))}
        >
          <IconChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="navbtn"
          aria-label="后一天"
          disabled={nextDate > today}
          onClick={() => navigate(dateLink(nextDate))}
        >
          <IconChevronRight size={16} />
        </button>
        {isToday ? null : (
          <button type="button" className="link back-today" onClick={() => navigate(`/today/${today}`)}>
            回到今天
          </button>
        )}
        <div className="meta">
          <StatusPill tone={dailyTone} dot={false}>
            {dailyText}
          </StatusPill>
          {day?.dayStats ? (
            <StatusPill tone="muted" dot={false}>
              {num(day.dayStats.totalMsgs)} 条消息 · 与我有关 {num(day.dayStats.relatedMsgs)} 条
            </StatusPill>
          ) : null}
        </div>
      </div>

      <ActivityStrip
        activity={timeline.data?.activity ?? null}
        error={timeline.error}
        hourCount={
          timeline.data
            ? timeline.data.hours.filter((hour) => hour.state !== 'generating' && (hour.items.length > 0 || hour.related > 0)).length
            : 0
        }
        now={timeline.data?.isToday ? timeline.data.now : null}
      />

      <div className="grid">
        <Timeline
          isToday={isToday}
          timeline={timeline.data}
          loading={timeline.loading}
          error={timeline.error}
          hl={highlight}
          onReload={timeline.reload}
          onOpenItem={(ref) => drawer.open({ ref })}
          onRegenerate={confirmRegenerateHour}
        />

        <aside className="ladder">
          <SummaryCard
            level="day"
            title={isToday ? '今天' : dayTitle(date)}
            card={day}
            loading={dayCard.loading}
            error={dayCard.error}
            emphasize={isToday}
            hasRecords={(timeline.data?.hours.length ?? 0) > 0}
            highlightItemId={
              highlight?.startsWith(`${dayCard.data?.period}:`)
                ? Number(highlight.split(':')[1])
                : undefined
            }
            onReload={dayCard.reload}
            onOpenItem={(item) => {
              if (day?.version) openItem('day', day.period, day.version.version, item)
            }}
            onGenerate={() => generateDay(day)}
            onRegenerate={() => confirmRegenerateSummary('day', day, isToday ? '今天' : dayTitle(date))}
            onRebuild={() => confirmRegenerateSummary('day', day, isToday ? '今天' : dayTitle(date))}
          />
          <SummaryCard
            level="week"
            title={periodTitle('week', weekPeriod, today)}
            card={weekCard.data}
            loading={weekCard.loading}
            error={weekCard.error}
            highlightItemId={
              highlight?.startsWith(`${weekCard.data?.period ?? weekPeriod}:`)
                ? Number(highlight.split(':')[1])
                : undefined
            }
            onReload={weekCard.reload}
            onOpenItem={(item) => {
              const card = weekCard.data
              if (card?.version) openItem('week', card.period, card.version.version, item)
            }}
            onGenerate={() => confirmRegenerateSummary('week', weekCard.data, periodTitle('week', weekPeriod, today))}
            onRegenerate={() => confirmRegenerateSummary('week', weekCard.data, periodTitle('week', weekPeriod, today))}
            onRebuild={() => confirmRegenerateSummary('week', weekCard.data, periodTitle('week', weekPeriod, today))}
          />
          <SummaryCard
            level="month"
            title={periodTitle('month', monthPeriod, today)}
            card={monthCard.data}
            loading={monthCard.loading}
            error={monthCard.error}
            highlightItemId={
              highlight?.startsWith(`${monthCard.data?.period ?? monthPeriod}:`)
                ? Number(highlight.split(':')[1])
                : undefined
            }
            onReload={monthCard.reload}
            onOpenItem={(item) => {
              const card = monthCard.data
              if (card?.version) openItem('month', card.period, card.version.version, item)
            }}
            onGenerate={() =>
              confirmRegenerateSummary('month', monthCard.data, periodTitle('month', monthPeriod, today))
            }
            onRegenerate={() =>
              confirmRegenerateSummary('month', monthCard.data, periodTitle('month', monthPeriod, today))
            }
            onRebuild={() =>
              confirmRegenerateSummary('month', monthCard.data, periodTitle('month', monthPeriod, today))
            }
          />
        </aside>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.title ?? ''}
        body={confirming?.body ?? ''}
        confirmText={confirming?.confirmText}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const pending = confirming
          setConfirming(null)
          if (pending) void pending.action()
        }}
      />
    </>
  )
}

function ActivityStrip({
  activity,
  error,
  hourCount,
  now,
}: {
  activity: number[] | null
  error: string | null
  hourCount: number
  now: number | null
}) {
  const values = activity ?? new Array<number>(24).fill(0)
  const max = Math.max(1, ...values)
  const nowHour = now === null ? -1 : local(now).h
  const filled = values.map((value, hour) => ({ value, hour })).filter((entry) => entry.value > 0 && entry.hour !== nowHour)
  const range =
    filled.length === 0
      ? '暂无记录'
      : filled[0].hour === filled[filled.length - 1].hour
        ? `${pad(filled[0].hour)} 时`
        : `${pad(filled[0].hour)} – ${pad(filled[filled.length - 1].hour)} 时`

  return (
    <div className="strip">
      <div className="strip-top">
        <span>
          {activity === null ? (
            <span className="muted">{error ? '活动条不可用' : '正在加载…'}</span>
          ) : (
            <>
              <b>{hourCount} 个小时</b>有记录
            </>
          )}
        </span>
        <span>{activity === null ? '' : range}</span>
      </div>
      <div className="bars">
        {values.map((value, hour) => {
          if (hour === nowHour) return <div className="now" key={hour} />
          const height = value > 0 ? Math.max(8, Math.round((value / max) * 34)) : 6
          return <div className={value > 0 ? 'h' : ''} key={hour} style={{ height }} />
        })}
      </div>
      <div className="hours">
        {values.map((_, hour) => (
          <span key={hour}>{pad(hour)}</span>
        ))}
      </div>
    </div>
  )
}
