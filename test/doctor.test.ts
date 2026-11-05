// doctor（票 05 第 3 步）：mock 数据源全过；故意写错字段的假数据源报出对应 ✗。
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/doctor.js'
import { createMockSource } from '../src/source/mock.js'
import type { SourceAdapter } from '../src/source/types.js'
import { fromLocal } from '../src/time.js'

const NOW = fromLocal(2026, 10, 29, 12, 0) // 周四中午：工作日，五种参与形态都有保底注入

function doctorLog() {
  const lines: string[] = []
  return { lines, log: (m: string) => lines.push(m) }
}

describe('doctor', () => {
  it('mock 数据源全部通过（✓，退出码 0），有统计和样例消息', async () => {
    const src = createMockSource({ options: {}, now: () => NOW, log: () => {} })
    const { lines, log } = doctorLog()
    const ok = await runDoctor(src, log, NOW)
    expect(ok).toBe(true)
    const out = lines.join('\n')
    expect(out).toContain('✓ retentionDays')
    expect(out).toContain('✓ me()：陈思远')
    expect(out).toMatch(/✓ messages\(\)：最近 24 小时 \d+ 条/)
    expect(out).toContain('✓ 关联：me().id 在通讯录里')
    expect(out).toContain('参与会话')
    expect(out).toContain('样例消息：')
    expect(lines.filter((l) => l.startsWith('✓')).length).toBeGreaterThan(5)
  })

  it('秒级时间和缺 sessionId 的假数据源报出对应 ✗，退出码 1', async () => {
    const base = createMockSource({ options: {}, now: () => NOW, log: () => {} })
    const bad: SourceAdapter = {
      name: base.name,
      retentionDays: base.retentionDays,
      me: () => base.me(),
      contacts: () => base.contacts(),
      sessions: () => base.sessions(),
      messages: async (range) => {
        const msgs = await base.messages(range)
        // 第一条缺 sessionId，其余时间戳是秒级
        return msgs.map((m, i) => (i === 0 ? { ...m, sessionId: undefined as unknown as string } : { ...m, time: Math.round(m.time / 1000) }))
      },
      events: (range) => base.events(range),
      mails: (range) => base.mails(range),
      findMessage: (id) => base.findMessage!(id),
    }
    const { lines, log } = doctorLog()
    const ok = await runDoctor(bad, log, NOW)
    expect(ok).toBe(false)
    const out = lines.join('\n')
    expect(out).toContain('time 不是毫秒')
    expect(out).toContain('缺 sessionId')
  })

  it('客户端不可用（me() 抛 SourceUnavailableError）记为 ✗', async () => {
    const src = createMockSource({ options: { down: true }, now: () => NOW, log: () => {} })
    const { lines, log } = doctorLog()
    const ok = await runDoctor(src, log, NOW)
    expect(ok).toBe(false)
    expect(lines.join('\n')).toMatch(/✗ (me|contacts|sessions|messages)\(\)/)
  })
})
