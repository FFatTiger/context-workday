// 设置接口（api-types 20）：GET/PUT /api/settings、POST /api/settings/test-model。
// 模型名称和地址读仓库现有配置（ctx.summarizer / ctx.config.llm），不在这里另建编辑入口。
import type { SettingsResponse } from '../../api-types.js'
import type { Ctx } from '../../context.js'
import type { Hono } from 'hono'
import { getMeta } from '../../db/db.js'
import type { Contact } from '../../source/types.js'
import { getSettings, saveSettings } from '../../settings.js'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

/** 数据去向（spec 第 11 节）：mock → 演示模型；本机地址 → 仅本机；其他 → 发送到 <主机名> */
function modelInfo(ctx: Ctx): SettingsResponse['model'] {
  if (ctx.config.llm === 'mock') return { name: ctx.summarizer.model, endpoint: null, destination: '演示模型（不联网）' }
  const endpoint = ctx.summarizer.endpoint
  let host = endpoint ?? ''
  try {
    host = new URL(endpoint ?? '').hostname
  } catch {
    // 地址不是合法 URL 时按原样显示
  }
  return { name: ctx.summarizer.model, endpoint, destination: LOCAL_HOSTS.has(host) ? '仅本机' : `发送到 ${host}` }
}

async function settingsResponse(ctx: Ctx): Promise<SettingsResponse> {
  const s = getSettings(ctx.db)
  // 优先用备份时存的 me；没备份过才问客户端，客户端不可用也不影响设置页打开
  let meName = ''
  const stored = getMeta<Contact>(ctx.db, 'me')
  if (stored) meName = stored.name
  else {
    try {
      meName = (await ctx.source.me()).name
    } catch {
      // 客户端没开：名字留空，设置页其余部分照常
    }
  }
  return { ...s, model: modelInfo(ctx), source: { name: ctx.source.name }, me: { name: meName }, dataDir: ctx.config.dataDir }
}

export function registerSettings(api: Hono, ctx: Ctx) {
  api.get('/settings', async (c) => c.json(await settingsResponse(ctx)))

  api.put('/settings', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: '请求体应为 JSON' }, 400)
    }
    try {
      saveSettings(ctx.db, body)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400)
    }
    return c.json(await settingsResponse(ctx))
  })

  api.post('/settings/test-model', async (c) => {
    try {
      return c.json(await ctx.summarizer.ping())
    } catch (e) {
      return c.json({ ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) })
    }
  })
}
