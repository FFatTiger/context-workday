// 备份页（ui.md 5.5）：来源状态卡、覆盖条、受影响的摘要、备份记录、存储。
import { useState } from 'react'
import type { BackupRun, BackupSource } from '../../../src/api-types'
import {
  getAffected,
  getBackupRuns,
  getBackupStatus,
  getCoverage,
  getStorage,
  runBackup,
  todayKey,
} from '../api'
import { BackupSourceCard } from '../components/BackupSourceCard'
import { CoverageBar } from '../components/CoverageBar'
import { useDrawer } from '../components/Drawer'
import { Button, EmptyState, ErrorState, Segmented, Skeleton } from '../components/primitives'
import { useToast } from '../components/Toast'
import {
  bytes,
  dateStart,
  duration,
  lostReasonText,
  md,
  mdhm,
  num,
  relTime,
  sourceUnit,
} from '../format'
import { errorText, useApi } from '../hooks/useApi'

const SOURCE_TITLE: Record<BackupSource, string> = { im: 'IM 消息', mail: '邮件', calendar: '日程' }
const SOURCE_SHORT: Record<BackupSource, string> = { im: 'IM', mail: '邮件', calendar: '日程' }
const DEFAULT_DAYS: Record<BackupSource, number> = { im: 60, mail: 120, calendar: 60 }

const RESULT_TEXT: Record<BackupRun['result'], { text: string; className: string }> = {
  success: { text: '成功', className: 's-ok' },
  partial: { text: '部分成功', className: 's-warn' },
  failed: { text: '失败', className: 's-bad' },
  running: { text: '运行中', className: 'muted' },
}

export function Backup() {
  const toast = useToast()
  const [source, setSource] = useState<BackupSource>('im')
  const [affectedOpen, setAffectedOpen] = useState(false)
  const [runSource, setRunSource] = useState('')
  const [runResult, setRunResult] = useState('')
  const [runPage, setRunPage] = useState(1)
  const [busy, setBusy] = useState(false)

  const days = DEFAULT_DAYS[source]
  const statuses = useApi(getBackupStatus, [])
  const coverage = useApi(() => getCoverage(source, days), [source, days])
  const runs = useApi(
    () => getBackupRuns({ source: runSource || undefined, result: runResult || undefined, page: runPage }),
    [runSource, runResult, runPage],
  )
  const storage = useApi(getStorage, [])

  const running = busy || (statuses.data ?? []).some((entry) => entry.state === 'running')
  const degraded = coverage.data?.degradedItems ?? 0
  const pages = runs.data ? Math.max(1, Math.ceil(runs.data.total / runs.data.pageSize)) : 1

  async function startBackup() {
    setBusy(true)
    try {
      await runBackup()
      toast('已开始备份')
      statuses.reload()
      coverage.reload()
      runs.reload()
      storage.reload()
    } catch (error) {
      toast(`备份失败：${errorText(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const [amount, unit] = bytes(storage.data?.totalBytes ?? 0).split(' ')
  const integrity = storage.data?.integrity

  return (
    <>
      <div className="dayhead">
        <h1>
          备份<span>原文只存本机 · 证据链的底座</span>
        </h1>
        <div className="meta">
          <Button variant="primary" disabled={running} onClick={() => void startBackup()}>
            {running ? '备份中…' : '立即备份'}
          </Button>
        </div>
      </div>

      {statuses.loading ? (
        <div className="kpis">
          <div className="card kpi">
            <Skeleton rows={3} />
          </div>
          <div className="card kpi">
            <Skeleton rows={3} />
          </div>
          <div className="card kpi">
            <Skeleton rows={3} />
          </div>
        </div>
      ) : statuses.error ? (
        <div className="card kpi">
          <ErrorState message={statuses.error} onRetry={statuses.reload} />
        </div>
      ) : statuses.data?.length ? (
        <div className="kpis">
          {statuses.data.map((status) => (
            <BackupSourceCard
              key={status.source}
              status={status}
              onRetry={() => {
                void startBackup()
              }}
            />
          ))}
        </div>
      ) : (
        <div className="card kpi">
          <EmptyState title="还没有备份记录" note="三个备份任务会在各自的定时时间跑第一次" />
        </div>
      )}

      <div className="card cov">
        <div className="cov-h">
          <h2>备份覆盖</h2>
          <span className="sub">
            {SOURCE_TITLE[source]} · 近 {days} 天
          </span>
          <div className="cov-right">
            <Segmented
              value={source}
              onChange={(next) => setSource(next)}
              options={[
                { value: 'im' as BackupSource, label: 'IM' },
                { value: 'mail' as BackupSource, label: '邮件' },
                { value: 'calendar' as BackupSource, label: '日程' },
              ]}
            />
            <div className="legend">
              <span>
                <i style={{ background: 'var(--ok)' }} />
                已备份
              </span>
              <span>
                <i style={{ background: 'var(--warn)' }} />
                缺口 · 可补救
              </span>
              <span>
                <i style={{ background: 'var(--bad)' }} />
                缺口 · 已过期
              </span>
              <span>
                <i style={{ background: 'var(--line)' }} />
                无数据
              </span>
              <span>
                <i style={{ background: 'var(--line-2)', border: '1px dashed var(--ink-3)' }} />
                等待备份
              </span>
            </div>
          </div>
        </div>
        {coverage.loading ? (
          <div className="cov-skel">
            <Skeleton rows={2} />
          </div>
        ) : coverage.error ? (
          <ErrorState message={coverage.error} onRetry={coverage.reload} />
        ) : coverage.data ? (
          <CoverageBar coverage={coverage.data} />
        ) : null}
        {degraded > 0 ? (
          <>
            <button type="button" className="warnline" onClick={() => setAffectedOpen(!affectedOpen)}>
              ⚠ 缺口影响：{degraded} 条摘要的证据已降级为 AI 当时概述
              <span className="go">{affectedOpen ? '收起 ›' : '查看 ›'}</span>
            </button>
            {affectedOpen ? <AffectedList /> : null}
          </>
        ) : null}
      </div>

      <div className="backup-bottom">
        <div className="card">
          <div className="card-h">
            <h2>备份记录</h2>
            <div className="r filters">
              <select
                value={runSource}
                onChange={(event) => {
                  setRunSource(event.target.value)
                  setRunPage(1)
                }}
              >
                <option value="">全部来源</option>
                <option value="im">IM 消息</option>
                <option value="mail">邮件</option>
                <option value="calendar">日程</option>
              </select>
              <select
                value={runResult}
                onChange={(event) => {
                  setRunResult(event.target.value)
                  setRunPage(1)
                }}
              >
                <option value="">全部结果</option>
                <option value="success">成功</option>
                <option value="partial">部分成功</option>
                <option value="failed">失败</option>
              </select>
            </div>
          </div>
          {runs.loading ? (
            <div className="table-skel">
              <Skeleton rows={4} />
            </div>
          ) : runs.error ? (
            <ErrorState message={runs.error} onRetry={runs.reload} />
          ) : !runs.data?.items.length ? (
            <EmptyState title="还没有备份记录" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>来源</th>
                  <th>结果</th>
                  <th>新增</th>
                  <th>耗时</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.items.map((run) => {
                  const result = RESULT_TEXT[run.result]
                  return (
                    <tr key={run.id}>
                      <td>{mdhm(run.startedAt)}</td>
                      <td>{SOURCE_SHORT[run.source]}</td>
                      <td className={result.className}>
                        {result.text}
                        {run.error ? ` · ${run.error}` : run.note ? ` · ${run.note}` : ''}
                      </td>
                      <td>{run.result === 'failed' ? '—' : `${num(run.added)} ${sourceUnit(run.source)}`}</td>
                      <td>{run.endedAt ? duration(run.endedAt - run.startedAt) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
          <div className="pager">
            <span className="muted">
              共 {runs.data?.total ?? 0} 条 · 第 {runs.data?.page ?? 1} / {pages} 页
            </span>
            <Button disabled={runPage <= 1} onClick={() => setRunPage(runPage - 1)}>
              上一页
            </Button>
            <Button disabled={runPage >= pages} onClick={() => setRunPage(runPage + 1)}>
              下一页
            </Button>
          </div>
        </div>

        <div className="card kpi">
          <div className="k">存储</div>
          {storage.loading ? (
            <Skeleton rows={3} />
          ) : storage.error ? (
            <ErrorState message={storage.error} onRetry={storage.reload} />
          ) : (
            <>
              <div className="big">
                {amount}
                <small>{unit} · 本机</small>
              </div>
              <dl className="kv">
                <dt>原文</dt>
                <dd>{bytes(storage.data?.rawBytes ?? 0)}</dd>
                <dt>摘要与版本</dt>
                <dd>{bytes(storage.data?.summaryBytes ?? 0)}</dd>
                <dt>完整性校验</dt>
                <dd>
                  {integrity ? (
                    <span className={integrity.ok ? 's-ok' : 's-bad'}>
                      {relTime(integrity.at, dateStart(todayKey()))}
                      {integrity.ok ? ' 通过' : ` 失败 · ${integrity.note}`}
                    </span>
                  ) : (
                    <span className="muted">还没校验</span>
                  )}
                </dd>
              </dl>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function AffectedList() {
  const affected = useApi(getAffected, [])
  const drawer = useDrawer()

  if (affected.loading) {
    return (
      <div className="affected-skel">
        <Skeleton rows={3} />
      </div>
    )
  }
  if (affected.error) return <ErrorState message={affected.error} onRetry={affected.reload} />
  if (!affected.data?.items.length) return <EmptyState title="没有受影响的摘要" />

  return (
    <ul className="affected">
      {affected.data.items.map((item) => (
        <li key={`${item.ref.period}-${item.ref.itemId}`}>
          <button type="button" className="aff-main" onClick={() => drawer.open({ ref: item.ref })}>
            <span className="aff-when">{md(dateStart(item.ref.period.slice(0, 10)))}</span>
            <span className="aff-text">{item.text}</span>
            <span className="aff-reason">{lostReasonText(item.reason)}</span>
          </button>
          <span className="aff-use muted">
            {item.usedBy.length} 条上层引用
            {item.usedBy[0] ? ` · ${item.usedBy[0].text}` : ''}
          </span>
        </li>
      ))}
    </ul>
  )
}
