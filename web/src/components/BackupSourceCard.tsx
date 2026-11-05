// 备份页的来源卡（ui.md 5.5 第一行）：状态胶囊、累计数字、保留期、频率、上次 / 下次。
import type { BackupSource, BackupSourceStatus } from '../../../src/api-types'
import { dateStart, num, relTime, sourceUnit } from '../format'
import { todayKey } from '../api'
import { scheduleText } from '../schedule'
import { Button, StatusPill, type PillTone } from './primitives'

const TITLE: Record<BackupSource, string> = { im: 'IM 消息', mail: '邮件', calendar: '日程' }
const UNIT: Record<BackupSource, string> = { im: '天 已备份', mail: '封 已备份', calendar: '场 已备份' }
const SOURCE_CLASS: Record<BackupSource, string> = { im: '', mail: 'mail', calendar: 'cal' }

const STATE: Record<BackupSourceStatus['state'], { text: string; tone: PillTone }> = {
  ok: { text: '正常', tone: 'ok' },
  failed: { text: '失败', tone: 'bad' },
  partial: { text: '部分成功', tone: 'warn' },
  running: { text: '备份中', tone: 'warn' },
  never: { text: '还没备份', tone: 'muted' },
}

function retentionText(days: number): string {
  if (days >= 60 && days % 30 === 0) return `${days / 30} 个月`
  return `${days} 天`
}

export function BackupSourceCard({
  status,
  onRetry,
}: {
  status: BackupSourceStatus
  onRetry: () => void
}) {
  const now = dateStart(todayKey())
  const state = STATE[status.state]
  const unit = sourceUnit(status.source)
  const last = status.lastRun
    ? `${relTime(status.lastRun.at, now)} · ${status.lastRun.result === 'success' ? '成功' : status.lastRun.result} · 新增 ${num(status.lastRun.added)} ${unit}`
    : '—'
  const next = status.nextRunAt ? relTime(status.nextRunAt, now) : '—'

  return (
    <div className="card kpi">
      <div className="k">
        <span className={`src ${SOURCE_CLASS[status.source]}`.trim()} style={{ height: 14, alignSelf: 'center' }} />
        {TITLE[status.source]}
        <StatusPill tone={state.tone} dot={status.state !== 'never'}>
          {state.text}
        </StatusPill>
      </div>
      <div className="big">
        {num(status.total)}
        <small>{UNIT[status.source]}</small>
      </div>
      {status.state === 'failed' ? (
        <div className="kpi-err">
          <span>{last !== '—' ? status.lastRun?.error ?? '备份失败' : '备份失败'}</span>
          <Button onClick={onRetry}>重试</Button>
        </div>
      ) : null}
      {status.state === 'running' ? (
        <div className="kpi-run">
          {status.progress ? `已读取 ${num(status.progress.read)} ${unit}` : '正在读取客户端…'}
        </div>
      ) : null}
      <dl className="kv">
        {status.retentionDays > 0 ? (
          <>
            <dt>客户端保留</dt>
            <dd>{retentionText(status.retentionDays)}</dd>
          </>
        ) : null}
        <dt>频率</dt>
        <dd>{scheduleText(status.rule)}</dd>
        <dt>上次</dt>
        <dd>{last}</dd>
        <dt>下次</dt>
        <dd>{next}</dd>
      </dl>
    </div>
  )
}
