// 备份告警横幅（ui.md 第 3 节）：有告警时显示在顶栏下方，所有页面共用。
import type { StatusResponse } from '../../../src/api-types'
import { navigate } from '../router'
import { IconWarn } from './icons'

export function AlertBanner({ alerts }: { alerts: StatusResponse['alerts'] }) {
  if (!alerts.length) return null
  return (
    <div className="alerts">
      {alerts.map((alert) => (
        <button type="button" className="alert" key={alert.source} onClick={() => navigate('/backup')}>
          <IconWarn size={16} />
          <span>
            {alert.source === 'im' ? 'IM' : '邮件'} 备份失败 · 还剩 {alert.daysLeft} 天可补救
          </span>
          <span className="go">去处理 ›</span>
        </button>
      ))}
    </div>
  )
}
