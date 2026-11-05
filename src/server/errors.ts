// 接口出口的失败原因文案：数据库里存的是生成过程的原始错误（含错误类名），
// 界面只显示用户能理解的一句话。

/** 把 series.last_error 换成卡片上的失败原因 */
export function failureText(raw: string): string {
  if (/SourceUnavailable|客户端不可用/.test(raw)) return '客户端不可用，稍后会自动重试'
  // 其余保留原始信息（例如模型报错），只去掉 "XxxError: " 这类类名前缀
  return raw.replace(/^[A-Za-z]*Error:\s*/, '')
}
