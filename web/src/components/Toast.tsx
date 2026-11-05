// 右下角轻提示，3 秒后消失（ui.md 第 4 节"轻提示"）。
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'

type ShowToast = (text: string) => void

const ToastContext = createContext<ShowToast>(() => {})

export function useToast(): ShowToast {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([])
  const nextId = useRef(0)

  const show = useCallback<ShowToast>((text) => {
    const id = ++nextId.current
    setToasts((list) => [...list, { id, text }])
    window.setTimeout(() => {
      setToasts((list) => list.filter((toast) => toast.id !== id))
    }, 3000)
  }, [])

  const value = useMemo(() => show, [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div className="toast" key={toast.id}>
            {toast.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
