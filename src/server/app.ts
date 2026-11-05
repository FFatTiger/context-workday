import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { Ctx } from '../context.js'
import { Redactor } from '../redact.js'
import { getSettings } from '../settings.js'
import { registerBackup } from './routes/backup.js'
import { registerEvidence } from './routes/evidence.js'
import { registerJobs } from './routes/jobs.js'
import { registerSummary } from './routes/summary.js'
import { registerSearch } from './routes/search.js'
import { registerSettings } from './routes/settings.js'
import { registerTimeline } from './routes/timeline.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

/** 各领域的路由在 routes/ 下各自注册：export function register(api: Hono, ctx: Ctx) */
export function createApp(ctx: Ctx, webDir: URL | null) {
  const app = new Hono()
  const api = new Hono()
  // 演示脱敏：settings.redact 开启时在 API 出口统一替换人名、群名、金额、邮箱（spec 第 11 节，前端不做脱敏）
  api.use('*', async (c, next) => {
    await next()
    if (!getSettings(ctx.db).redact) return
    const res = c.res
    if (!(res.headers.get('content-type') ?? '').includes('application/json')) return
    try {
      const data = await res.json()
      c.res = new Response(JSON.stringify(new Redactor(ctx.db).json(data)), { status: res.status, headers: { 'content-type': 'application/json; charset=utf-8' } })
    } catch {
      // 响应体不是合法 JSON（如流）就不动它
    }
  })
  api.get('/health', (c) => c.json({ ok: true, now: ctx.clock.now() }))
  registerBackup(api, ctx)
  registerTimeline(api, ctx)
  registerEvidence(api, ctx)
  registerSummary(api, ctx)
  registerJobs(api, ctx)
  registerSearch(api, ctx)
  registerSettings(api, ctx)
  api.onError((err, c) => {
    ctx.log(`API 错误 ${c.req.path}: ${err.stack ?? err}`)
    return c.json({ error: err.message }, 500)
  })
  app.route('/api', api)

  if (webDir) {
    // 单页应用：有文件就给文件，否则回落到 index.html
    app.get('*', async (c) => {
      const path = c.req.path === '/' ? '/index.html' : c.req.path
      const root = fileURLToPath(webDir)
      const file = fileURLToPath(new URL('.' + path, webDir))
      try {
        if (!file.startsWith(root)) throw new Error('outside web dir')
        return c.body(await readFile(file), 200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
      } catch {
        return c.html(await readFile(fileURLToPath(new URL('./index.html', webDir)), 'utf8'))
      }
    })
  }
  return app
}

export async function startServer(ctx: Ctx, webDir: URL | null) {
  const app = createApp(ctx, webDir)
  return serve({ fetch: app.fetch, port: ctx.config.port, hostname: ctx.config.host })
}
