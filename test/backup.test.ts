import { describe, expect, it } from 'vitest'
import { alerts, coverage } from '../src/backup/coverage.js'
import { getWatermark, needsRetry, runBackup } from '../src/backup/run.js'
import { DAY_MS, fromLocal, startOfDay } from '../src/time.js'
import { makeCtx } from './helpers.js'

const day = (y: number, mo: number, d: number, h = 0, mi = 0) => fromLocal(y, mo, d, h, mi)
const row = (db: ReturnType<typeof makeCtx>['db'], sql: string, ...args: Array<string | number>) =>
  db.prepare(sql).get(...args) as Record<string, unknown>

describe('备份：失败与补齐（spec 测试 10）', () => {
  it('客户端不可用时失败、水位不动；恢复后一次补齐；重复运行不重复写入', async () => {
    const t = makeCtx({ now: day(2026, 10, 29, 12, 0) })
    t.source.addSession('g1', '群 1')
    t.source.addSession('g2', '群 2')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 28, 9, 0) })
    t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 10, 0) })
    t.source.addMsg({ id: 'm3', sessionId: 'g1', senderId: 'u_a', replyToId: 'm2', time: day(2026, 10, 29, 10, 30) })
    t.source.addMsg({ id: 'm4', sessionId: 'g2', senderId: 'u_a', time: day(2026, 10, 29, 11, 0) })

    t.source.down = true
    const failed = await runBackup(t.ctx, 'im', 'scheduled')
    expect(failed.result).toBe('failed')
    expect(failed.error).toBeTruthy()
    expect(getWatermark(t.db, 'im')).toBeUndefined()
    expect(needsRetry(t.db, 'im')).toBe(true)

    t.source.down = false
    const ok = await runBackup(t.ctx, 'im', 'retry')
    expect(ok.result).toBe('success')
    expect(ok.added).toBe(4)
    expect(getWatermark(t.db, 'im')).toBe(day(2026, 10, 29, 12, 0))
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM im_messages').n).toBe(4)
    // IM 备份同时同步 sessions 和 contacts
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM sessions').n).toBe(2)
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM contacts').n).toBe(1)
    expect(needsRetry(t.db, 'im')).toBe(false)

    const again = await runBackup(t.ctx, 'im', 'scheduled')
    expect(again.result).toBe('success')
    expect(again.added).toBe(0)
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM im_messages').n).toBe(4)
  })
})

describe('备份：核对不一致（spec 测试 10）', () => {
  it('本机条数 < 客户端条数记为部分成功，水位停在不一致那天 0 点；重试后补齐', async () => {
    const t = makeCtx({ now: day(2026, 10, 26, 12, 0) })
    t.source.addSession('g1', '群 1')
    const m1 = t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 24, 10, 0) })
    const m2 = t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 25, 11, 0) })
    const m3 = t.source.addMsg({ id: 'm3', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 26, 9, 0) })
    const mX = t.source.addMsg({ id: 'mX', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 26, 9, 30) }) // 备份运行途中"新到"的消息

    // 第一次读取看不到 mX；逐日核对时客户端里有 → 10/26 不一致
    t.source.messagesImpl = (call, range) => {
      if (call === 0) return [m1, m2, m3]
      if (range.from === startOfDay(mX.time)) return [m3, mX]
      return t.source.msgs
    }
    const partial = await runBackup(t.ctx, 'im', 'scheduled')
    expect(partial.result).toBe('partial')
    expect(partial.note).toContain('10/26')
    expect(getWatermark(t.db, 'im')).toBe(startOfDay(mX.time))
    expect(needsRetry(t.db, 'im')).toBe(true)

    // 覆盖：不一致那天是可补救缺口，更早的核对过为 ok，安装前无数据
    const cov = coverage(t.ctx, 'im', 30)
    const byDay = new Map(cov.days.map((d) => [d.day, d]))
    expect(byDay.get('2026-10-26')?.state).toBe('gap_recoverable')
    expect(byDay.get('2026-10-26')?.clientCount).toBe(2)
    expect(byDay.get('2026-10-26')?.localCount).toBe(1)
    expect(byDay.get('2026-10-25')?.state).toBe('ok')
    expect(byDay.get('2026-10-15')?.state).toBe('no_data')
    expect(cov.unbackedInWindow).toBe(1)
    expect(cov.degradedItems).toBe(0)

    // 告警：最早缺口 10/26，距离超过 7 天还剩 ceil(6.5) = 7 天
    expect(alerts(t.ctx)).toEqual([{ source: 'im', daysLeft: 7 }])

    // 重试：从水位（10/26 0 点）重读，把 mX 补上，全部一致
    t.source.messagesImpl = null
    const retry = await runBackup(t.ctx, 'im', 'retry')
    expect(retry.result).toBe('success')
    expect(retry.added).toBe(1)
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM im_messages').n).toBe(4)
    const cov2 = coverage(t.ctx, 'im', 30)
    expect(cov2.days.find((d) => d.day === '2026-10-26')?.state).toBe('ok')
    expect(alerts(t.ctx)).toEqual([])
    expect(needsRetry(t.db, 'im')).toBe(false)
  })

  it('缺口超过保留期后变成已过期；告警天数随时间递减', async () => {
    const t = makeCtx({ now: day(2026, 10, 29, 12, 0) })
    t.source.addSession('g1', '群 1')
    const mA = t.source.addMsg({ id: 'mA', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 27, 10, 0) })
    const mB = t.source.addMsg({ id: 'mB', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 0) })
    const mX = t.source.addMsg({ id: 'mX2', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 27, 11, 0) })
    t.source.messagesImpl = (call, range) => {
      if (call === 0) return [mA, mB]
      if (range.from === startOfDay(mX.time)) return [mA, mX]
      return t.source.msgs
    }
    const partial = await runBackup(t.ctx, 'im', 'manual')
    expect(partial.result).toBe('partial')
    // 最早缺口 10/27，deadline = 10/27 + 7 天 = 11/3 0 点，剩 ceil(4.5) = 5 天
    expect(alerts(t.ctx)).toEqual([{ source: 'im', daysLeft: 5 }])

    // 快进到 11/4：10/27 的数据已全部离开客户端保留期 → 已过期
    t.clock.set(day(2026, 11, 4, 12, 0))
    const cov = coverage(t.ctx, 'im', 20)
    expect(cov.days.find((d) => d.day === '2026-10-27')?.state).toBe('gap_expired')
    // 更晚的未备份日成为新的可补救缺口：10/29 只核对过当天 12 点前，它的 10/30 02:00
    // 备份一直没跑成，过时后也算缺口（票 11），所以最早可补救缺口是 10/29，还剩 ceil(0.5)=1 天
    const a = alerts(t.ctx)
    expect(a).toEqual([{ source: 'im', daysLeft: 1 }])
  })
})

describe('覆盖：备份计划时间之前不算缺口（票 11）', () => {
  it('00:30 时昨天和今天都是 pending、无告警；02:00 备份失败后昨天变可补救缺口并告警，今天仍是 pending', async () => {
    const t = makeCtx({ now: day(2026, 10, 28, 12, 0) })
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 28, 9, 0) })
    await runBackup(t.ctx, 'im', 'scheduled') // 安装 + 留下只覆盖到 10/28 12 点的核对记录

    t.clock.set(day(2026, 10, 29, 0, 30))
    const cov = coverage(t.ctx, 'im', 10)
    const byDay = new Map(cov.days.map((d) => [d.day, d]))
    expect(cov.rule).toEqual({ type: 'daily', hour: 2, minute: 0 })
    expect(byDay.get('2026-10-29')?.state).toBe('pending') // 今天还没到 02:00
    expect(byDay.get('2026-10-28')?.state).toBe('pending') // 昨天只核对到 12 点，等 02:00 的整天核对
    expect(byDay.get('2026-10-27')?.state).toBe('ok') // 那次运行覆盖了 10/27 整天
    expect(cov.unbackedInWindow).toBe(0)
    expect(alerts(t.ctx)).toEqual([])

    // 邮件周日 03:00 才备份：周三的 10/28 也在等它的计划时间，不告警
    const mailCov = coverage(t.ctx, 'mail', 10)
    expect(mailCov.rule).toEqual({ type: 'weekly', weekday: 7, hour: 3, minute: 0 })
    expect(mailCov.days.find((d) => d.day === '2026-10-28')?.state).toBe('pending')

    // 02:00 那次备份失败（客户端不可用）：02:30 时昨天变成可补救缺口、告警出现
    t.source.down = true
    t.clock.set(day(2026, 10, 29, 2, 30))
    const failed = await runBackup(t.ctx, 'im', 'scheduled')
    expect(failed.result).toBe('failed')
    const cov2 = coverage(t.ctx, 'im', 10)
    const byDay2 = new Map(cov2.days.map((d) => [d.day, d]))
    expect(byDay2.get('2026-10-28')?.state).toBe('gap_recoverable')
    expect(byDay2.get('2026-10-29')?.state).toBe('pending') // 今天始终等到自己的备份时间
    expect(cov2.unbackedInWindow).toBe(1)
    // 最早缺口 10/28，deadline = 11/4 0 点，剩 ceil(5.89) = 6 天
    expect(alerts(t.ctx)).toEqual([{ source: 'im', daysLeft: 6 }])
  })

  it('备份成功后 pending 变 ok：当天备份过且一致就算 ok，次日 02:00 整天核对后仍是 ok', async () => {
    const t = makeCtx({ now: day(2026, 10, 29, 0, 30) })
    t.source.addSession('g1', '群 1')
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 0, 10) })
    await runBackup(t.ctx, 'im', 'scheduled') // 00:30 手动/重试成功，覆盖 10/29 00:00–00:30
    const cov = coverage(t.ctx, 'im', 3)
    expect(cov.days.find((d) => d.day === '2026-10-29')?.state).toBe('ok') // 今天：核对一致就算 ok

    t.clock.set(day(2026, 10, 30, 2, 1))
    await runBackup(t.ctx, 'im', 'scheduled') // 次日 02:00 的整天核对
    const cov2 = coverage(t.ctx, 'im', 3)
    expect(cov2.days.find((d) => d.day === '2026-10-29')?.state).toBe('ok')
    expect(cov2.days.find((d) => d.day === '2026-10-30')?.state).toBe('ok')
    expect(alerts(t.ctx)).toEqual([])
  })
})

describe('备份：related_to_me 按会话 × 小时', () => {
  it('跨水位边界的小时，用本机已有消息一起重新判定', async () => {
    const t = makeCtx({ now: day(2026, 10, 29, 9, 30) })
    t.source.addSession('g1', '群 1')
    t.source.addSession('g2', '群 2')
    // 9 点整：只有别人的消息 → 这个小时不参与
    t.source.addMsg({ id: 'm1', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 9, 0) })
    const r1 = await runBackup(t.ctx, 'im', 'scheduled')
    expect(r1.result).toBe('success')
    expect(row(t.db, 'SELECT related_to_me AS r FROM im_messages WHERE id = ?', 'm1').r).toBe(0)

    // 我 9:45 补了一条话（晚到消息），10 点又有别人的消息
    t.clock.set(day(2026, 10, 29, 10, 30))
    t.source.addMsg({ id: 'm2', sessionId: 'g1', senderId: 'u_me', time: day(2026, 10, 29, 9, 45) })
    t.source.addMsg({ id: 'm3', sessionId: 'g1', senderId: 'u_a', time: day(2026, 10, 29, 10, 0) })
    t.source.addMsg({ id: 'm4', sessionId: 'g2', senderId: 'u_a', time: day(2026, 10, 29, 10, 15) })
    const r2 = await runBackup(t.ctx, 'im', 'scheduled')
    expect(r2.result).toBe('success')

    const rel = (id: string) => row(t.db, 'SELECT related_to_me AS r FROM im_messages WHERE id = ?', id).r
    expect(rel('m1')).toBe(1) // 同会话同小时整体重算：我 9:45 开口 → m1 也算
    expect(rel('m2')).toBe(1)
    expect(rel('m3')).toBe(0) // 10 点这个小时 g1 里我没有参与
    expect(rel('m4')).toBe(0) // g2 这个小时我也没有参与
  })
})

describe('备份：邮件与日程', () => {
  it('邮件按口径算 related；抄送不算', async () => {
    const t = makeCtx({ now: day(2026, 10, 29, 12, 0) })
    const mk = (id: string, over: Partial<(typeof t.source.mailsList)[number]>) => {
      const m = {
        id,
        subject: '主题',
        from: { name: 'a', address: 'a@corp.com' },
        to: [] as Array<{ name: string; address: string }>,
        cc: [] as Array<{ name: string; address: string }>,
        time: day(2026, 10, 28, 10, 0),
        text: '正文',
        folder: 'inbox',
        ...over,
      }
      t.source.mailsList.push(m)
      return m
    }
    mk('mail_sent', { from: { name: '我', address: 'me@corp.com' }, to: [{ name: 'a', address: 'a@corp.com' }], folder: 'sent' })
    mk('mail_to', { to: [{ name: '我', address: 'me@corp.com' }] })
    mk('mail_cc', { cc: [{ name: '我', address: 'me@corp.com' }] })

    const run = await runBackup(t.ctx, 'mail', 'scheduled')
    expect(run.result).toBe('success')
    expect(run.added).toBe(3)
    const rel = (id: string) => row(t.db, 'SELECT related_to_me AS r FROM mails WHERE id = ?', id).r
    expect(rel('mail_sent')).toBe(1)
    expect(rel('mail_to')).toBe(1)
    expect(rel('mail_cc')).toBe(0)
  })

  it('日程按 updatedAt 更新；全天和已拒绝不算与我有关', async () => {
    const t = makeCtx({ now: day(2026, 10, 29, 12, 0) })
    const mk = (id: string, over: Partial<(typeof t.source.eventsList)[number]>) => {
      const e = {
        id,
        title: '会议',
        start: day(2026, 10, 28, 14, 0),
        end: day(2026, 10, 28, 15, 0),
        allDay: false,
        organizer: { id: 'u_me', name: '我' },
        attendees: [] as Array<{ id: string; name: string; response: 'accepted' | 'tentative' | 'declined' | 'none' }>,
        location: '会议室',
        notes: '原始备注',
        updatedAt: day(2026, 10, 28, 14, 0),
        ...over,
      }
      t.source.eventsList.push(e)
      return e
    }
    const ev1 = mk('ev_1', {})
    mk('ev_2', { allDay: true, organizer: { id: 'u_hr', name: 'hr' }, attendees: [{ id: 'u_me', name: '我', response: 'accepted' }] })
    mk('ev_3', { organizer: { id: 'u_a', name: 'a' }, attendees: [{ id: 'u_me', name: '我', response: 'declined' }] })

    const run = await runBackup(t.ctx, 'calendar', 'scheduled')
    expect(run.result).toBe('success')
    expect(run.added).toBe(3)
    const rel = (id: string) => row(t.db, 'SELECT related_to_me AS r FROM events WHERE id = ?', id).r
    expect(rel('ev_1')).toBe(1)
    expect(rel('ev_2')).toBe(0)
    expect(rel('ev_3')).toBe(0)

    // 客户端里日程变更（updatedAt 变新）→ 本机更新
    ev1.updatedAt = day(2026, 10, 29, 10, 0)
    ev1.notes = '议程已更新'
    const run2 = await runBackup(t.ctx, 'calendar', 'scheduled')
    expect(run2.result).toBe('success')
    expect(row(t.db, 'SELECT COUNT(*) AS n FROM events').n).toBe(3)
    expect(row(t.db, 'SELECT notes, updated_at FROM events WHERE id = ?', 'ev_1')).toMatchObject({ notes: '议程已更新', updated_at: day(2026, 10, 29, 10, 0) })
  })
})
