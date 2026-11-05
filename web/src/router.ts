// 几十行的 History API 小路由。路径约定见票 06：
// /today/:date?、/review/:level?/:period?、/search?q=、/backup、/tasks、/settings，/ 跳 /today。
import { useSyncExternalStore } from 'react'

const PAGES = ['today', 'review', 'search', 'backup', 'tasks', 'settings'] as const
export type PageName = (typeof PAGES)[number]

export interface Route {
  name: PageName | 'home' | 'unknown'
  segments: string[]
  query: URLSearchParams
}

function parse(): Route {
  const segments = location.pathname.split('/').filter(Boolean)
  const head = segments[0] ?? ''
  const name: Route['name'] =
    head === '' ? 'home' : (PAGES as readonly string[]).includes(head) ? (head as PageName) : 'unknown'
  return { name, segments, query: new URLSearchParams(location.search) }
}

let snapshot = parse()
const listeners = new Set<() => void>()

function refresh() {
  snapshot = parse()
  for (const listener of listeners) listener()
}

window.addEventListener('popstate', refresh)

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, '', to)
  else history.pushState(null, '', to)
  refresh()
  window.scrollTo(0, 0)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => snapshot)
}

/** 从路由里取 /today/:date 的日期 */
export function routeDate(route: Route, fallback: string): string {
  const value = route.segments[1]
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback
}
