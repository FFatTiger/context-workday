// 一个区块的数据获取：{ data, error, loading, reload }。
// deps 变化或 reload() 时重新请求；旧请求的返回会被丢弃。
import { useCallback, useEffect, useRef, useState } from 'react'

export interface ApiState<T> {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function useApi<T>(fn: () => Promise<T>, deps: unknown[]): ApiState<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  })
  const [tick, setTick] = useState(0)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    const id = ++seq.current
    setState((prev) => ({ ...prev, loading: true, error: null }))
    fnRef.current().then(
      (data) => {
        if (seq.current === id) setState({ data, error: null, loading: false })
      },
      (error: unknown) => {
        if (seq.current === id) {
          setState((prev) => ({ data: prev.data, error: errorText(error), loading: false }))
        }
      },
    )
    return () => {
      seq.current++
    }
    // deps 由调用方给出，fn 每次渲染都会变，所以不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])

  const reload = useCallback(() => setTick((value) => value + 1), [])
  return { ...state, reload }
}
