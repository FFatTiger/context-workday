// 假数据模式的场景开关：?scenario=empty|error|generating。
export type Scenario = 'normal' | 'empty' | 'error' | 'generating'

let scenario: Scenario = 'normal'

export function setScenario(value: string | null) {
  scenario = value === 'empty' || value === 'error' || value === 'generating' ? value : 'normal'
}

export function currentScenario(): Scenario {
  return scenario
}

export function isErrorScenario(): boolean {
  return scenario === 'error'
}
