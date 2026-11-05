// 版本对比（spec 第 8 节）：同一增量链逐条对比，任一全量则全文对比；版本列表的变更计数与输入说明。
import { describe, expect, it } from 'vitest'
import { diffVersions, inputNote, sameIncrementalChain, versionChanges } from '../src/summary/diff.js'
import { getSeries, getVersion, saveVersion } from '../src/summary/store.js'
import { makeCtx, type TestCtx } from './helpers.js'

const WEEK = '2026-W44'

function mkVersion(t: TestCtx, input: Parameters<typeof saveVersion>[1]) {
  saveVersion(t.db, input)
}

/** 造一个周系列：v1 全量（#1 #2），v2 增量（#1 改 #3 增，#2 删），v3 全量重建（#4 #5） */
function setupChain(t: TestCtx) {
  mkVersion(t, {
    level: 'week',
    period: WEEK,
    createdAt: t.clock.now(),
    trigger: 'scheduled',
    mode: 'full',
    model: 'test',
    inputs: [],
    items: [
      { text: '预算初稿', op: 'add', refs: [] },
      { text: '接口联调', op: 'add', refs: [] },
    ],
  })
  mkVersion(t, {
    level: 'week',
    period: WEEK,
    createdAt: t.clock.now(),
    trigger: 'scheduled',
    mode: 'incremental',
    model: 'test',
    inputs: [],
    items: [
      { itemId: 1, text: '预算定稿', op: 'edit', refs: [] },
      { text: '灰度上线', op: 'add', refs: [] },
    ],
  })
  mkVersion(t, {
    level: 'week',
    period: WEEK,
    createdAt: t.clock.now(),
    trigger: 'manual',
    mode: 'full',
    model: 'test',
    inputs: [],
    items: [
      { text: '重建条目一', op: 'add', refs: [] },
      { text: '重建条目二', op: 'add', refs: [] },
    ],
  })
  return getSeries(t.db, 'week', WEEK)!
}

describe('diffVersions', () => {
  it('同一增量链：逐条 edit / add / delete / same', () => {
    const t = makeCtx()
    const s = setupChain(t)
    const res = diffVersions(t.db, s.id, 1, 2)
    expect(res.mode).toBe('items')
    if (res.mode !== 'items') return
    expect(res.rows).toEqual([
      { kind: 'edit', itemId: 1, before: '预算初稿', after: '预算定稿' },
      { kind: 'add', itemId: 3, text: '灰度上线' },
      { kind: 'delete', itemId: 2, text: '接口联调' },
    ])
  })

  it('跨越全量版本（编号体系断了）→ 全文对比', () => {
    const t = makeCtx()
    const s = setupChain(t)
    const res = diffVersions(t.db, s.id, 2, 3)
    expect(res.mode).toBe('fulltext')
    if (res.mode !== 'fulltext') return
    expect(res.a).toEqual(['预算定稿', '灰度上线'])
    expect(res.b).toEqual(['重建条目一', '重建条目二'])
    // v1 → v3 中间夹着 v3 这个全量，也只能全文对比
    expect(diffVersions(t.db, s.id, 1, 3).mode).toBe('fulltext')
  })

  it('sameIncrementalChain：中间有全量就算断链', () => {
    const t = makeCtx()
    const s = setupChain(t)
    expect(sameIncrementalChain(t.db, s.id, 1, 2)).toBe(true)
    expect(sameIncrementalChain(t.db, s.id, 2, 3)).toBe(false)
    expect(sameIncrementalChain(t.db, s.id, 1, 3)).toBe(false)
  })
})

describe('versionChanges（版本列表的变更计数）', () => {
  it('v1 全是新增；增量版本按编号对比；全量重建表现为全加全删', () => {
    const t = makeCtx()
    const s = setupChain(t)
    expect(versionChanges(t.db, s.id, 1)).toEqual({ added: 2, edited: 0, deleted: 0 })
    expect(versionChanges(t.db, s.id, 2)).toEqual({ added: 1, edited: 1, deleted: 1 })
    expect(versionChanges(t.db, s.id, 3)).toEqual({ added: 2, edited: 0, deleted: 2 })
  })
})

describe('inputNote（版本列表的输入说明）', () => {
  it('收尾 / 首次生成 / 手动重建', () => {
    const t = makeCtx()
    const s = setupChain(t)
    const v1 = getVersion(t.db, s.id, 1)!
    const v2 = getVersion(t.db, s.id, 2)!
    const v3 = getVersion(t.db, s.id, 3)!
    expect(inputNote(t.db, v1.meta)).toBe('首次生成')
    expect(inputNote(t.db, v2.meta)).toBe('无新输入') // 增量但 inputs 为空
    expect(inputNote(t.db, v3.meta)).toBe('手动重建')

    saveVersion(t.db, {
      level: 'week',
      period: WEEK,
      createdAt: t.clock.now(),
      trigger: 'close',
      mode: 'full',
      model: 'test',
      inputs: [],
      isFinal: true,
      items: [{ text: '最终', op: 'add', refs: [] }],
    })
    expect(inputNote(t.db, getVersion(t.db, s.id, 4)!.meta)).toBe('收尾')
  })

  it('增量：并入周四、周五日结；多小时用份数；月摘要入年', () => {
    const t = makeCtx()
    // 两个日系列（周四、周五）+ 一个小时系列
    saveVersion(t.db, { level: 'day', period: '2026-10-29', createdAt: 0, trigger: 'scheduled', mode: 'full', model: 't', inputs: [], items: [{ text: 'a', op: 'add', refs: [] }] })
    saveVersion(t.db, { level: 'day', period: '2026-10-30', createdAt: 0, trigger: 'scheduled', mode: 'full', model: 't', inputs: [], items: [{ text: 'b', op: 'add', refs: [] }] })
    saveVersion(t.db, { level: 'day', period: '2026-10-31', createdAt: 0, trigger: 'scheduled', mode: 'full', model: 't', inputs: [], items: [{ text: 'c', op: 'add', refs: [] }] })
    saveVersion(t.db, { level: 'hour', period: '2026-10-29T09', createdAt: 0, trigger: 'scheduled', mode: 'full', model: 't', inputs: [], items: [{ text: 'h', op: 'add', refs: [] }] })
    saveVersion(t.db, { level: 'month', period: '2026-10', createdAt: 0, trigger: 'scheduled', mode: 'full', model: 't', inputs: [], items: [{ text: 'm', op: 'add', refs: [] }] })
    const thu = getSeries(t.db, 'day', '2026-10-29')!
    const fri = getSeries(t.db, 'day', '2026-10-30')!
    const sat = getSeries(t.db, 'day', '2026-10-31')!
    const hour = getSeries(t.db, 'hour', '2026-10-29T09')!
    const month = getSeries(t.db, 'month', '2026-10')!

    const note = (level: 'week' | 'year', inputs: Array<{ seriesId: number; version: number }>) => {
      saveVersion(t.db, {
        level,
        period: level === 'week' ? WEEK : '2026',
        createdAt: t.clock.now(),
        trigger: 'catchup',
        mode: 'incremental',
        model: 't',
        inputs,
        items: [{ text: 'x', op: 'add', refs: [] }],
      })
      const s = getSeries(t.db, level, level === 'week' ? WEEK : '2026')!
      return inputNote(t.db, getVersion(t.db, s.id, s.current_version)!.meta)
    }

    expect(note('week', [{ seriesId: thu.id, version: 1 }])).toBe('并入周四日结')
    expect(note('week', [{ seriesId: thu.id, version: 1 }, { seriesId: fri.id, version: 1 }])).toBe('并入周四、周五日结')
    expect(note('week', [{ seriesId: thu.id, version: 1 }, { seriesId: fri.id, version: 1 }, { seriesId: sat.id, version: 1 }])).toBe('并入 3 份日结')
    expect(note('week', [{ seriesId: hour.id, version: 1 }])).toBe('并入09:00小时摘要')
    expect(note('year', [{ seriesId: month.id, version: 1 }])).toBe('并入10 月月摘要')
  })
})
