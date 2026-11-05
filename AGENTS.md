# Context · 工作日镜

本机运行的个人工作记录系统。定时备份企业 IM 客户端里的 IM 消息、邮件和日程原文，按小时、日、周、月、年生成"我干了什么"的摘要，每个条目都能沿证据链追到原文。

以 npm 包 `context-workday` 发布到内网：`npm i -g context-workday-x.y.z.tgz` 或 `npx context-workday`。服务端打包成 `dist/` 下的单文件，运行时零依赖，只要求 Node ≥ 22.13（用内置的 `node:sqlite`）。

## 先读

1. `CONTEXT.md`：术语表。代码命名、界面文案都用这里的词。
2. `docs/product.md`：整体逻辑。
3. `docs/adr/`：已定的决策。动相关模块前先读。
4. 功能规则：`.scratch/context-v1/spec.md`。界面：`docs/design/ui.md` + 可点击原型 `docs/design/prototype/index.html`（视觉以原型为准，见 ui.md 第 0 节）。
5. 内网对接：`docs/intranet.md`。

## 结构与归属

每块逻辑只有一个归属模块，别处要用就调用它，不要复制一份。

| 路径 | 管什么 |
|---|---|
| `src/source/types.ts` | **数据源合同**。内网唯一需要实现的接口。改它等于改对内网的承诺，必须同步 `docs/intranet.md` 和 `doctor` |
| `src/source/mock.ts` | 仿真企业 IM 客户端（演示、测试、sim 用） |
| `src/source/load.ts` | 按配置加载数据源模块 |
| `src/llm/` | 摘要器合同 `types.ts`；`openai.ts` OpenAI 兼容实现 + 提示词；`mock.ts` 不联网的规则实现 |
| `src/db/` | 表结构 `schema.ts`、打开数据库、事务 `tx()`、键值 `getMeta/setMeta` |
| `src/time.ts` | 时钟、上海时区、周期键（`2026-10-29T09` / `2026-10-29` / `2026-W44` / `2026-10` / `2026`） |
| `src/participation.ts` | 口径：参与会话、与我有关的日程和邮件、降噪 |
| `src/backup/` | 三个备份任务：水位、去重、核对、覆盖状态、告警、存储统计 |
| `src/summary/store.ts` | 摘要系列、版本、条目、引用的读写；"上游已变更"标记 |
| `src/summary/hourly.ts` | 小时摘要流水线 |
| `src/summary/rollup.ts` | 日结、周、月、年：增量、补跑、收尾 |
| `src/summary/evidence.ts` | 证据链展开、原文可用性、降级 |
| `src/summary/diff.ts` | 版本对比 |
| `src/jobs/` | 定时规则、调度、待处理清单、运行记录、启动补跑 |
| `src/search.ts`、`src/settings.ts`、`src/redact.ts` | 搜索、设置、演示脱敏（脱敏只在 API 出口做） |
| `src/server/` | HTTP：`app.ts` 组装，`routes/<领域>.ts` 各自注册。接口形状只认 `src/api-types.ts` |
| `src/doctor.ts` | 数据源自检（内网对接时用） |
| `src/sim.ts` | 虚拟时钟快进，生成演示历史 |
| `web/` | React 前端。只通过 `web/src/api.ts` 调接口，类型来自 `src/api-types.ts` |
| `test/` | vitest。最高接缝："流水线 + 假客户端 + 假模型 + 虚拟时钟" |

## 规则

- 所有依赖都从 `Ctx`（`src/context.ts`）拿：`db`、`clock`、`source`、`summarizer`。不许直接 `Date.now()`，用 `ctx.clock.now()`，否则 sim 和测试会错。
- 时间存 epoch 毫秒；周期按 Asia/Shanghai，用 `src/time.ts` 的函数，不要自己算。
- 一个版本连同条目、引用必须在一个 `tx()` 里写完。
- 接口返回的形状改了，先改 `src/api-types.ts`，前后端一起编译过。
- 依赖一律装成 devDependencies（构建时打进 dist）。不要加运行时依赖，不要加原生模块。
- 界面文案用简体中文，按 `CONTEXT.md` 的术语。颜色只用原型里的 CSS 变量。
- 文档和规格有矛盾或缺口时停下来写进票的 Comments，不要自己发明规则。

## 命令

```bash
npm install
npm run dev          # 后端 --demo（4318）+ 前端 vite（5173，/api 代理到 4318）
npm run typecheck
npm test             # vitest
npm run build        # dist/cli.mjs + dist/web
node dist/cli.mjs start --demo --data /tmp/ctx-demo
node dist/cli.mjs sim --days 45 --data /tmp/ctx-demo   # 先灌演示历史
npm run pack:intranet   # 产出 context-workday-x.y.z.tgz
```

## Agent skills

### Issue tracker

票是 `.scratch/<feature>/issues/NN-slug.md`，开头一行 `Status:`。见 `docs/agents/issue-tracker.md`。

### Triage labels

needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。见 `docs/agents/triage-labels.md`。

### Domain docs

单一上下文：根目录 `CONTEXT.md`，决策在 `docs/adr/`。见 `docs/agents/domain.md`。
