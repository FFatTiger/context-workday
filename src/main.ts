import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { loadConfig } from './config.js'
import type { Ctx } from './context.js'
import { openDb } from './db/db.js'
import { createSummarizer } from './llm/index.js'
import { startServer } from './server/app.js'
import { loadSource } from './source/load.js'
import { systemClock } from './time.js'

const HELP = `context-workday — Context · 工作日镜

用法:
  context-workday [start] [--port 4318] [--data 目录] [--source 模块] [--demo]
  context-workday doctor [--data 目录] [--source 模块]   检查数据源模块是否符合合同
  context-workday sim --days 45 [--data 目录] [--force]   用仿真数据快进生成历史（演示用）

数据目录默认 ~/.context-workday，配置文件是其中的 config.json，见 docs/intranet.md。`

export async function main(argv: string[], webDir: URL) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      data: { type: 'string' },
      source: { type: 'string' },
      demo: { type: 'boolean' },
      days: { type: 'string' },
      force: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const cmd = positionals[0] ?? 'start'
  if (values.help || !['start', 'doctor', 'sim'].includes(cmd)) {
    console.log(HELP)
    return
  }
  const config = loadConfig(values)
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`)

  if (cmd === 'sim') {
    // sim 自己组装 Ctx（虚拟时钟要传给 mock 数据源），不走下面的 systemClock 路径
    const { runSim } = await import('./sim.js')
    try {
      await runSim({ config, log, days: Number(values.days ?? 45), force: values.force === true })
    } catch (e) {
      console.error(e instanceof Error ? e.message : e)
      process.exitCode = 1
    }
    return
  }

  const clock = systemClock
  const source = await loadSource(config.source, { options: config.sourceOptions, now: () => clock.now(), log }, config.dataDir)

  if (cmd === 'doctor') {
    const { runDoctor } = await import('./doctor.js')
    process.exitCode = (await runDoctor(source, log, clock.now())) ? 0 : 1
    return
  }

  const ctx: Ctx = {
    db: openDb(join(config.dataDir, 'context.db')),
    clock,
    source,
    summarizer: createSummarizer(config.llm),
    config,
    log,
  }

  const server = await startServer(ctx, existsSync(webDir) ? webDir : null)
  const { startScheduler } = await import('./jobs/scheduler.js')
  const scheduler = startScheduler(ctx)
  log(`Context 已启动：http://${config.host}:${config.port}  数据目录 ${config.dataDir}  数据源 ${source.name}`)
  const stop = async () => {
    scheduler.stop()
    server.close()
    await source.close?.()
    ctx.db.close()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
