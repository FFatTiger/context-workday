// 回顾页左栏下方：周 → 7 张日结小卡，月 → 当月每天，年 → 12 个月（ui.md 第 4 节"日结小卡"）。
import type { ChildPeriod, Level } from '../../../src/api-types'
import { hhmm } from '../format'

export function ChildCards({
  level,
  children,
  selectedVersion,
  onOpen,
}: {
  level: Level
  children: ChildPeriod[]
  selectedVersion: number | null
  onOpen: (child: ChildPeriod) => void
}) {
  if (!children.length) return <p className="muted cells-empty">没有下层输入</p>

  return (
    <div className={level === 'year' ? 'months' : 'days'}>
      {children.map((child) => {
        const merged = child.mergedIn !== undefined && child.mergedIn === selectedVersion
        const classes = ['day']
        if (child.state === 'future') classes.push('fut')
        if (child.state === 'none') classes.push('pending')
        if (merged) classes.push('cur')
        return (
          <button type="button" key={child.period} className={classes.join(' ')} onClick={() => onOpen(child)}>
            <b>{child.label}</b>
            {child.state === 'future' ? <span className="muted">—</span> : null}
            {child.state === 'none' ? (
              <span>{child.scheduledAt ? `${hhmm(child.scheduledAt)} 生成` : '待生成'}</span>
            ) : null}
            {child.state === 'empty' ? <span className="muted">无记录</span> : null}
            {child.state === 'ok' && child.preview.length ? (
              <span className="line">{child.preview.slice(0, 2).join('；')}</span>
            ) : null}
            {merged ? <span className="op mod">已并入 v{child.mergedIn}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
