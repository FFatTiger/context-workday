// 摘要器测试：openai 兼容实现打本地假 HTTP 服务（成功 / 格式错误 / 5xx 重试 / 围栏剥离），
// mock 摘要器的确定性和规则。
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createMockSummarizer } from '../src/llm/mock.js'
import { createOpenAiSummarizer } from '../src/llm/openai.js'
import { SummarizerFormatError } from '../src/llm/types.js'
import type { HourlyInput, RollupInput, SourceLine } from '../src/llm/types.js'
import { fromLocal } from '../src/time.js'

const completion = (content: string) => JSON.stringify({ choices: [{ message: { content } }] })

async function withServer(handler: http.RequestListener, fn: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    await fn(port)
  } finally {
    server.close()
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
  })
}

const noSleep = async () => {}

describe('openai 摘要器：本地假 HTTP 服务', () => {
  it('成功：发 chat/completions，temperature 0.2，解析 JSON 数组', async () => {
    const bodies: string[] = []
    await withServer(async (req, res) => {
      expect(req.url).toBe('/v1/chat/completions')
      expect(req.headers.authorization).toBe('Bearer test-key')
      bodies.push(await readBody(req))
      res.setHeader('content-type', 'application/json')
      res.end(completion(JSON.stringify([{ text: '推进了预算定稿', refs: ['m1', 'm2'] }])))
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key', model: 'test-model' }, { sleep: noSleep })
      const out = await s.hourly(hourlyInput())
      expect(out).toEqual([{ text: '推进了预算定稿', refs: ['m1', 'm2'] }])
      const body = JSON.parse(bodies[0])
      expect(body.model).toBe('test-model')
      expect(body.temperature).toBe(0.2)
      expect(body.messages.length).toBeGreaterThan(0)
    })
  })

  it('容忍 ```json 围栏和前后杂文', async () => {
    await withServer((req, res) => {
      readBody(req).then(() => {
        res.setHeader('content-type', 'application/json')
        res.end(completion('好的，以下是摘要：\n```json\n[{"text":"定了切换窗口","refs":["m3"]}]\n```\n以上。'))
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }, { sleep: noSleep })
      expect(await s.hourly(hourlyInput())).toEqual([{ text: '定了切换窗口', refs: ['m3'] }])
    })
  })

  it('输出不是合法 JSON：抛 SummarizerFormatError，不重试', async () => {
    let requests = 0
    await withServer((req, res) => {
      requests++
      readBody(req).then(() => {
        res.setHeader('content-type', 'application/json')
        res.end(completion('我认为无法总结这段内容。'))
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }, { sleep: noSleep })
      await expect(s.hourly(hourlyInput())).rejects.toBeInstanceOf(SummarizerFormatError)
      expect(requests).toBe(1)
    })
  })

  it('条目缺 refs：抛 SummarizerFormatError，message 可作 feedback', async () => {
    await withServer((req, res) => {
      readBody(req).then(() => {
        res.setHeader('content-type', 'application/json')
        res.end(completion(JSON.stringify([{ text: '有文本没引用' }])))
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }, { sleep: noSleep })
      await expect(s.hourly(hourlyInput())).rejects.toThrow('refs')
    })
  })

  it('5xx 按 10s/30s/90s 重试 3 次（等待注入为 0），最终成功', async () => {
    let requests = 0
    await withServer((req, res) => {
      requests++
      readBody(req).then(() => {
        if (requests <= 2) {
          res.statusCode = 500
          res.end('boom')
        } else {
          res.setHeader('content-type', 'application/json')
          res.end(completion(JSON.stringify([{ text: '重试后成功', refs: ['m1'] }])))
        }
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }, { sleep: noSleep })
      expect(await s.hourly(hourlyInput())).toEqual([{ text: '重试后成功', refs: ['m1'] }])
      expect(requests).toBe(3)
    })
  })

  it('重试用尽后抛最后一次的错误', async () => {
    let requests = 0
    await withServer((req, res) => {
      requests++
      readBody(req).then(() => {
        res.statusCode = 503
        res.end('unavailable')
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }, { sleep: noSleep })
      await expect(s.hourly(hourlyInput())).rejects.toThrow('503')
      expect(requests).toBe(4) // 首发 + 3 次重试
    })
  })

  it('4xx 不重试，直接抛', async () => {
    let requests = 0
    await withServer((req, res) => {
      requests++
      readBody(req).then(() => {
        res.statusCode = 401
        res.end('unauthorized')
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' }, { sleep: noSleep })
      await expect(s.hourly(hourlyInput())).rejects.toThrow('401')
      expect(requests).toBe(1)
    })
  })

  it('ping：成功返回耗时', async () => {
    await withServer((req, res) => {
      readBody(req).then(() => {
        res.setHeader('content-type', 'application/json')
        res.end(completion('ok'))
      })
    }, async (port) => {
      const s = createOpenAiSummarizer({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'm' })
      const r = await s.ping()
      expect(r.ok).toBe(true)
      expect(r.ms).toBeGreaterThanOrEqual(0)
    })
  })
})

// ───────── mock 摘要器 ─────────

function hourlyInput(): HourlyInput {
  const t = fromLocal(2026, 10, 29, 9, 30)
  const line = (over: Partial<SourceLine> & Pick<SourceLine, 'ref' | 'type' | 'where' | 'who' | 'text'>): SourceLine => ({ time: t, contextOnly: false, ...over })
  return {
    label: '2026-10-29 09:00–10:00',
    me: '陈思远',
    maxItems: 3,
    lines: [
      line({ ref: 'x1', type: 'im', where: 'Q4 预算评审', who: '王总', text: '昨天说的初稿呢', contextOnly: true }),
      line({ ref: 'm1', type: 'im', where: 'Q4 预算评审', who: '陈思远', text: '初稿已发邮箱，大家看下' }),
      line({ ref: 'm2', type: 'im', where: 'Q4 预算评审', who: '王总', text: '确认：按砍 8% 执行' }),
      line({ ref: 'e1', type: 'event', where: '产品周会', who: '我', text: '地点 5 号会议室' }),
      line({ ref: 'c1', type: 'mail', where: '预算反馈', who: '陈思远 → 王总', text: '请审阅附件' }),
    ],
  }
}

describe('mock 摘要器', () => {
  it('同一输入输出稳定', async () => {
    const s = createMockSummarizer()
    const a = await s.hourly(hourlyInput())
    const b = await s.hourly(hourlyInput())
    expect(a).toEqual(b)
  })

  it('按会话分组，结论词优先，refs 只指向可引用行，日程邮件各成条，遵守上限', async () => {
    const s = createMockSummarizer()
    const out = await s.hourly(hourlyInput())
    const quotable = hourlyInput().lines.filter((l) => !l.contextOnly).map((l) => l.ref)
    for (const item of out) {
      for (const r of item.refs) expect(quotable).toContain(r)
    }
    // 会话条目选了含"确认"的消息
    const im = out.find((i) => i.text.includes('Q4 预算评审'))!
    expect(im.text).toContain('确认：按砍 8% 执行')
    expect(out.some((i) => i.text.includes('产品周会'))).toBe(true)
    expect(out.some((i) => i.text.includes('预算反馈'))).toBe(true)
    expect(out.length).toBeLessThanOrEqual(3)
  })

  it('上层全量：按工作线去重', async () => {
    const s = createMockSummarizer()
    const input: RollupInput = {
      level: 'day',
      label: '10/29 周四 日结',
      maxItems: 6,
      previous: [],
      inputs: [
        { ref: 'd1', from: '09:00', text: '「Q4 预算」初稿发出' },
        { ref: 'd2', from: '10:00', text: '「Q4 预算」王总确认砍 8%' },
        { ref: 'd3', from: '11:00', text: '「看板 2.0」灰度放量到 50%' },
      ],
    }
    const out = await s.rollupFull(input)
    expect(out).toHaveLength(2)
    expect(out[0].refs).toEqual(['d1'])
    expect(out[0].text).toContain('Q4 预算')
    expect(out[1].text).toContain('看板 2.0')
  })

  it('增量：同工作线 edit，新工作线 add，超上限删最旧', async () => {
    const s = createMockSummarizer()
    const input: RollupInput = {
      level: 'week',
      label: '第 44 周',
      maxItems: 3,
      previous: [
        { id: 1, text: '推进「Q4 预算」：初稿' },
        { id: 2, text: '推进「移动端」：需求收集' },
        { id: 3, text: '处理：年度述职材料' },
      ],
      inputs: [
        { ref: 'd1', from: '10/29 日结', text: '「Q4 预算」定稿：砍 8%' },
        { ref: 'd2', from: '10/29 日结', text: '「看板 2.0」上线' },
      ],
    }
    const ops = await s.rollupIncremental(input)
    const edit = ops.find((o) => o.op === 'edit')
    expect(edit).toMatchObject({ op: 'edit', id: 1 })
    if (edit?.op === 'edit') expect(edit.text).toContain('定稿')
    // 超上限（3 存活 + 1 新增 > 3）：优先删本轮没更新过的最旧条目，别把刚 edit 的删掉
    expect(ops).toContainEqual({ op: 'delete', id: 2 })
    expect(ops.some((o) => o.op === 'add' && o.text.includes('看板 2.0'))).toBe(true)
    expect(ops.some((o) => o.op === 'keep' && o.id === 3)).toBe(true)
  })
})
