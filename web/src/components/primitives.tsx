// 共享的基础组件：状态胶囊、版本徽标、证据角标、骨架、按钮、开关、分段控件、
// 空状态和失败状态。后面几票的页面直接用。
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { ItemView, Level, VersionMeta } from '../../../src/api-types'
import { versionText } from '../format'
import { IconWarn } from './icons'

type ButtonVariant = 'ghost' | 'primary' | 'accent'

export function Button({
  variant = 'ghost',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const tone = variant === 'primary' ? 'pri' : variant === 'accent' ? 'acc' : ''
  return (
    <button type="button" className={`btn ${tone} ${className}`.trim()} {...rest}>
      {children}
    </button>
  )
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`sw${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (next: T) => void
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className={option.value === value ? 'on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skel" aria-hidden>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skel-row" key={index} style={{ width: `${88 - (index % 3) * 12}%` }} />
      ))}
    </div>
  )
}

export type PillTone = 'ok' | 'bad' | 'warn' | 'muted' | 'accent'

export function StatusPill({
  tone = 'ok',
  dot = true,
  children,
  onClick,
}: {
  tone?: PillTone
  dot?: boolean
  children: ReactNode
  onClick?: () => void
}) {
  const className = `pill pill-${tone}`
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {dot ? <span className="dot" /> : null}
        {children}
      </button>
    )
  }
  return (
    <span className={className}>
      {dot ? <span className="dot" /> : null}
      {children}
    </span>
  )
}

export function VersionBadge({ version, level }: { version: VersionMeta; level: Level }) {
  const text = versionText(version, level)
  if (level === 'hour') {
    return version.version === 1 ? <span className="gen">{text}</span> : <span className="badge">{text}</span>
  }
  const [head, ...rest] = text.split(' · ')
  return (
    <span className="ver">
      <b>{head}</b>
      {rest.length ? ` · ${rest.join(' · ')}` : ''}
    </span>
  )
}

export function EvidenceChips({
  item,
  level,
  onOpen,
}: {
  item: ItemView
  level: Level
  onOpen: () => void
}) {
  const chips: Array<{ key: string; className: string; text: string }> = []
  const counts = item.counts
  if (level === 'hour') {
    if (counts.event) chips.push({ key: 'event', className: '', text: `日程 ${counts.event}` })
    if (counts.mail) chips.push({ key: 'mail', className: '', text: `邮件 ${counts.mail}` })
    if (counts.im) chips.push({ key: 'im', className: '', text: `原文 ${counts.im}` })
    if (!counts.im && !counts.mail && !counts.event && counts.evidence) {
      chips.push({ key: 'evidence', className: 'ev', text: `证据 ${counts.evidence}` })
    }
  } else if (counts.evidence) {
    chips.push({ key: 'evidence', className: 'ev', text: `证据 ${counts.evidence}` })
  }

  return (
    <span className="chips">
      {chips.map((chip) => (
        <button
          type="button"
          key={chip.key}
          className={`chip ${chip.className}`.trim()}
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          {chip.text}
        </button>
      ))}
      {item.degraded > 0 ? (
        <button
          type="button"
          className="chip deg"
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
        >
          <IconWarn size={11} />
          降级 {item.degraded}
        </button>
      ) : null}
    </span>
  )
}

export function EmptyState({ title, note }: { title: string; note?: string }) {
  return (
    <div className="empty">
      <p>{title}</p>
      {note ? <p className="muted">{note}</p> : null}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card-err">
      <p className="err-title">加载失败</p>
      <p className="muted">{message}</p>
      <Button onClick={onRetry}>重试</Button>
    </div>
  )
}

/** 生成失败（api 调用成功但摘要状态是 failed） */
export function FailedState({
  title = '生成失败',
  message,
  onRetry,
  retryText = '重试',
}: {
  title?: string
  message?: string
  onRetry: () => void
  retryText?: string
}) {
  return (
    <div className="card-fail">
      <p className="err-title">{title}</p>
      {message ? <p className="muted">{message}</p> : null}
      <Button onClick={onRetry}>{retryText}</Button>
    </div>
  )
}
