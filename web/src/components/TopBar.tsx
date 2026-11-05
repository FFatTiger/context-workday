// 顶部吸顶栏：品牌、六个标签、IM 备份状态胶囊、演示脱敏开关、搜索框（ui.md 第 3 节）。
import { useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../../../src/api-types'
import { relTime } from '../format'
import { navigate, type PageName, type Route } from '../router'
import { IconSearch } from './icons'
import { StatusPill, Switch } from './primitives'

const TABS: Array<{ name: PageName; label: string; path: string }> = [
  { name: 'today', label: '今天', path: '/today' },
  { name: 'review', label: '回顾', path: '/review' },
  { name: 'search', label: '搜索', path: '/search' },
  { name: 'backup', label: '备份', path: '/backup' },
  { name: 'tasks', label: '任务', path: '/tasks' },
  { name: 'settings', label: '设置', path: '/settings' },
]

export function TopBar({
  route,
  status,
  redact,
  onToggleRedact,
}: {
  route: Route
  status: StatusResponse | null
  redact: boolean
  onToggleRedact: (next: boolean) => void
}) {
  const [keyword, setKeyword] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  function submit() {
    const q = keyword.trim()
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search')
  }

  const im = status?.im
  const imTone = !im ? 'muted' : im.result === 'failed' ? 'bad' : 'ok'
  const imText = !im
    ? 'IM 备份 …'
    : im.result === 'failed'
      ? 'IM 备份失败'
      : im.lastAt === null
        ? 'IM 备份 尚无记录'
        : `IM 备份 ${relTime(im.lastAt, status.now)}`

  return (
    <header className="top">
      <div className="brand">
        <i />
        Context<small>工作日镜</small>
      </div>
      <nav className="tabs">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.name}
            className={route.name === tab.name ? 'on' : ''}
            onClick={() => navigate(tab.path)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="sp" />
      <StatusPill tone={imTone}>{imText}</StatusPill>
      <div className="redact">
        <Switch checked={redact} onChange={onToggleRedact} label="演示脱敏" />
        <span>演示脱敏</span>
      </div>
      <div className="search">
        <IconSearch size={15} />
        <input
          ref={searchRef}
          value={keyword}
          placeholder="搜索…"
          aria-label="搜索原文和摘要"
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit()
          }}
        />
        <kbd>⌘K</kbd>
      </div>
    </header>
  )
}
