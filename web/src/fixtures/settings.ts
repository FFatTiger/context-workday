// 设置假数据（spec 第 11 节）：参与口径、模型、数据源、演示脱敏。
// 状态留在模块里，改完刷新页面还在；演示脱敏的开关与顶栏共用这份状态。
import type { Settings, SettingsResponse } from '../../../src/api-types'
import { currentScenario } from './scenario'

const DEFAULT: SettingsResponse = {
  participation: {
    speak: true,
    mention: true,
    reply: true,
    private: true,
    directed: true,
    events: true,
    sentMail: true,
    toMail: true,
  },
  redact: false,
  model: { name: 'demo-model', endpoint: null, destination: '演示模型（不联网）' },
  source: { name: '仿真客户端' },
  me: { name: '陈思远' },
  dataDir: '~/.context-workday',
}

let state: SettingsResponse = structuredClone(DEFAULT)

export function fixtureSettings(): SettingsResponse {
  return structuredClone(state)
}

export function fixtureSettingsSave(patch: Partial<Settings>): SettingsResponse {
  if (patch.participation) state = { ...state, participation: { ...state.participation, ...patch.participation } }
  if (typeof patch.redact === 'boolean') state = { ...state, redact: patch.redact }
  return structuredClone(state)
}

export function isRedactOn(): boolean {
  return state.redact
}

export function fixtureTestModel(): { ok: boolean; ms: number; error?: string } {
  if (currentScenario() === 'error') return { ok: false, ms: 1200, error: '连接超时' }
  return { ok: true, ms: 820 }
}
