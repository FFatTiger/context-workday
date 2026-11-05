// 摘要卡：日期范围、版本徽标、条目、页脚，覆盖未生成 / 生成中 / 已生成 / 失败 / 无记录 / 上游已变更。
import type { CardResponse, ItemView } from '../../../src/api-types'
import { dayFooter, hhmm, levelLine, upperFooter } from '../format'
import { navigate } from '../router'
import { ItemRow } from './ItemRow'
import {
  Button,
  EmptyState,
  ErrorState,
  FailedState,
  Skeleton,
  VersionBadge,
} from './primitives'

const BRIEF = { day: '日', week: '周', month: '月' } as const

const EMPTY_TEXT = {
  day: '这一天没有与我有关的记录',
  week: '这一周没有与我有关的记录',
  month: '这个月没有与我有关的记录',
} as const

export function SummaryCard({
  level,
  title,
  card,
  loading,
  error,
  emphasize = false,
  hasRecords = false,
  highlightItemId,
  onReload,
  onOpenItem,
  onGenerate,
  onRegenerate,
  onRebuild,
}: {
  level: 'day' | 'week' | 'month'
  title: string
  card: CardResponse | null
  loading: boolean
  error: string | null
  emphasize?: boolean
  /** 这个周期下层已经有记录（当天有小时摘要）：empty 状态不说"没有记录"，而是还没生成 */
  hasRecords?: boolean
  highlightItemId?: number
  onReload: () => void
  onOpenItem: (item: ItemView) => void
  onGenerate: () => void
  onRegenerate: () => void
  onRebuild: () => void
}) {
  const lvl = card ? levelLine(level, card.rangeLabel) : BRIEF[level]

  let body = null
  if (loading) {
    body = (
      <div className="sum-body">
        <Skeleton rows={3} />
      </div>
    )
  } else if (error) {
    body = <ErrorState message={error} onRetry={onReload} />
  } else if (card) {
    switch (card.state) {
      case 'generating':
        body = (
          <div className="sum-body">
            <Skeleton rows={3} />
            <p className="gennote">正在生成…</p>
          </div>
        )
        break
      case 'failed':
        body = <FailedState message={card.error} onRetry={onRegenerate} />
        break
      case 'none':
        body = (
          <div className="sum-state">
            <p>
              {card.scheduledAt
                ? `${title === '今天' ? '今日日结' : level === 'day' ? '日结' : '摘要'}将在 ${hhmm(card.scheduledAt)} 生成`
                : '尚未生成'}
            </p>
            {level === 'day' ? (
              <Button variant="primary" onClick={onGenerate}>
                立即生成
              </Button>
            ) : null}
          </div>
        )
        break
      case 'empty':
        body =
          level === 'day' && hasRecords ? (
            <div className="sum-state">
              <p>日结还没有生成</p>
              <Button variant="primary" onClick={onGenerate}>
                立即生成
              </Button>
            </div>
          ) : (
            <EmptyState title={EMPTY_TEXT[level]} />
          )
        break
      case 'ok':
        body = (
          <ul>
            {card.items.map((item) => (
              <ItemRow
                key={item.itemId}
                item={item}
                level={level}
                variant="card"
                highlight={highlightItemId === item.itemId}
                onOpen={() => onOpenItem(item)}
              />
            ))}
          </ul>
        )
        break
    }
  }

  return (
    <div className={`card sum${emphasize ? ' today' : ''}`}>
      <div className="card-h">
        <div>
          <div className="lvl">{lvl}</div>
          <h3>{title}</h3>
        </div>
        <div className="head-right r">
          {card?.upstreamChanged ? (
            <button type="button" className="upstream" onClick={onRebuild}>
              上游已变更 · 重建
            </button>
          ) : null}
          {card?.state === 'ok' && card.version ? <VersionBadge version={card.version} level={level} /> : null}
        </div>
      </div>
      {body}
      {card && card.state === 'ok' ? (
        <div className="f">
          <span>
            {level === 'day' ? dayFooter(card.inputCount, card.dayStats) : upperFooter(card.inputCount)}
          </span>
          {level === 'day' ? null : (
            <button type="button" className="link" onClick={() => navigate(`/review/${level}/${card.period}`)}>
              查看版本 ›
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}
