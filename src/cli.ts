#!/usr/bin/env node
// 入口：先屏蔽 node:sqlite 的 ExperimentalWarning，再加载主程序。
process.removeAllListeners('warning')
process.on('warning', (w) => {
  if (w.name !== 'ExperimentalWarning') console.warn(w)
})
const { main } = await import('./main.js')
await main(process.argv.slice(2), new URL('./web/', import.meta.url))
// web 目录入口自己算（打包后 cli.mjs 和 web/ 同在 dist/ 下）；
// main.js 会被拆进 dist/chunks/，在那里算 import.meta.url 会指向 chunks/web/（404），所以由这里传进去。
