// 定时任务接口（api-types 第 10–12 节）：任务列表、修改配置、立即运行、运行记录。
// Job.running / lastRun 从 task_runs 算；每次执行（调度、启动补跑、手动）都有一条任务级记录。
import type { Job, JobName, Page, ScheduleRule, TaskRun } from '../../api-types.js'
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { JOB_DEFS_BY_NAME, getJobRunner } from '../../jobs/registry.js'
import { ensureJobs, getJob, isJobName, listJobs, saveJob, validateRule, type JobRow } from '../../jobs/rules.js'
import { toTaskRun } from '../../summary/rollup.js'
import { failureText } from '../errors.js'

function jobView(ctx: Ctx, row: JobRow): Job {
  const def = JOB_DEFS_BY_NAME[row.name]
  const running = ctx.db.prepare("SELECT 1 FROM task_runs WHERE job = ? AND result = 'running' LIMIT 1").get(row.name) !== undefined
  const last = ctx.db.prepare('SELECT started_at, result FROM task_runs WHERE job = ? AND result != ? ORDER BY id DESC LIMIT 1').get(row.name, 'running') as
    | { started_at: number; result: TaskRun['result'] }
    | undefined
  const out: Job = {
    name: row.name,
    title: def.title,
    description: def.description,
    enabled: row.enabled,
    rule: row.rule,
    running,
    nextRunAt: row.nextRunAt,
  }
  if (last) out.lastRun = { at: last.started_at, result: last.result }
  return out
}

export function registerJobs(api: Hono, ctx: Ctx) {
  // ── 10. 任务列表 ──
  api.get('/jobs', (c) => {
    ensureJobs(ctx.db, ctx.clock.now())
    return c.json(listJobs(ctx.db).map((j) => jobView(ctx, j)))
  })

  // ── 10. 修改配置：校验时间规则和允许范围，保存后重算下次运行 ──
  api.patch('/jobs/:name', async (c) => {
    const name = c.req.param('name')
    if (!isJobName(name)) return c.json({ error: `未知任务 ${name}` }, 404)
    ensureJobs(ctx.db, ctx.clock.now())
    let body: { enabled?: unknown; rule?: unknown }
    try {
      body = (await c.req.json()) as { enabled?: unknown; rule?: unknown }
    } catch {
      return c.json({ error: '请求体应为 JSON' }, 400)
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return c.json({ error: 'enabled 应为布尔值' }, 400)
    let rule: ScheduleRule | undefined
    if (body.rule !== undefined) {
      try {
        rule = validateRule(name, body.rule)
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
      }
    }
    const saved = saveJob(ctx.db, name, { enabled: body.enabled as boolean | undefined, rule }, ctx.clock.now())
    return c.json(jobView(ctx, saved))
  })

  // ── 11. 立即运行：同一个任务正在运行时 409 ──
  api.post('/jobs/:name/run', async (c) => {
    const name = c.req.param('name') as JobName
    if (!isJobName(name)) return c.json({ error: `未知任务 ${name}` }, 404)
    ensureJobs(ctx.db, ctx.clock.now())
    const runner = getJobRunner(ctx)
    const runningRow = ctx.db.prepare("SELECT 1 FROM task_runs WHERE job = ? AND result = 'running' LIMIT 1").get(name) !== undefined
    if (runner.isRunning(name) || runningRow) return c.json({ error: '任务正在运行' }, 409)
    const run = await runner.run(name, 'manual')
    if (!run) return c.json({ error: '任务正在运行' }, 409)
    return c.json({ runId: run.id })
  })

  // ── 12. 运行记录：按任务和结果筛选，分页 50 ──
  api.get('/runs', (c) => {
    const job = c.req.query('job')
    const result = c.req.query('result')
    const page = Math.max(1, Number(c.req.query('page') ?? 1))
    const pageSize = 50
    const where: string[] = []
    const args: Array<string | number> = []
    if (job) {
      where.push('job = ?')
      args.push(job)
    }
    if (result) {
      where.push('result = ?')
      args.push(result)
    }
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM task_runs ${cond}`).get(...args) as { n: number }).n
    const rows = ctx.db.prepare(`SELECT * FROM task_runs ${cond} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as unknown as Array<Record<string, unknown>>
    const out: Page<TaskRun> = { items: rows.map(toTaskRun), total, page, pageSize }
    // 失败记录的原因按界面文案展示（“客户端不可用，稍后会自动重试”），与时间线上的失败卡一致
    for (const run of out.items) {
      if (run.result === 'failed' || run.result === 'interrupted') run.note = failureText(run.note)
    }
    return c.json(out)
  })
}
