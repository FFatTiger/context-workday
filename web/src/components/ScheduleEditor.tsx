// 时间规则的编辑浮层（ui.md 第 4 节"任务行"）：按任务类型编辑，非法时珊瑚色提示且保存禁用。
import { useEffect, useState, type ReactNode } from 'react'
import type { Job, JobName, ScheduleRule } from '../../../src/api-types'
import { patchJob } from '../api'
import { WEEKDAY_ZH } from '../../../src/time'
import { errorText } from '../hooks/useApi'
import { RULE_TYPE, validateRule } from '../schedule'
import { Button } from './primitives'

function NumberField({
  value,
  min,
  max,
  onChange,
  suffix,
}: {
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  suffix?: string
}) {
  return (
    <>
      <input
        className="pop-in"
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ''}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {suffix ? <span className="pop-suffix">{suffix}</span> : null}
    </>
  )
}

function ruleFields(
  name: JobName,
  rule: ScheduleRule,
  update: (next: ScheduleRule) => void,
): ReactNode {
  const type = RULE_TYPE[name]
  if (type === 'hourly') {
    return (
      <span className="pop-line">
        每小时第
        <NumberField
          value={rule.type === 'hourly' ? rule.minute : 5}
          min={0}
          max={59}
          suffix="分"
          onChange={(minute) => update({ type: 'hourly', minute })}
        />
      </span>
    )
  }
  if (type === 'daily') {
    const current = rule.type === 'daily' ? rule : { type: 'daily' as const, hour: 20, minute: 30 }
    return (
      <span className="pop-line">
        每天
        <NumberField
          value={current.hour}
          min={0}
          max={23}
          onChange={(hour) => update({ ...current, hour })}
        />
        :
        <NumberField
          value={current.minute}
          min={0}
          max={59}
          onChange={(minute) => update({ ...current, minute })}
        />
      </span>
    )
  }
  if (type === 'weekly') {
    const current = rule.type === 'weekly' ? rule : { type: 'weekly' as const, weekday: 7, hour: 3, minute: 0 }
    return (
      <span className="pop-line">
        每周
        <select
          className="pop-in pop-sel"
          value={current.weekday}
          onChange={(event) => update({ ...current, weekday: Number(event.target.value) })}
        >
          {[1, 2, 3, 4, 5, 6, 7].map((day) => (
            <option key={day} value={day}>
              {WEEKDAY_ZH[day]}
            </option>
          ))}
        </select>
        <NumberField value={current.hour} min={0} max={23} onChange={(hour) => update({ ...current, hour })} />
        :
        <NumberField
          value={current.minute}
          min={0}
          max={59}
          onChange={(minute) => update({ ...current, minute })}
        />
      </span>
    )
  }
  const current = rule.type === 'monthly' ? rule : { type: 'monthly' as const, day: 1, hour: 3, minute: 0 }
  return (
    <span className="pop-line">
      每月
      <NumberField value={current.day} min={1} max={31} suffix="日" onChange={(day) => update({ ...current, day })} />
      <NumberField value={current.hour} min={0} max={23} onChange={(hour) => update({ ...current, hour })} />
      :
      <NumberField
        value={current.minute}
        min={0}
        max={59}
        onChange={(minute) => update({ ...current, minute })}
      />
    </span>
  )
}

export function ScheduleEditor({
  job,
  onClose,
  onSaved,
}: {
  job: Job
  onClose: () => void
  onSaved: (job: Job) => void
}) {
  const [rule, setRule] = useState<ScheduleRule>(job.rule)
  const [saving, setSaving] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const clientError = validateRule(job.name, rule)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  async function save() {
    if (clientError) return
    setSaving(true)
    setServerError(null)
    try {
      const saved = await patchJob(job.name, { rule })
      onSaved(saved)
    } catch (error) {
      setServerError(errorText(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="pop" role="dialog" aria-label={`编辑 ${job.title} 的时间`}>
      <div className="pop-h">时间规则</div>
      <div className="pop-body">{ruleFields(job.name, rule, setRule)}</div>
      {clientError ? <div className="pop-err">{clientError}</div> : null}
      {serverError ? <div className="pop-err">{serverError}</div> : null}
      <div className="pop-f">
        <Button onClick={onClose}>取消</Button>
        <Button variant="primary" disabled={Boolean(clientError) || saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
