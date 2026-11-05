// 开发：后端 tsx watch（--demo，端口 4318），前端 vite（端口 5173，/api 代理到 4318）。
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const procs = [
  spawn('npx', ['tsx', 'watch', 'src/cli.ts', 'start', '--demo', ...args], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit' }),
]
const stop = () => procs.forEach((p) => p.kill())
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
