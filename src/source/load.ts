import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SourceAdapter, SourceContext, SourceFactory } from './types.js'

/**
 * 按配置加载数据源：'mock' 用内置仿真；否则 import 模块，取默认导出的工厂函数。
 * 相对路径按数据目录解析（约定放在 <数据目录>/source/index.mjs，它自己的 node_modules 装内网 IM 包）。
 */
export async function loadSource(spec: string, ctx: SourceContext, baseDir: string): Promise<SourceAdapter> {
  if (spec === 'mock') {
    const { createMockSource } = await import('./mock.js')
    return createMockSource(ctx)
  }
  const target = spec.startsWith('.') || isAbsolute(spec) ? pathToFileURL(resolve(baseDir, spec)).href : spec
  const mod = (await import(target)) as { default?: SourceFactory }
  if (typeof mod.default !== 'function') throw new Error(`数据源模块 ${spec} 没有默认导出工厂函数`)
  return mod.default(ctx)
}
