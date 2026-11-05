import { useEffect, useRef, useState } from 'react'
import { getStatus, resolveOpen, saveSettings, todayKey } from './api'
import { AlertBanner } from './components/AlertBanner'
import { DrawerProvider, useDrawer } from './components/Drawer'
import { ToastProvider, useToast } from './components/Toast'
import { TopBar } from './components/TopBar'
import { errorText, useApi } from './hooks/useApi'
import { Backup } from './pages/Backup'
import { Review } from './pages/Review'
import { Search } from './pages/Search'
import { Settings } from './pages/Settings'
import { Tasks } from './pages/Tasks'
import { Today } from './pages/Today'
import { navigate, routeDate, useRoute } from './router'

function Shell() {
  const route = useRoute()
  const toast = useToast()
  const drawer = useDrawer()
  const status = useApi(() => getStatus(), [])
  const [redact, setRedact] = useState(false)
  const deepLinkOpened = useRef(false)

  useEffect(() => {
    if (status.data) setRedact(status.data.redact)
  }, [status.data])

  useEffect(() => {
    if (route.name === 'home' || route.name === 'unknown') navigate('/today', { replace: true })
  }, [route.name])

  // 仅假数据模式：&open=<period>:<itemId> 直接打开证据抽屉，用于截图
  useEffect(() => {
    if (deepLinkOpened.current) return
    const open = route.query.get('open')
    if (!open) return
    const target = resolveOpen(open)
    if (target) {
      deepLinkOpened.current = true
      drawer.open(target)
    }
  }, [route.query, drawer])

  async function toggleRedact(next: boolean) {
    setRedact(next)
    try {
      const saved = await saveSettings({ redact: next })
      setRedact(saved.redact)
      toast(next ? '已开启演示脱敏' : '已关闭演示脱敏')
    } catch (error) {
      setRedact(!next)
      toast(`保存失败：${errorText(error)}`)
    }
  }

  let page = null
  switch (route.name) {
    case 'today':
      page = <Today date={routeDate(route, todayKey())} hlParam={route.query.get('hl')} />
      break
    case 'review':
      page = <Review route={route} />
      break
    case 'search':
      page = <Search route={route} />
      break
    case 'backup':
      page = <Backup />
      break
    case 'tasks':
      page = <Tasks />
      break
    case 'settings':
      page = <Settings redact={redact} onToggleRedact={toggleRedact} />
      break
    default:
      page = null
  }

  return (
    <>
      <TopBar route={route} status={status.data} redact={redact} onToggleRedact={toggleRedact} />
      <AlertBanner alerts={status.data?.alerts ?? []} />
      <main className="page" key={redact ? 'redacted' : 'plain'}>
        {page}
      </main>
    </>
  )
}

export function App() {
  return (
    <ToastProvider>
      <DrawerProvider>
        <Shell />
      </DrawerProvider>
    </ToastProvider>
  )
}
