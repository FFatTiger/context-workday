// 回顾页右栏：版本轨、差异框、对比两个版本的弹窗（ui.md 第 4 节）。
import { useState } from 'react'
import type { DiffResponse, VersionListItem } from '../../../src/api-types'
import { commonPrefix, mdhm, triggerText } from '../format'
import { Button, EmptyState, ErrorState, Skeleton } from './primitives'
import { Modal } from './Modal'

function changesText(changes: VersionListItem['changes']): string {
  const parts: string[] = []
  if (changes.added) parts.push(`新增 ${changes.added}`)
  if (changes.edited) parts.push(`修改 ${changes.edited}`)
  if (changes.deleted) parts.push(`删除 ${changes.deleted}`)
  return parts.join(' · ')
}

export function VersionTrack({
  versions,
  selected,
  loading,
  error,
  onReload,
  onSelect,
}: {
  versions: VersionListItem[]
  selected: number | null
  loading: boolean
  error: string | null
  onReload: () => void
  onSelect: (version: number) => void
}) {
  if (loading) return <Skeleton rows={4} />
  if (error) return <ErrorState message={error} onRetry={onReload} />
  if (!versions.length) return <EmptyState title="这个周期还没有版本" />

  return (
    <div className="vers">
      {versions.map((version) => {
        const changes = version.mode === 'incremental' ? changesText(version.changes) : ''
        return (
          <button
            type="button"
            key={version.version}
            className={`v${version.version === selected ? ' on' : ''}`}
            onClick={() => onSelect(version.version)}
          >
            <span className="vn">v{version.version}</span>
            <span className="vb">
              <span className="vc">
                {version.inputNote}
                {changes ? ` · ${changes}` : ''}
              </span>
              <span className="vm">
                {mdhm(version.createdAt)} · {triggerText(version.trigger)}
                {version.mode === 'incremental' ? ' · 增量' : ''}
              </span>
            </span>
            {version.isFinal ? <span className="vtag">最终版</span> : null}
          </button>
        )
      })}
    </div>
  )
}

export function DiffBox({
  a,
  b,
  diff,
  loading,
  error,
  onRetry,
}: {
  a: number
  b: number
  diff: DiffResponse | null
  loading: boolean
  error: string | null
  onRetry: () => void
}) {
  let body = null
  if (loading) body = <Skeleton rows={3} />
  else if (error) body = <ErrorState message={error} onRetry={onRetry} />
  else if (diff?.mode === 'fulltext') {
    body = (
      <div className="difft">
        <div>
          <div className="difft-h">v{b} · 全量生成前</div>
          <ul>
            {diff.b.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="difft-h">v{a} · 全量生成后</div>
          <ul>
            {diff.a.map((text, index) => (
              <li key={index}>{text}</li>
            ))}
          </ul>
        </div>
      </div>
    )
  } else if (diff) {
    const rows = diff.rows.filter((row) => row.kind !== 'same')
    body = rows.length ? (
      <div className="diff">
        {rows.map((row, index) => {
          if (row.kind === 'edit') {
            const parts = commonPrefix(row.before, row.after)
            return (
              <p key={`${row.kind}-${row.itemId}-${index}`}>
                <span className="m">~</span>
                {parts.prefix}
                <del>{parts.before}</del> → {parts.after}
              </p>
            )
          }
          if (row.kind === 'add') {
            return (
              <p key={`${row.kind}-${row.itemId}-${index}`}>
                <span className="p">+</span>
                {row.text}
              </p>
            )
          }
          return (
            <p key={`${row.kind}-${row.itemId}-${index}`}>
              <span className="x">−</span>
              <del>{row.text}</del>
            </p>
          )
        })}
      </div>
    ) : (
      <div className="diff">
        <p className="muted">v{a} 与 v{b} 没有差异。</p>
      </div>
    )
  }

  return (
    <div className="diffwrap">
      <div className="diffh">
        v{a} 相比 v{b}
        {diff?.mode === 'fulltext' ? <span className="muted"> · 全量生成，按全文对比</span> : null}
      </div>
      {body}
    </div>
  )
}

export function CompareDialog({
  open,
  versions,
  initialA,
  initialB,
  onCancel,
  onConfirm,
}: {
  open: boolean
  versions: VersionListItem[]
  initialA: number | null
  initialB: number | null
  onCancel: () => void
  onConfirm: (a: number, b: number) => void
}) {
  const [a, setA] = useState(initialA ?? versions[0]?.version ?? 1)
  const [b, setB] = useState(initialB ?? versions[1]?.version ?? 1)

  return (
    <Modal
      open={open}
      title="对比两个版本"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <Button
            variant="primary"
            disabled={a === b}
            onClick={() => onConfirm(a, b)}
          >
            对比
          </Button>
        </>
      }
    >
      <div className="compare">
        <label>
          <span>A · 新的版本</span>
          <select value={a} onChange={(event) => setA(Number(event.target.value))}>
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version} · {mdhm(version.createdAt)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>B · 对比的版本</span>
          <select value={b} onChange={(event) => setB(Number(event.target.value))}>
            {versions.map((version) => (
              <option key={version.version} value={version.version}>
                v{version.version} · {mdhm(version.createdAt)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {a === b ? <p className="muted compare-note">两个版本不能相同。</p> : null}
    </Modal>
  )
}
