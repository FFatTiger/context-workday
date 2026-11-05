// 时间线卡：按小时逐行，空档用虚线说明，今天末尾有"现在"行。
// 回顾页的小时层级也复用它。
import type { HourBlock, ItemRef, TimelineResponse } from '../../../src/api-types'
import { hhmm } from '../format'
import { ItemRow } from './ItemRow'
import { IconRefresh } from './icons'
import { EmptyState, ErrorState, Skeleton, VersionBadge } from './primitives'

const pad = (n: number) => String(n).padStart(2, '0')

type Row =
  | { type: 'hour'; block: HourBlock; at: number }
  | { type: 'gap'; from: number; to: number; at: number }

export function Timeline({
  isToday,
  timeline,
  loading,
  error,
  hl,
  onReload,
  onOpenItem,
  onRegenerate,
  onSelectHour,
  selectedHour,
  title,
  scroll = true,
}: {
  isToday: boolean
  timeline: TimelineResponse | null
  loading: boolean
  error: string | null
  hl?: string | null
  onReload: () => void
  onOpenItem: (ref: ItemRef) => void
  onRegenerate: (period: string) => void
  /** 回顾页用：点小时卡看这个小时的版本历史 */
  onSelectHour?: (period: string) => void
  selectedHour?: string | null
  /** 卡片标题；默认按是否今天取 */
  title?: string
  /** 卡片内部是否自己滚动（今天页用，回顾页让页面滚） */
  scroll?: boolean
}) {
  const today = timeline?.isToday ?? isToday

  const rows: Row[] = []
  if (timeline) {
    for (const block of timeline.hours) rows.push({ type: 'hour', block, at: block.hour })
    for (const gap of timeline.gaps) rows.push({ type: 'gap', from: gap.from, to: gap.to, at: gap.from })
    rows.sort((a, b) => a.at - b.at)
  }

  const empty = timeline !== null && timeline.hours.length === 0

  return (
    <div className="card timeline-card">
      <div className="card-h">
        <h2>{title ?? (today ? '今日时间线' : '时间线')}</h2>
        <span className="sub">按小时 · 只显示有记录的小时</span>
        <span className="r sub legend-inline">
          <span style={{ color: 'var(--im)' }}>▍</span>IM&nbsp;&nbsp;
          <span style={{ color: 'var(--cal)' }}>▍</span>日程&nbsp;&nbsp;
          <span style={{ color: 'var(--mail)' }}>▍</span>邮件
        </span>
      </div>
      <div className={scroll ? 'tl' : 'tl noscroll'}>
        {loading ? <Skeleton rows={6} /> : null}
        {!loading && error ? <ErrorState message={error} onRetry={onReload} /> : null}
        {!loading && !error && empty ? (
          <EmptyState
            title={today ? '今天还没有与我有关的记录' : '这一天没有与我有关的记录'}
            note={
              timeline?.nextHourlyAt ? `下次小时摘要 ${hhmm(timeline.nextHourlyAt)}` : undefined
            }
          />
        ) : null}
        {!loading && !error
          ? rows.map((row) => {
              if (row.type === 'gap') {
                return (
                  <div className="gap" key={`gap-${row.from}`}>
                    <div />
                    <div className="b">
                      <span>
                        {row.to - row.from === 1
                          ? `${pad(row.from)}:00 · 无记录`
                          : `${pad(row.from)}:00 – ${pad(row.to)}:00 · 无与我有关的消息`}
                      </span>
                    </div>
                  </div>
                )
              }
              const block = row.block
              const selected = selectedHour === block.period
              return (
                <div className={`hr${selected ? ' sel' : ''}`} key={block.period}>
                  <div className="t">
                    {pad(block.hour)}:00
                    <small>
                      {block.state === 'ok' && block.version ? (
                        <VersionBadge version={block.version} level="hour" />
                      ) : block.state === 'generating' ? (
                        <span className="gennote">正在生成…</span>
                      ) : (
                        <span className="s-bad">生成失败</span>
                      )}
                    </small>
                    {onSelectHour ? (
                      <button type="button" className="hourlink" onClick={() => onSelectHour(block.period)}>
                        版本 ›
                      </button>
                    ) : null}
                  </div>
                  <div className="b">
                    {block.state === 'generating' ? (
                      <div className="entry">
                        <Skeleton rows={2} />
                        <div className="gennote">正在生成…</div>
                      </div>
                    ) : block.state === 'failed' ? (
                      <div className="entry err-entry">
                        <span className="s-bad">生成失败{block.error ? ` · ${block.error}` : ''}</span>
                        <button type="button" className="link" onClick={() => onRegenerate(block.period)}>
                          重试
                        </button>
                      </div>
                    ) : (
                      <div className={`entry${selected ? ' sel' : ''}`}>
                        {block.items.map((item) => (
                          <ItemRow
                            key={item.itemId}
                            item={item}
                            level="hour"
                            variant="timeline"
                            highlight={hl === `${block.period}:${item.itemId}`}
                            onOpen={() =>
                              onOpenItem({
                                level: 'hour',
                                period: block.period,
                                version: block.version?.version ?? 1,
                                itemId: item.itemId,
                              })
                            }
                          />
                        ))}
                        <button
                          type="button"
                          className="regen"
                          title="重新生成"
                          aria-label="重新生成这个小时"
                          onClick={() => onRegenerate(block.period)}
                        >
                          <IconRefresh size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })
          : null}
        {!loading && !error && today && timeline && timeline.hours.length > 0 ? (
          <div className="nowrow">
            <div className="t">{hhmm(timeline.now)}</div>
            <div className="b">
              下次小时摘要 {timeline.nextHourlyAt ? hhmm(timeline.nextHourlyAt) : '—'}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
