// 条目行：时间线里带来源色竖条，摘要卡里是圆点列表项。整行可点开证据抽屉。
import type { ItemView, Level } from '../../../src/api-types'
import { commonPrefix } from '../format'
import { EvidenceChips } from './primitives'

type Source = 'im' | 'mail' | 'event'

/** 条目的主要证据类型 → 左侧竖条颜色（原型里评审会条目用日程色、邮件条目用邮件色） */
export function primarySource(counts: ItemView['counts']): Source {
  if (counts.event) return 'event'
  if (counts.mail) return 'mail'
  return 'im'
}

const SOURCE_CLASS: Record<Source, string> = { im: '', mail: 'mail', event: 'cal' }

export function ItemRow({
  item,
  level,
  variant,
  source,
  onOpen,
  highlight = false,
  showOp,
  ordinal,
  before,
}: {
  item: ItemView
  level: Level
  variant: 'timeline' | 'card' | 'review'
  source?: Source
  onOpen: () => void
  highlight?: boolean
  /** 回顾页用：传入版本号前缀，例如 v4 → "v4 新增" */
  showOp?: string
  /** 回顾页用：条目序号 */
  ordinal?: number
  /** 回顾页用：本版修改前的文本，逐条对比时显示 */
  before?: string
}) {
  const opLabel =
    showOp && item.op !== 'keep' ? (
      <span className={`op ${item.op === 'add' ? 'add' : 'mod'}`}>{`${showOp} ${item.op === 'add' ? '新增' : '修改'}`}</span>
    ) : null

  if (variant === 'review') {
    const parts = before && item.op === 'edit' ? commonPrefix(before, item.text) : null
    return (
      <li className={highlight ? 'hl' : ''} onClick={onOpen} title={item.text}>
        <span className="n">{ordinal}</span>
        <span className="txt">
          {parts ? (
            <>
              {parts.prefix}
              <del>{parts.before}</del> → {parts.after}
            </>
          ) : (
            item.text
          )}
        </span>
        {opLabel}
        <EvidenceChips item={item} level={level} onOpen={onOpen} />
      </li>
    )
  }

  if (variant === 'card') {
    return (
      <li className={highlight ? 'hl' : ''} onClick={onOpen} title={item.text}>
        <span className="txt">{item.text}</span>
        {opLabel}
        <EvidenceChips item={item} level={level} onOpen={onOpen} />
      </li>
    )
  }

  return (
    <div className={`it${highlight ? ' hl' : ''}`} onClick={onOpen} title={item.text}>
      <span className={`src ${SOURCE_CLASS[source ?? primarySource(item.counts)]}`.trim()} />
      <span className="txt">{item.text}</span>
      {opLabel}
      <EvidenceChips item={item} level={level} onOpen={onOpen} />
    </div>
  )
}
