// 证据抽屉：结论、层级路径、汇总、证据树、原文弹窗。点入口是任意条目或证据角标。
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { EvidenceNode, EvidenceResponse, ItemRef, Level } from '../../../src/api-types'
import { dayKey } from '../../../src/time'
import {
  getEventDetail,
  getEvidence,
  getImContext,
  getMailDetail,
  todayKey,
} from '../api'
import { hhmm, lostReasonText, mdhm, periodTitle } from '../format'
import { useApi } from '../hooks/useApi'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { navigate } from '../router'
import { IconCalendar, IconChevronDown, IconMail, IconWarn } from './icons'
import { isModalOpen } from './modal-stack'
import { Modal } from './Modal'
import { Button, ErrorState, Skeleton } from './primitives'

export interface DrawerTarget {
  ref: ItemRef
}

interface DrawerApi {
  open: (target: DrawerTarget) => void
  close: () => void
}

const DrawerContext = createContext<DrawerApi | null>(null)

export function useDrawer(): DrawerApi {
  const context = useContext(DrawerContext)
  if (!context) throw new Error('useDrawer 必须放在 DrawerProvider 里')
  return context
}

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<DrawerTarget | null>(null)
  const [expandRaw, setExpandRaw] = useState(false)

  const open = useCallback((next: DrawerTarget) => {
    setTarget(next)
    setExpandRaw(false)
  }, [])
  const close = useCallback(() => setTarget(null), [])
  const value = useMemo(() => ({ open, close }), [open, close])

  return (
    <DrawerContext.Provider value={value}>
      {children}
      <EvidenceDrawer
        target={target}
        expandRaw={expandRaw}
        onExpandRaw={() => setExpandRaw(true)}
        onClose={close}
      />
    </DrawerContext.Provider>
  )
}

type RawTarget =
  | { kind: 'im'; id: string }
  | { kind: 'mail'; id: string }
  | { kind: 'event'; id: string }

const RAW_TYPE_NAME: Record<'im' | 'mail' | 'event', string> = { im: 'IM ', mail: '邮件', event: '日程' }

function targetKey(target: DrawerTarget | null): string {
  if (!target) return 'none'
  const { level, period, version, itemId } = target.ref
  return `${level}|${period}|${version}|${itemId}`
}

const ITEM_UNIT: Record<Level, string> = {
  hour: '个小时摘要',
  day: '个小时摘要',
  week: '份日结',
  month: '份日结',
  year: '份月摘要',
}

function EvidenceDrawer({
  target,
  expandRaw,
  onExpandRaw,
  onClose,
}: {
  target: DrawerTarget | null
  expandRaw: boolean
  onExpandRaw: () => void
  onClose: () => void
}) {
  const panelRef = useRef<HTMLElement>(null)
  const [raw, setRaw] = useState<RawTarget | null>(null)
  const open = target !== null
  const key = targetKey(target)
  const state = useApi<EvidenceResponse | null>(
    () => (target ? getEvidence(target.ref, expandRaw) : Promise.resolve(null)),
    [key, expandRaw],
  )

  useFocusTrap(panelRef, open && raw === null)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isModalOpen()) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  const data =
    state.data &&
    target &&
    state.data.item.level === target.ref.level &&
    state.data.item.period === target.ref.period &&
    state.data.item.version === target.ref.version &&
    state.data.item.itemId === target.ref.itemId
      ? state.data
      : null
  const where = target
    ? `${periodTitle(target.ref.level, target.ref.period, todayKey())} · v${target.ref.version}${
        data ? ` · 第 ${data.item.itemIndex} 条` : ''
      }`
    : ''

  function goHistory() {
    if (!target) return
    navigate(`/review/${target.ref.level}/${target.ref.period}?item=${target.ref.itemId}`)
    onClose()
  }

  return (
    <>
      <div className={`mask${open ? ' on' : ''}`} onClick={onClose} />
      <aside className={`drawer${open ? ' on' : ''}`} ref={panelRef} role="dialog" aria-modal={open} aria-label="证据" tabIndex={-1}>
        {target ? (
          <>
            <div className="dr-h">
              <button type="button" className="x" aria-label="关闭" onClick={onClose}>
                ×
              </button>
              <div className="where">{where}</div>
              <h2>{data?.item.text ?? '…'}</h2>
              <div className="path">
                {(data?.path ?? []).map((step, index) => (
                  <Fragment key={`${step.label}-${index}`}>
                    <span>{step.label}</span>›
                  </Fragment>
                ))}
                <span className="on">原文</span>
              </div>
            </div>
            <div className="dr-b">
              {state.loading && !data ? <Skeleton rows={5} /> : null}
              {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
              {data ? (
                <>
                  <div className="stat">
                    {data.totals.items ? (
                      <span>
                        <b>{data.totals.items}</b>
                        {ITEM_UNIT[data.item.level]}
                      </span>
                    ) : null}
                    {data.totals.im ? (
                      <span>
                        <b>{data.totals.im}</b>条原文
                      </span>
                    ) : null}
                    {data.totals.mail ? (
                      <span>
                        <b>{data.totals.mail}</b>封邮件
                      </span>
                    ) : null}
                    {data.totals.event ? (
                      <span>
                        <b>{data.totals.event}</b>场日程
                      </span>
                    ) : null}
                    {data.totals.degraded ? (
                      <span className="w">
                        <b>{data.totals.degraded}</b>处降级
                      </span>
                    ) : null}
                  </div>
                  <div className="tree" key={expandRaw ? 'raw' : 'base'}>
                    {data.nodes.map((node, index) => (
                      <NodeView key={index} node={node} depth={0} onRaw={setRaw} onMore={onExpandRaw} />
                    ))}
                  </div>
                  <div className="tree-actions">
                    {expandRaw ? (
                      <span className="muted">已展开到原文</span>
                    ) : (
                      <Button onClick={onExpandRaw}>展开到原文</Button>
                    )}
                  </div>
                </>
              ) : null}
            </div>
            <div className="dr-f">
              <Button onClick={goHistory}>查看本条历史版本</Button>
            </div>
          </>
        ) : null}
      </aside>

      {raw?.kind === 'im' ? <ImContextModal id={raw.id} onClose={() => setRaw(null)} /> : null}
      {raw?.kind === 'mail' ? <MailModal id={raw.id} onClose={() => setRaw(null)} /> : null}
      {raw?.kind === 'event' ? <EventModal id={raw.id} onClose={() => setRaw(null)} /> : null}
    </>
  )
}

function NodeView({
  node,
  depth,
  onRaw,
  onMore,
}: {
  node: EvidenceNode
  depth: number
  onRaw: (target: RawTarget) => void
  onMore: () => void
}) {
  switch (node.kind) {
    case 'item':
      return <ItemNode node={node} depth={depth} onRaw={onRaw} onMore={onMore} />
    case 'im':
      return (
        <div className="msg">
          <span className={`av${node.isMine ? ' me' : ''}`}>{node.sender.slice(0, 1)}</span>
          <div className="msg-b">
            <div className="who">
              <b>{node.sender}</b>
              {hhmm(node.time)}
            </div>
            <div className="msg-text">{node.text}</div>
            <button type="button" className="ctx" onClick={() => onRaw({ kind: 'im', id: node.id })}>
              上下文
            </button>
          </div>
          <span className="tag">原文</span>
        </div>
      )
    case 'mail':
      return (
        <button type="button" className="sub-node mail" onClick={() => onRaw({ kind: 'mail', id: node.id })}>
          <span className="ic">
            <IconMail size={15} />
          </span>
          <span className="mail-text">
            <span className="mail-subject">《{node.subject}》</span>
            <span className="mail-meta">
              {node.from} → {node.to} · {mdhm(node.time)}
            </span>
          </span>
          <span className="tag">原文</span>
        </button>
      )
    case 'event':
      return (
        <button type="button" className="sub-node mail" onClick={() => onRaw({ kind: 'event', id: node.id })}>
          <span className="ic">
            <IconCalendar size={15} />
          </span>
          <span className="mail-text">
            <span className="mail-subject">{node.title}</span>
            <span className="mail-meta">
              {hhmm(node.start)} – {hhmm(node.end)} · {node.attendeeCount} 人参会
            </span>
          </span>
          <span className="tag">原文</span>
        </button>
      )
    case 'lost': {
      // 票 11：同一小时条目的多条丢失原文在后端合并成一个降级框，文本/生成时间/条数都在节点上
      return (
        <div className="lost">
          <div className="h">
            <IconWarn size={13} /> {node.count > 1 ? `${node.count} 条原文已丢失` : '原文已丢失'} · 降级为 AI 当时概述
          </div>
          {node.text ? <div className="lost-text">{node.text}</div> : null}
          <div className="m">
            AI 概述 · 生成于 {mdhm(node.generatedAt)}
            <br />
            {lostReasonText(node.reason, node.rawType)}
            {node.mixedReasons && node.count > 1 ? ` 等 ${node.count} 条` : ''}
          </div>
        </div>
      )
    }
    case 'more':
      return (
        <button type="button" className="morebtn" onClick={onMore}>
          还有 {node.count} 条
        </button>
      )
    // 客户端没连上、又没法从本机判定时（票 03 新增的节点）：不是丢失，也不计降级
    case 'unreadable':
      return (
        <div className="unreadable">
          <div className="h">
            <IconWarn size={13} /> {RAW_TYPE_NAME[node.rawType]}原文暂不可读 · 客户端未连接
          </div>
          <div className="m">客户端恢复后会重新读取这条原文</div>
        </div>
      )
  }
}

function ItemNode({
  node,
  depth,
  onRaw,
  onMore,
}: {
  node: Extract<EvidenceNode, { kind: 'item' }>
  depth: number
  onRaw: (target: RawTarget) => void
  onMore: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [loaded, setLoaded] = useState<EvidenceNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const children = node.children ?? loaded ?? []

  async function toggle() {
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (node.children || loaded || loading || failed) return
    setLoading(true)
    try {
      const response = await getEvidence(node.ref)
      setLoaded(response.nodes)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const caret = (
    <button
      type="button"
      className={`caret${expanded ? ' open' : ''}`}
      aria-label={expanded ? '收起' : '展开'}
      onClick={toggle}
    >
      <IconChevronDown size={13} />
    </button>
  )

  const versionNote =
    node.latestVersion && node.latestVersion !== node.ref.version ? (
      <span className="ver-note">
        引用 v{node.ref.version} · 最新 v{node.latestVersion}
      </span>
    ) : null

  const kids = expanded ? (
    <>
      {loading ? <Skeleton rows={2} /> : null}
      {failed ? <p className="muted">展开失败</p> : null}
      {children.map((child, index) => (
        <NodeView key={index} node={child} depth={depth + 1} onRaw={onRaw} onMore={onMore} />
      ))}
    </>
  ) : null

  if (depth === 0) {
    const childIsItem = children.some((child) => child.kind === 'item')
    return (
      <div className="node">
        <div className="d">
          {caret}
          <b>{node.when}</b>
          {node.levelName}
          {versionNote}
        </div>
        <div className="s">{node.text}</div>
        {expanded ? (
          childIsItem ? (
            <>{kids}</>
          ) : children.length || loading ? (
            <div className="sub-node">{kids}</div>
          ) : null
        ) : null}
      </div>
    )
  }

  return (
    <div className="sub-node">
      <div className="lab">
        {caret}
        <span>
          {node.when} {node.levelName} · {node.text}
        </span>
        {versionNote}
      </div>
      {kids}
    </div>
  )
}

export function ImContextModal({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi(() => getImContext(id), [id])
  const data = state.data
  return (
    <Modal
      open
      title="原文上下文"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>关闭</Button>
          <Button
            variant="primary"
            disabled={!data}
            onClick={() => {
              const first = data?.messages[0]
              onClose()
              if (first) navigate(`/today/${dayKey(first.time)}`)
            }}
          >
            去时间线
          </Button>
        </>
      }
    >
      {state.loading ? <Skeleton rows={4} /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {data ? (
        <>
          <div className="ctx-session">{data.session}</div>
          <div className="ctx-list">
            {data.messages.map((message) => (
              <div className={`msg${message.isTarget ? ' target' : ''}`} key={message.id}>
                <span className={`av${message.isMine ? ' me' : ''}`}>{message.sender.slice(0, 1)}</span>
                <div className="msg-b">
                  <div className="who">
                    <b>{message.sender}</b>
                    {hhmm(message.time)}
                  </div>
                  <div className="msg-text">{message.text}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Modal>
  )
}

export function MailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi(() => getMailDetail(id), [id])
  const data = state.data
  return (
    <Modal open title="邮件原文" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {state.loading ? <Skeleton rows={4} /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {data ? (
        <div className="detail">
          <h4>{data.subject}</h4>
          <dl className="kv">
            <dt>发件人</dt>
            <dd>{data.from}</dd>
            <dt>收件人</dt>
            <dd>{data.to.join('、')}</dd>
            <dt>抄送</dt>
            <dd>{data.cc.length ? data.cc.join('、') : '—'}</dd>
            <dt>时间</dt>
            <dd>{mdhm(data.time)}</dd>
            <dt>位置</dt>
            <dd>{data.folder}</dd>
          </dl>
          <pre className="detail-text">{data.text}</pre>
        </div>
      ) : null}
    </Modal>
  )
}

export function EventModal({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi(() => getEventDetail(id), [id])
  const data = state.data
  return (
    <Modal open title="日程原文" onClose={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
      {state.loading ? <Skeleton rows={4} /> : null}
      {state.error ? <ErrorState message={state.error} onRetry={state.reload} /> : null}
      {data ? (
        <div className="detail">
          <h4>{data.title}</h4>
          <dl className="kv">
            <dt>时间</dt>
            <dd>
              {mdhm(data.start)} – {hhmm(data.end)}
            </dd>
            <dt>地点</dt>
            <dd>{data.location}</dd>
            <dt>组织者</dt>
            <dd>{data.organizer}</dd>
            <dt>参会人</dt>
            <dd>{data.attendees.map((attendee) => `${attendee.name}（${attendee.response}）`).join('、')}</dd>
          </dl>
          {data.notes ? <p className="detail-note">{data.notes}</p> : null}
        </div>
      ) : null}
    </Modal>
  )
}
