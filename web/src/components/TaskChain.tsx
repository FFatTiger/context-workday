// 任务页：更新链路图和 24 小时刻度尺（ui.md 5.6）。节点上的时间都取自当前任务配置。
import type { Job, JobName, ScheduleRule } from '../../../src/api-types'
import { hourlyMinute, scheduleText } from '../schedule'

function ruleOf(jobs: Job[], name: JobName): ScheduleRule | null {
  return jobs.find((job) => job.name === name)?.rule ?? null
}

function timeText(jobs: Job[], name: JobName): string {
  const rule = ruleOf(jobs, name)
  return rule ? scheduleText(rule) : '—'
}

function shortTime(rule: ScheduleRule): string {
  return scheduleText(rule).replace(/^每天\s?/, '')
}

export function TaskChain({ jobs }: { jobs: Job[] }) {
  const backupParts: string[] = []
  for (const name of ['backup_im', 'backup_calendar', 'backup_mail'] as JobName[]) {
    const rule = ruleOf(jobs, name)
    if (!rule) continue
    const label = name === 'backup_im' ? 'IM' : name === 'backup_calendar' ? '日程' : '邮件'
    backupParts.push(`${label} ${shortTime(rule)}`)
  }

  return (
    <div className="chain">
      <div className="chain-row">
        <div className="cnode">
          <span className="cn-t">原文</span>
          <span className="cn-s">IM · 邮件 · 日程</span>
        </div>
        <span className="carrow">→</span>
        <div className="cnode">
          <span className="cn-t">小时摘要</span>
          <span className="cn-s">{timeText(jobs, 'hourly')}</span>
        </div>
        <span className="carrow">→</span>
        <div className="cnode strong">
          <span className="cn-t">日结</span>
          <span className="cn-s">{timeText(jobs, 'daily')}</span>
        </div>
        <span className="carrow">增量 →</span>
        <div className="cbranch">
          <div className="cnode">
            <span className="cn-t">本周</span>
            <span className="cn-s">每天增量 · 周日收尾</span>
          </div>
          <div className="cnode">
            <span className="cn-t">本月</span>
            <span className="cn-s">每天增量 · 月末收尾</span>
          </div>
          <div className="cnode">
            <span className="cn-t">本年</span>
            <span className="cn-s">{timeText(jobs, 'yearly')}</span>
          </div>
        </div>
        <span className="csep" />
        <div className="cnode">
          <span className="cn-t">备份</span>
          <span className="cn-s">{backupParts.join(' · ') || '—'}</span>
        </div>
      </div>
      <div className="chain-loop">
        <span className="loop-mark">↺</span>
        <span>
          <b>次日补跑</b> · {timeText(jobs, 'catchup')}：日结之后又出现新的小时摘要，次日自动增量补一次日结，
          并再更新本周和本月；周期结束时做收尾。
        </span>
      </div>
    </div>
  )
}

interface RulerEvent {
  at: number
  label: string
  highlight?: boolean
}

function eventsOf(jobs: Job[]): RulerEvent[] {
  const groups = new Map<number, RulerEvent>()
  const put = (rule: ScheduleRule, label: string, highlight = false) => {
    if (rule.type === 'hourly') return
    const at = rule.hour * 60 + rule.minute
    const existing = groups.get(at)
    if (existing) {
      existing.label = `${existing.label} · ${label}`
      existing.highlight = existing.highlight || highlight
      return
    }
    groups.set(at, { at, label, highlight })
  }
  for (const job of jobs) {
    if (job.name === 'catchup') put(job.rule, '补跑')
    else if (job.name === 'daily') put(job.rule, '日结 → 周 · 月', true)
    else if (job.name === 'backup_im') put(job.rule, '备份')
  }
  return [...groups.values()].sort((a, b) => a.at - b.at)
}

export function DayRuler({ jobs, now }: { jobs: Job[]; now: number }) {
  const minute = hourlyMinute(jobs.map((job) => job.rule))
  const events = eventsOf(jobs)
  const percent = (at: number) => `${(at / 1440) * 100}%`
  const nowAt = (() => {
    const d = new Date(now + 8 * 3_600_000)
    return d.getUTCHours() * 60 + d.getUTCMinutes()
  })()

  return (
    <div className="rl">
      <div className="axis" />
      {Array.from({ length: 25 }, (_, index) => (
        <span className="tick" key={`tick-${index}`} style={{ left: percent(index * 60) }} />
      ))}
      {Array.from({ length: 25 }, (_, index) =>
        index % 3 === 0 ? (
          <span className="tl2" key={`label-${index}`} style={{ left: percent(index * 60) }}>
            {String(index).padStart(2, '0')}
          </span>
        ) : null,
      )}
      {Array.from({ length: 24 }, (_, hour) => (
        <span className="hs" key={`hour-${hour}`} style={{ left: percent(hour * 60 + minute) }} />
      ))}
      {events.map((event) => (
        <span
          className={`ev${event.highlight ? ' a' : ''}`}
          key={event.at}
          style={{ left: percent(event.at) }}
        >
          {String(Math.floor(event.at / 60)).padStart(2, '0')}:{String(event.at % 60).padStart(2, '0')} {event.label}
        </span>
      ))}
      <span className="nowl" style={{ left: percent(nowAt) }} />
    </div>
  )
}
