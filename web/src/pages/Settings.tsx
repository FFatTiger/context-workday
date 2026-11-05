// 设置页（ui.md 5.7）：参与口径、模型、数据源、演示脱敏、关于。
// 参与口径改了就存，只影响之后生成的摘要；演示脱敏和顶栏是同一个状态。
import { useEffect, useState, type ReactNode } from 'react'
import { version } from '../../../package.json'
import type { Settings } from '../../../src/api-types'
import { getSettings, saveSettings, testModel } from '../api'
import { Button, ErrorState, Skeleton, StatusPill, Switch } from '../components/primitives'
import { useToast } from '../components/Toast'
import { errorText, useApi } from '../hooks/useApi'

type Participation = Settings['participation']

const PARTICIPATION: Array<{ key: keyof Participation; name: string; note?: string }> = [
  { key: 'speak', name: '我开口' },
  { key: 'mention', name: '@我', note: '@所有人不算' },
  { key: 'reply', name: '回复我' },
  { key: 'private', name: '私聊' },
  { key: 'directed', name: '定向发给我' },
  { key: 'events', name: '我参加的日程', note: '拒绝的日程不算' },
  { key: 'sentMail', name: '我发出的邮件' },
  { key: 'toMail', name: '收件人是我的邮件', note: '抄送不算' },
]

export function Settings({ redact, onToggleRedact }: { redact: boolean; onToggleRedact: (next: boolean) => void }) {
  const toast = useToast()
  const state = useApi(getSettings, [])
  const [participation, setParticipation] = useState<Participation | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (state.data) setParticipation(state.data.participation)
  }, [state.data])

  async function toggleParticipation(key: keyof Participation, next: boolean) {
    if (!participation) return
    const updated = { ...participation, [key]: next }
    setParticipation(updated)
    try {
      await saveSettings({ participation: updated })
      toast('已保存')
    } catch (error) {
      setParticipation(participation)
      toast(`保存失败：${errorText(error)}`)
    }
  }

  async function runTest() {
    setTesting(true)
    try {
      const result = await testModel()
      toast(result.ok ? `连接成功 · ${result.ms} ms` : `连接失败：${result.error ?? '原因不明'}`)
    } catch (error) {
      toast(`连接失败：${errorText(error)}`)
    } finally {
      setTesting(false)
    }
  }

  const data = state.data
  const goesOut = data?.model.destination.startsWith('发送到') ?? false

  return (
    <>
      <div className="dayhead">
        <h1>
          设置<span>参与口径、模型、数据源与演示脱敏</span>
        </h1>
      </div>

      <div className="settings">
        {state.loading ? (
          <section className="card setcard">
            <div className="setactions">
              <Skeleton rows={4} />
            </div>
          </section>
        ) : state.error ? (
          <section className="card setcard">
            <ErrorState message={state.error} onRetry={state.reload} />
          </section>
        ) : data ? (
          <>
            <Section title="参与口径" note="决定哪些原文进摘要">
              <ul className="setrows">
                {PARTICIPATION.map((row) => (
                  <li key={row.key}>
                    <div className="setrow-main">
                      <span className="setrow-name">{row.name}</span>
                      {row.note ? <span className="setrow-note">{row.note}</span> : null}
                    </div>
                    <Switch
                      checked={participation?.[row.key] ?? false}
                      onChange={(next) => void toggleParticipation(row.key, next)}
                      label={row.name}
                    />
                  </li>
                ))}
              </ul>
              <p className="setfoot">改动只影响之后生成的摘要，已有版本不变。需要时可以在回顾页重新生成。</p>
            </Section>

            <Section title="模型" note="生成摘要用的模型">
              <dl className="kv">
                <dt>名称</dt>
                <dd>{data.model.name}</dd>
                <dt>地址</dt>
                <dd>{data.model.endpoint ?? '—'}</dd>
                <dt>数据去向</dt>
                <dd>
                  <StatusPill tone={goesOut ? 'warn' : 'ok'} dot={false}>
                    {data.model.destination}
                  </StatusPill>
                </dd>
              </dl>
              <div className="setactions">
                <Button disabled={testing} onClick={() => void runTest()}>
                  {testing ? '测试中…' : '测试连接'}
                </Button>
              </div>
            </Section>

            <Section title="数据源" note="原文从这里来">
              <dl className="kv">
                <dt>数据源</dt>
                <dd>{data.source.name}</dd>
                <dt>我</dt>
                <dd>{data.me.name}</dd>
              </dl>
            </Section>

            <Section title="演示脱敏" note="只影响显示，不改数据">
              <div className="setrow">
                <div className="setrow-main">
                  <span className="setrow-name">演示脱敏</span>
                  <span className="setrow-note">顶栏的开关和这里是同一个状态</span>
                </div>
                <Switch checked={redact} onChange={onToggleRedact} label="演示脱敏" />
              </div>
              <p className="setrule">
                人名保留姓（王总 → 王*）；群名换成编号（【核心迁移】项目群 → 群 1）；带货币单位的金额换成
                ***（预算 300 万 → 预算 ***）；邮箱只留首字符（zhaolei@corp.cn → z***@corp.cn）。
              </p>
            </Section>

            <Section title="关于">
              <dl className="kv">
                <dt>版本</dt>
                <dd>v{version}</dd>
                <dt>数据目录</dt>
                <dd>{data?.dataDir ?? '—'}（原文与摘要只存本机，证据链的底座）</dd>
              </dl>
            </Section>
          </>
        ) : null}
      </div>
    </>
  )
}

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: ReactNode
}) {
  return (
    <section className="card setcard">
      <div className="card-h">
        <h2>{title}</h2>
        {note ? <span className="sub">{note}</span> : null}
      </div>
      {children}
    </section>
  )
}
