// 搜索页（ui.md 5.4）：大搜索框、时间与来源筛选、结果列表、加载更多。
// 筛选都写进 URL，刷新可恢复；关键词只在回车时进 URL。
import { useEffect, useState, type ReactNode } from 'react'
import type { SearchHit } from '../../../src/api-types'
import { search, type SearchRange, type SearchSource } from '../api'
import { EventModal, ImContextModal, MailModal } from '../components/Drawer'
import { IconCalendar, IconChat, IconDoc, IconMail, IconSearch } from '../components/icons'
import { Button, EmptyState, ErrorState, Segmented, Skeleton, Switch } from '../components/primitives'
import { mdhm, num } from '../format'
import { useApi } from '../hooks/useApi'
import { navigate, type Route } from '../router'

const RANGES: Array<{ value: SearchRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
]

const SOURCES: Array<{ value: SearchSource; label: string }> = [
  { value: 'summary', label: '摘要' },
  { value: 'im', label: 'IM' },
  { value: 'mail', label: '邮件' },
  { value: 'event', label: '日程' },
]

const ALL_SOURCES = SOURCES.map((source) => source.value)
const RECENT_KEY = 'context.recentSearches'

const ICON: Record<SearchHit['type'], ReactNode> = {
  summary: <IconDoc size={16} />,
  im: <IconChat size={16} />,
  mail: <IconMail size={16} />,
  event: <IconCalendar size={16} />,
}

function parseRange(value: string | null): SearchRange {
  return RANGES.some((range) => range.value === value) ? (value as SearchRange) : 'all'
}

function parseSources(value: string | null): SearchSource[] {
  if (!value) return [...ALL_SOURCES]
  const picked = value
    .split(',')
    .filter((entry): entry is SearchSource => ALL_SOURCES.includes(entry as SearchSource))
  return picked.length ? picked : [...ALL_SOURCES]
}

function searchUrl(next: { q: string; range: SearchRange; sources: SearchSource[]; mine: boolean }): string {
  const params = new URLSearchParams()
  if (next.q) params.set('q', next.q)
  if (next.range !== 'all') params.set('range', next.range)
  if (next.sources.length !== ALL_SOURCES.length) params.set('sources', next.sources.join(','))
  if (!next.mine) params.set('mine', '0')
  const query = params.toString()
  return `/search${query ? `?${query}` : ''}`
}

function recentSearches(): string[] {
  const stored = localStorage.getItem(RECENT_KEY)
  const parsed: unknown = stored ? JSON.parse(stored) : []
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === 'string').slice(0, 5)
}

function rememberSearch(term: string) {
  const list = [term, ...recentSearches().filter((entry) => entry !== term)].slice(0, 5)
  localStorage.setItem(RECENT_KEY, JSON.stringify(list))
}

export function Search({ route }: { route: Route }) {
  const q = (route.query.get('q') ?? '').trim()
  const range = parseRange(route.query.get('range'))
  const sources = parseSources(route.query.get('sources'))
  const mine = route.query.get('mine') !== '0'

  const [keyword, setKeyword] = useState(route.query.get('q') ?? '')
  const [extra, setExtra] = useState<{ key: string; items: SearchHit[] }>({ key: '', items: [] })
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [raw, setRaw] = useState<{ kind: 'im' | 'mail' | 'event'; id: string } | null>(null)

  const key = q ? JSON.stringify({ q, range, sources, mine }) : ''
  const first = useApi(
    () => (q ? search({ q, range, sources, mine, page: 1 }) : Promise.resolve(null)),
    [key],
  )

  useEffect(() => {
    setKeyword(route.query.get('q') ?? '')
  }, [route.query])

  const data = first.data
  const loaded = extra.key === key ? extra.items : []
  const items = [...(data?.items ?? []), ...loaded]
  const total = data?.total ?? 0
  const hasMore = data !== null && items.length < total

  function submit(value: string) {
    const next = value.trim()
    if (next) rememberSearch(next)
    navigate(searchUrl({ q: next, range, sources, mine }))
  }

  function changeRange(next: SearchRange) {
    navigate(searchUrl({ q, range: next, sources, mine }), { replace: true })
  }

  function toggleSource(next: SearchSource) {
    const picked = new Set(sources)
    if (picked.has(next)) {
      if (picked.size === 1) return
      picked.delete(next)
    } else {
      picked.add(next)
    }
    navigate(searchUrl({ q, range, sources: ALL_SOURCES.filter((source) => picked.has(source)), mine }), {
      replace: true,
    })
  }

  function changeMine(next: boolean) {
    navigate(searchUrl({ q, range, sources, mine: next }), { replace: true })
  }

  function open(hit: SearchHit) {
    const target = hit.target
    if (target.kind === 'item') {
      const ref = target.ref
      if (ref.level === 'hour' || ref.level === 'day') {
        navigate(`/today/${ref.period.slice(0, 10)}?hl=${ref.period}:${ref.itemId}`)
      } else {
        navigate(`/review/${ref.level}/${ref.period}?item=${ref.itemId}`)
      }
      return
    }
    setRaw({ kind: target.kind, id: target.id })
  }

  async function loadMore() {
    if (!data || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = Math.floor(items.length / data.pageSize) + 1
      const response = await search({ q, range, sources, mine, page })
      setExtra({ key, items: [...loaded, ...response.items] })
    } catch (error) {
      setMoreError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <>
      <div className="dayhead">
        <h1>
          搜索<span>摘要和已备份的原文</span>
        </h1>
      </div>

      <div className="card bigsearch">
        <IconSearch size={18} />
        <input
          autoFocus
          value={keyword}
          placeholder="搜索关键词，多个词用空格分开"
          aria-label="搜索关键词"
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit(keyword)
          }}
        />
        <Button variant="primary" onClick={() => submit(keyword)}>
          搜索
        </Button>
      </div>

      <div className="filterrow">
        <Segmented options={RANGES} value={range} onChange={changeRange} />
        <div className="srcpills">
          {SOURCES.map((source) => (
            <button
              key={source.value}
              type="button"
              className={`srcpill${sources.includes(source.value) ? ' on' : ''}`}
              aria-pressed={sources.includes(source.value)}
              onClick={() => toggleSource(source.value)}
            >
              {source.label}
            </button>
          ))}
        </div>
        <div className="mine">
          <Switch checked={mine} onChange={changeMine} label="只看与我有关" />
          <span>只看与我有关</span>
        </div>
      </div>

      {!q ? (
        <IdleSearch onPick={submit} />
      ) : first.loading ? (
        <div className="card hits">
          <div className="hits-skel">
            <Skeleton rows={6} />
          </div>
        </div>
      ) : first.error ? (
        <div className="card hits">
          <ErrorState message={first.error} onRetry={first.reload} />
        </div>
      ) : (
        <div className="card hits">
          <div className="hits-meta">共 {num(total)} 条</div>
          {items.length === 0 ? (
            <EmptyState title={`没有找到「${q}」`} note={data?.hint ?? '今天的原文会在下次 IM 备份后可搜'} />
          ) : (
            <>
              <ul className="hitlist">
                {items.map((hit, index) => (
                  <li key={`${hit.type}-${index}`}>
                    <button type="button" className={`hit ${hit.type}`} onClick={() => open(hit)}>
                      <span className="hit-ic">{ICON[hit.type]}</span>
                      <span className="hit-main">
                        <span className="hit-src">{hit.source}</span>
                        <span className="hit-snip">
                          <Snippet text={hit.snippet} highlights={hit.highlights} />
                        </span>
                      </span>
                      <span className="hit-time">{mdhm(hit.time)}</span>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore || moreError ? (
                <div className="hits-more">
                  {moreError ? <span className="s-bad">加载更多失败 · {moreError}</span> : null}
                  <Button disabled={loadingMore} onClick={() => void loadMore()}>
                    {loadingMore ? '加载中…' : '加载更多'}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      )}

      {raw?.kind === 'im' ? <ImContextModal id={raw.id} onClose={() => setRaw(null)} /> : null}
      {raw?.kind === 'mail' ? <MailModal id={raw.id} onClose={() => setRaw(null)} /> : null}
      {raw?.kind === 'event' ? <EventModal id={raw.id} onClose={() => setRaw(null)} /> : null}
    </>
  )
}

function IdleSearch({ onPick }: { onPick: (term: string) => void }) {
  const recent = recentSearches()
  return (
    <div className="card hits idle">
      <p>输入关键词，搜索所有摘要条目和本机备份的原文。多个词用空格分开，按“与”组合。</p>
      <p className="muted">时间按上海时区分段；打开“只看与我有关”时，原文只返回与我有关的消息、我参加的日程和我收发的邮件。</p>
      {recent.length ? (
        <div className="recent">
          <span className="muted">最近搜索</span>
          {recent.map((term) => (
            <button key={term} type="button" className="srcpill" onClick={() => onPick(term)}>
              {term}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Snippet({ text, highlights }: { text: string; highlights: Array<[number, number]> }) {
  const parts: ReactNode[] = []
  let cursor = 0
  highlights.forEach(([start, end], index) => {
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(<mark key={`${start}-${index}`}>{text.slice(start, end)}</mark>)
    cursor = end
  })
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
