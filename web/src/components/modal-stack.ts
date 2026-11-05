// 弹窗计数：抽屉的 Esc 只在没有弹窗时关自己。
let depth = 0

export function pushModal() {
  depth++
}

export function popModal() {
  depth = Math.max(0, depth - 1)
}

export function isModalOpen(): boolean {
  return depth > 0
}
