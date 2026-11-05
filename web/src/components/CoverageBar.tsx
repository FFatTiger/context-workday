// 覆盖条：每格一天，四种状态 + 今天描边 + 悬停详情 + 缺口标注 + 右侧 7 格可补救窗口括号。
import type { CoverageResponse, CoverageState } from '../../../src/api-types'
import { dateStart, md } from '../format'
import { ruleTimeText } from '../schedule'

const STATE_TEXT: Record<CoverageState, string> = {
  ok: '已备份',
  gap_recoverable: '缺口 · 可补救',
  gap_expired: '缺口 · 已过期',
  no_data: '无数据',
  pending: '等待备份',
}

const CLASS: Record<CoverageState, string> = {
  ok: '',
  gap_recoverable: 'w',
  gap_expired: 'x',
  no_data: 'n',
  pending: 'p',
}

function dayLabel(day: string): string {
  return md(dateStart(day))
}

function gapNote(days: CoverageResponse['days']): string | null {
  const gaps = days.filter((day) => day.state === 'gap_expired' || day.state === 'gap_recoverable')
  if (!gaps.length) return null
  const runs: Array<typeof gaps> = []
  for (const day of gaps) {
    const last = runs[runs.length - 1]
    if (last && dateStart(day.day) - dateStart(last[last.length - 1].day) === 86_400_000) last.push(day)
    else runs.push([day])
  }
  return runs
    .map((run) => {
      const from = dayLabel(run[0].day)
      const to = dayLabel(run[run.length - 1].day)
      const range = run.length === 1 ? from : `${from} – ${to}`
      return `${range} 备份失败，${run[0].state === 'gap_expired' ? '原文已过期' : '还在可补救窗口'}`
    })
    .join('；')
}

export function CoverageBar({ coverage }: { coverage: CoverageResponse }) {
  const count = coverage.days.length
  const template = { gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }
  const note = gapNote(coverage.days)
  const today = coverage.days[coverage.days.length - 1]?.day
  const windowDays = coverage.days.slice(-7)
  // pending（等待备份）不算未备份；no_data 仍算，维持“窗口内还没存下来的天数”含义
  const windowMissing = windowDays.filter((day) => day.state !== 'ok' && day.state !== 'pending').length
  const unbacked = Math.max(coverage.unbackedInWindow, windowMissing)
  const neverBackedUp = coverage.days.every((day) => day.state === 'no_data')

  return (
    <>
      <div className="bracket-row" style={template}>
        <span className="bracket-label" style={{ gridColumn: `${Math.max(1, count - 6)} / span ${Math.min(7, count)}` }}>
          {unbacked === 0 ? (
            <span className="bracket-ok">7 天可补救窗口 · 全部已备份 ✓</span>
          ) : (
            <span className="bracket-warn">7 天可补救窗口 · {unbacked} 天未备份</span>
          )}
        </span>
      </div>
      <div className="cells" style={template}>
        {coverage.days.map((day) => (
          <i
            key={day.day}
            className={`${CLASS[day.state]}${day.day === today ? ' t' : ''}`.trim()}
          >
            <span className="tip">
              {dayLabel(day.day)} · {day.state === 'pending' ? `等待 ${ruleTimeText(coverage.rule)} 备份` : STATE_TEXT[day.state]}
              {day.state === 'ok' ? ` · 客户端 ${day.clientCount ?? 0} 条 · 本机 ${day.localCount ?? 0} 条` : ''}
              {day.state === 'gap_expired' || day.state === 'gap_recoverable'
                ? ` · 客户端 ${day.clientCount ?? 0} 条 · 本机 ${day.localCount ?? 0} 条`
                : ''}
            </span>
          </i>
        ))}
        <span
          className="cov-overlay"
          style={template}
          aria-hidden
        >
          <span
            className="cov-win"
            style={{ gridColumn: `${Math.max(1, count - 6)} / span ${Math.min(7, count)}` }}
          />
        </span>
      </div>
      <div className="cov-l">
        <span>{coverage.days[0] ? dayLabel(coverage.days[0].day) : ''}</span>
        <span className="muted">{note ?? (neverBackedUp ? '还没有备份' : '没有缺口')}</span>
        <span>{today ? '今天' : ''}</span>
      </div>
    </>
  )
}
