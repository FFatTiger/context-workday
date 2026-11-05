Status: resolved

# 06 前端：框架、今天页、证据抽屉

## 背景

后端在另一条线上并行开发（票 01–05），接口形状已经定死在 `src/api-types.ts`。本票先用**假数据（fixtures）**把前端框架、今天页、证据抽屉做出来，外观要和可点击原型一致。后端接口好了以后，只需要关掉假数据。

先读：`AGENTS.md`、`CONTEXT.md`、`docs/design/ui.md`（**第 0 节最重要**：视觉以原型为准；第 3、4 节和 5.1、5.2 的组件、状态、交互规则照做）、`src/api-types.ts`。然后用浏览器打开 `docs/design/prototype/index.html` 看一遍，对照 `docs/design/prototype/today.png`、`drawer.png`。

## 范围（只改 `web/`）

不许改 `src/` 下任何文件。发现 `api-types.ts` 不够用，写进 Comments，不要自己改。

## 技术约定

- React 18 + TypeScript，Vite（已配好，`vite.config.ts` 根目录是 `web/`）。不加新依赖：不要路由库、状态库、UI 库、图标库、CSS 框架。
- 路由：自己用 History API 写一个几十行的小路由（`web/src/router.ts`）。路径：`/today/:date?`、`/review/:level?/:period?`、`/search?q=`、`/backup`、`/tasks`、`/settings`，`/` 跳 `/today`。
- 样式：`web/src/styles.css` 已经是原型的 CSS 原样拷贝，在它的基础上整理成组件用的类名；颜色只用里面的 CSS 变量。图标用内联 SVG（单色线性，线宽 1.5）。
- 接口：`web/src/api.ts` 是唯一调接口的地方，每个接口一个函数，返回 `api-types.ts` 里的类型。URL 带 `?fixtures=1`（或环境变量 `VITE_FIXTURES=1`）时，改从 `web/src/fixtures/` 返回假数据，并模拟 300ms 延迟。假数据还要支持 `?scenario=empty|error|generating`，用来检查空、失败、生成中状态。
- 假数据照原型的内容来（2026-10-29 周四 20:36，今天 v1 / 本周至今 v4 / 本月至今 v16、"降级 1" 等），类型必须严格符合 `api-types.ts`。
- 数据获取写一个小 hook（`useApi(fn, deps)` 返回 `{data, error, loading, reload}`），每个页面区块都要有加载中（骨架）、空、失败（带"重试"）三种状态。

## 步骤

### 1/4 框架

- 顶部吸顶栏（原型的 `header.top`）：品牌、六个标签（今天 / 回顾 / 搜索 / 备份 / 任务 / 设置）、右侧 IM 备份状态胶囊（来自 `GET /api/status`）、"演示脱敏"开关（`PUT /api/settings` 的 `redact`，本票先只调 api 函数）、搜索框"搜索… ⌘K"。
- 告警横幅（ui.md 第 3 节）：`status.alerts` 非空时显示在顶栏下方，`--bad-soft` 底，"IM 备份失败 · 还剩 N 天可补救 · 去处理 ›"。
- 全局快捷键：⌘K / Ctrl+K 聚焦搜索框，回车跳 `/search?q=`；Esc 关闭抽屉和弹窗。
- 共享组件放 `web/src/components/`：状态胶囊、版本徽标、证据角标（含"降级 n"）、条目行、摘要卡、抽屉、弹窗、轻提示、骨架、分段控件、开关、按钮。后面的票都用它们。
- 其余页面先放占位（标题 + "建设中"），07、08 票实现。

### 2/4 今天页（ui.md 5.1 + 原型）

- 日期标题 + ‹ › 切换（不能到未来）、"回到今天"；顶部 24 小时活动条（`timeline.activity`）。
- 时间线卡：按 `hours` 逐行（左列时间 + "HH:05 生成"或版本徽标，右列条目，条目左侧来源色竖条按条目的主要证据类型取色），`gaps` 渲染成虚线说明行，今天末尾是"现在"行（"20:36 下次小时摘要 21:05"）。小时的 `generating` / `failed` 状态、悬停"重新生成"（确认后调 `POST /api/series/hour/:period/regenerate`）。
- 右侧吸顶三张摘要卡（`GET /api/card?level=day|week|month&date=`）：全部状态（未生成 + "立即生成"按钮调 `POST /api/daily/run`、生成中、已生成、失败 + 重试、无记录、上游已变更标记）。页脚文案按 ui.md 5.1 的表。"查看版本 ›"跳回顾页。
- 从搜索跳过来（URL 带 `?hl=<period>:<itemId>`）时目标高亮 2 秒。

### 3/4 证据抽屉（ui.md 抽屉、证据树、5.2 + `drawer.png`）

- 点任何条目或角标打开，URL 不变。头部：条目文本、层级路径（`path`）、汇总计数；树：按 `EvidenceNode` 渲染全部节点类型（下层条目可展开、IM、邮件、日程、`lost` 降级框、`more`），"引用 v1 · 最新 v2"小字，"展开到原文"按钮（带 `expand=raw` 重新请求）。
- IM 原文的"上下文"→ 弹窗（`GET /api/raw/im/:id/context`，目标消息高亮）；邮件、日程 → 详情弹窗。
- 底部"查看本条历史版本"→ 跳回顾页对应系列。

### 4/4 自查

- 用你自己的端口：`npx vite --port 5181 --strictPort`（记下 pid，用完 kill）。用 headless Chrome 截图：`google-chrome --headless=new --no-sandbox --hide-scrollbars --window-size=1536,1024 --virtual-time-budget=3000 --screenshot=/tmp/ctx06-today.png "http://127.0.0.1:5181/today/2026-10-29?fixtures=1"`。抽屉截图可以加一个仅假数据模式下生效的 `&open=<period>:<itemId>` 参数。
- 自己看截图，和 `docs/design/prototype/today.png`、`drawer.png` 逐块对比（布局、间距、字号、颜色），差异修到肉眼看不出明显区别为止。再截 `scenario=empty`、`error`、`generating` 三张，确认状态正确。
- 截图存到 `docs/design/screens/06-*.png` 一起提交。
- 收尾跑一次 `npm run typecheck`（两个 tsconfig 都要过）和 `npx vite build`。

## 验收

- 原型里今天页和抽屉能做的交互都能做，外观和截图一致。
- 四种状态（正常、加载、空、失败）都有。
- 不依赖后端：`?fixtures=1` 下所有交互可用。

## Comments

### 做了什么

- 框架：`web/src/router.ts`（History API 小路由，路径按票）、`web/src/api.ts`（唯一调接口的地方；`?fixtures=1` / `VITE_FIXTURES=1` 走假数据，300ms 延迟，`?scenario=empty|error|generating`）、`web/src/hooks/useApi.ts`（返回 `{data, error, loading, reload}`，丢弃过期响应）。
- 顶栏：品牌、六个标签、IM 备份状态胶囊（`GET /api/status`）、演示脱敏开关（`PUT /api/settings`，失败回滚并提示）、搜索框 ⌘K；告警横幅（`--bad-soft`）；Esc 关闭抽屉/弹窗；Ctrl/⌘K 聚焦搜索框，回车跳 `/search?q=`。
- 共享组件（`web/src/components/`）：状态胶囊、版本徽标、证据角标（含降级 n）、条目行、摘要卡、抽屉、弹窗与确认框、轻提示、骨架、分段控件、开关、按钮、内联图标。其余页面是标题加「建设中」的占位。
- 今天页：日期切换（不能到未来）和「回到今天」；24 小时活动条；时间线（左列 HH:00 加「HH:05 生成」或版本徽标、空档虚线行、现在行、条目左侧来源色竖条、generating / failed、悬停「重新生成」后确认再调 `POST /api/series/hour/:period/regenerate`）；右侧三张摘要卡的全部状态（未生成加立即生成、生成中、失败加重试、无记录、已生成、上游已变更·重建）和 ui.md 5.1 的页脚；`?hl=<period>:<itemId>` 高亮 2 秒并滚到可见处。
- 证据抽屉：条目文本、`path` 胶囊、汇总计数、证据树（下层条目可展开、IM / 邮件 / 日程、lost 降级框、more）、懒加载下层节点、「展开到原文」（`expand=raw` 重新请求）、「引用 v1 · 最新 v2」、IM 「上下文」弹窗（目标消息高亮）、邮件与日程详情弹窗、底部「查看本条历史版本」跳 `/review/:level/:period?item=`。
- 假数据照原型内容（2026-10-29 周四 20:36，今天 v1 / 本周 v4 / 本月 v16、降级 1）；月度第 1 条的抽屉按 `drawer.png` 逐个节点还原。

### 偏离票的地方和原因

- 活动条按票要求渲染 24 小时（原型画的是 08–22、15 根柱），样式仍照原型：灰底柱、深色活动柱、当前小时虚线框；右上显示数据算出的首末小时。
- 抽屉宽度沿用原型的 600px（ui.md 写 46%、最小 560；视觉以原型为准）。
- 抽屉页脚只保留「查看本条历史版本」（ui.md 第 7 节），「展开到原文」放在证据树底部（票 3/4 要求有这个按钮）。
- 日期标题不加「今天」小字（原型没有），非今天时在标题旁显示「回到今天」。
- 摘要卡「立即生成」：看今天时调 `POST /api/daily/run`；看过去日期时调该日期的 `POST /api/series/day/:period/regenerate`（`/api/daily/run` 只针对今天）。
- 假数据里 10/28 是未生成、10/27 是失败（并含一个失败小时，可点重试）、其它日期是无记录，方便逐个看状态；10/29 正常态与原型一致。
- 演示脱敏开关在 fixtures 下只改本地状态并提示；真实模式调 `PUT /api/settings`。

### 需要 api-types 补的地方（本票没有改 src/）

- `EvidenceResponse.item` 没有条目在当前版本里的序号，抽屉头部的「第 N 条」只能由页面点击时传入（深链接由假数据推断）。建议加 `itemIndex: number`。
- `EvidenceNode` 的 `lost` 节点没有 `text` / `generatedAt`，降级框正文只能用父条目的文本；原型里降级框展示的是那条小时摘要的文本。建议 `lost` 带上 `text` 和 `generatedAt`。

### 验证

- `npm run typecheck`（根与 `web/tsconfig.json`）通过；`npx vite build` 通过。
- 截图：`docs/design/screens/06-today.png`、`06-drawer.png`、`06-empty.png`、`06-error.png`、`06-generating.png`（1536×1024，headless Chrome），与 `docs/design/prototype/today.png`、`drawer.png` 逐块对照过。
- 用 Playwright 实际操作过：点条目或角标开抽屉、IM 上下文弹窗（目标高亮）、邮件与日程详情、Esc 分层关闭、Ctrl+K 聚焦搜索、回车跳搜索、日期前后切换与回到今天、立即生成、小时重新生成（确认框后 v2 · 手动重跑）、失败小时重试、上游已变更重建确认、脱敏开关、`?hl=` 高亮 2 秒后消失、`&open=` 截图深链接、「查看本条历史版本」跳转。
- 不依赖后端；`?fixtures=1` 下所有交互可用，首屏有 300ms 骨架。

### 遗留

- `src/server/routes/` 里还没有这些接口（票 01–05），非 fixtures 模式会显示加载失败；接口好了以后前端不用改。
- 搜索、回顾、备份、任务、设置页是占位，等 07、08 票。
