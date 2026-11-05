// 任务页（ui.md 5.6）：更新链路、24 小时刻度尺、7 个任务行、运行记录。
import { useState } from 'react'
import type { Job, JobName, TaskRun } from '../../../src/api-types'
import { getJobs, getRuns, getStatus, patchJob, runJob, todayKey } from '../api'
import { ScheduleEditor } from '../components/ScheduleEditor'
import { DayRuler, TaskChain } from '../components/TaskChain'
import { useToast } from '../components/Toast'
import { IconPencil } from '../components/icons'
import { Button, EmptyState, ErrorState, Skeleton, Switch } from '../components/primitives'
import { dateStart, duration, md, mdhm, periodName, relTime, runTarget, triggerText } from '../format'
import { errorText, useApi } from '../hooks/useApi'
import { scheduleText } from '../schedule'
import { navigate } from '../router'

const JOB_TITLE: Record<JobName, string> = {
  hourly: '小时摘要',
  daily: '日结',
  catchup: '补跑',
  yearly: '年摘要',
  backup_im: 'IM 备份',
  backup_calendar: '日程备份',
  backup_mail: '邮件备份',
}

const RUN_RESULT: Record<TaskRun['result'], { text: string; dot: string }> = {
  running: { text: '运行中', dot: 'warn' },
  success: { text: '成功', dot: 'ok' },
  skipped: { text: '跳过', dot: 'muted' },
  failed: { text: '失败', dot: 'bad' },
  interrupted: { text: '中断', dot: 'bad' },
}

const RESULT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'success', label: '成功' },
  { value: 'skipped', label: '跳过' },
  { value: 'failed', label: '失败' },
  { value: 'interrupted', label: '中断' },
]

function outputLabel(output: TaskRun['outputs'][number]): string {
  if (output.level === 'hour') return `${md(dateStart(output.period.slice(0, 10)))} ${output.period.slice(11)}:00`
  return periodName(output.level, output.period)
}

export function Tasks() {
  const toast = useToast()
  const [editing, setEditing] = useState<JobName | null>(null)
  const [jobFilter, setJobFilter] = useState('')
  const [resultFilter, setResultFilter] = useState('')
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<number | null>(null)

  const jobs = useApi(getJobs, [])
  const status = useApi(getStatus, [])
  const runs = useApi(
    () => getRuns({ job: jobFilter || undefined, result: resultFilter || undefined, page }),
    [jobFilter, resultFilter, page],
  )

  // 全局状态还没回来时用演示数据的"现在"（20:36）；刻度尺只在任务加载完后渲染
  const now = status.data?.now ?? dateStart(todayKey()) + 20 * 3_600_000 + 36 * 60_000
  const pages = runs.data ? Math.max(1, Math.ceil(runs.data.total / runs.data.pageSize)) : 1
  const jobList = jobs.data ?? []

  async function toggle(job: Job, next: boolean) {
    try {
      await patchJob(job.name, { enabled: next })
      toast(next ? `已启用${job.title}` : `已停用${job.title}`)
      jobs.reload()
    } catch (error) {
      toast(`保存失败：${errorText(error)}`)
    }
  }

  async function start(job: Job) {
    try {
      await runJob(job.name)
      toast(`已开始运行 ${job.title}`)
      jobs.reload()
      runs.reload()
    } catch (error) {
      toast(errorText(error))
    }
  }

  const editingJob = jobList.find((job) => job.name === editing) ?? null

  return (
    <>
      <div className="dayhead">
        <h1>
          任务<span>定时生成摘要与备份 · 时间可调整</span>
        </h1>
      </div>

      <div className="card chain-card">
        <div className="card-h">
          <h2>更新链路</h2>
          <span className="sub">原文 → 小时摘要 → 日结 → 周 / 月 / 年</span>
        </div>
        <div className="chain-body">
          {jobs.loading ? (
            <Skeleton rows={3} />
          ) : jobs.error ? (
            <ErrorState message={jobs.error} onRetry={jobs.reload} />
          ) : jobList.length ? (
            <TaskChain jobs={jobList} />
          ) : (
            <EmptyState title="没有定时任务" />
          )}
        </div>
      </div>

      <div className="card ruler">
        <div className="card-h">
          <h2>一天的节奏</h2>
          <span className="sub">按当前任务配置，每小时第 5 分生成小时摘要</span>
        </div>
        {jobs.loading ? (
          <div className="ruler-skel">
            <Skeleton rows={2} />
          </div>
        ) : jobs.error ? (
          <div className="ruler-skel">
            <ErrorState message={jobs.error} onRetry={jobs.reload} />
          </div>
        ) : jobList.length ? (
          <DayRuler jobs={jobList} now={now} />
        ) : (
          <EmptyState title="没有定时任务" />
        )}
      </div>

      <div className="card jobs">
        <div className="card-h">
          <h2>定时任务</h2>
          <span className="sub">时间可调整</span>
        </div>
        {jobs.loading ? (
          <div className="table-skel">
            <Skeleton rows={6} />
          </div>
        ) : jobs.error ? (
          <ErrorState message={jobs.error} onRetry={jobs.reload} />
        ) : !jobList.length ? (
          <EmptyState title="没有定时任务" />
        ) : (
          <table>
            <thead>
              <tr>
                <th />
                <th>任务</th>
                <th>做什么</th>
                <th>时间</th>
                <th>上次</th>
                <th>下次</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobList.map((job) => {
                const last = job.lastRun
                return (
                  <tr key={job.name} className={job.enabled ? '' : 'off'}>
                    <td>
                      <Switch
                        checked={job.enabled}
                        label={`启用${job.title}`}
                        onChange={(next) => void toggle(job, next)}
                      />
                    </td>
                    <td className="job-title">{job.title}</td>
                    <td className="muted">{job.description}</td>
                    <td className="sched-cell">
                      <div className="sched-wrap">
                        <button type="button" className="sched" onClick={() => setEditing(job.name)}>
                          {scheduleText(job.rule)}
                          <IconPencil size={12} />
                        </button>
                        {editing === job.name && editingJob ? (
                          <ScheduleEditor
                            job={editingJob}
                            onClose={() => setEditing(null)}
                            onSaved={() => {
                              setEditing(null)
                              toast('时间已更新')
                              jobs.reload()
                            }}
                          />
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {last ? (
                        <>
                          <span className={`dot dot-${last.result === 'success' ? 'ok' : last.result === 'skipped' ? 'muted' : 'bad'}`} />
                          {relTime(last.at, now)}
                          <span className={last.result === 'success' ? 's-ok' : 'muted'}>
                            {last.result === 'success' ? ' 成功' : last.result === 'skipped' ? ' 跳过' : ' 失败'}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">
                      {job.enabled ? (job.nextRunAt ? relTime(job.nextRunAt, now) : '—') : '已停用'}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="run"
                        disabled={job.running}
                        onClick={() => void start(job)}
                      >
                        {job.running ? '运行中…' : '立即运行'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <div className="card-h">
          <h2>运行记录</h2>
          <div className="r filters">
            <select
              value={jobFilter}
              onChange={(event) => {
                setJobFilter(event.target.value)
                setPage(1)
              }}
            >
              <option value="">全部任务</option>
              {(Object.keys(JOB_TITLE) as JobName[]).map((name) => (
                <option key={name} value={name}>
                  {JOB_TITLE[name]}
                </option>
              ))}
            </select>
            <select
              value={resultFilter}
              onChange={(event) => {
                setResultFilter(event.target.value)
                setPage(1)
              }}
            >
              <option value="">全部结果</option>
              {RESULT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {runs.loading ? (
          <div className="table-skel">
            <Skeleton rows={5} />
          </div>
        ) : runs.error ? (
          <ErrorState message={runs.error} onRetry={runs.reload} />
        ) : !runs.data?.items.length ? (
          <EmptyState title="还没有运行记录" />
        ) : (
          <ul className="runlist">
            {runs.data.items.map((run) => {
              const result = RUN_RESULT[run.result]
              const open = expanded === run.id
              return (
                <li key={run.id} className={`runrow${open ? ' open' : ''}`}>
                  <button type="button" className="runrow-h" onClick={() => setExpanded(open ? null : run.id)}>
                    <span className={`dot dot-${result.dot}`} />
                    <span className="run-time">{mdhm(run.startedAt)}</span>
                    <span className="run-job">{JOB_TITLE[run.job]}</span>
                    <span className="run-target">{runTarget(run.target)}</span>
                    <span className="run-note muted">{run.note}</span>
                    <span className={`run-result ${result.dot === 'ok' ? 's-ok' : result.dot === 'bad' ? 's-bad' : 'muted'}`}>
                      {result.text}
                    </span>
                  </button>
                  {open ? (
                    <dl className="run-detail">
                      <dt>输入</dt>
                      <dd>{runTarget(run.target)}</dd>
                      <dt>产出</dt>
                      <dd>
                        {run.outputs.length
                          ? run.outputs.map((output) => (
                              <button
                                type="button"
                                key={`${output.level}-${output.period}-${output.version}`}
                                className="link"
                                onClick={() => navigate(`/review/${output.level}/${output.period}`)}
                              >
                                v{output.version} · {outputLabel(output)}
                              </button>
                            ))
                          : '—'}
                      </dd>
                      <dt>触发</dt>
                      <dd>{triggerText(run.trigger)}</dd>
                      <dt>耗时</dt>
                      <dd>{run.endedAt ? duration(run.endedAt - run.startedAt) : '—'}</dd>
                      {run.note ? (
                        <>
                          <dt>{run.result === 'failed' || run.result === 'interrupted' ? '原因' : '说明'}</dt>
                          <dd>{run.note}</dd>
                        </>
                      ) : null}
                    </dl>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        <div className="pager">
          <span className="muted">
            共 {runs.data?.total ?? 0} 条 · 第 {runs.data?.page ?? 1} / {pages} 页
          </span>
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      </div>
    </>
  )
}
