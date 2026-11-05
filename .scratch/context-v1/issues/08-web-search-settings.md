Status: resolved
Blocked by: 07

# 08 前端：搜索页、设置页、接上 06/07 提出的接口字段

先读 06、07 票末尾的 Comments，`docs/design/ui.md` 5.4、5.7、第 6 节，`src/api-types.ts` 的 19、20、21。搜索页和设置页没有原型，沿用同一套变量和组件，风格和其他页一致。

## 范围

只改 `web/`。`api-types.ts` 不够用写进 Comments，不要改 `src/`。

## 步骤

### 1/3 接上新字段（main 合进来后 typecheck 现在是红的）

`src/api-types.ts` 按 06、07 的建议加了：
- `EvidenceResponse.item.itemIndex`：抽屉头部"第 N 条"改用它，去掉从页面传入/假数据推断的做法；
- `GET /api/card` 支持 `version=N`（也支持 `level=hour`）：回顾页选中版本轨上的旧版本时，左栏摘要卡换成那个版本的条目（ui.md 5.3 原本的要求），回到当前版本时恢复；
- `BackupSourceStatus.lastRun.added`、`progress.read`：来源卡显示"上次 · 新增 N 条"、备份中"已读取 N 条"。
假数据同步补上。`npm run typecheck` 恢复为绿。

### 2/3 搜索页 `/search`（ui.md 5.4）

- 顶部大搜索框（带入 URL 的 `q`），回车搜索；筛选：时间分段（今天 / 本周 / 本月 / 全部）、来源多选胶囊（摘要 / IM / 邮件 / 日程）、"只看与我有关"开关（默认开）。筛选都写进 URL，刷新可恢复。
- 结果列表：类型图标 + 来源说明 + 时间、片段里按 `highlights` 高亮、总数、分页（每页 50）。空结果显示 `hint`；没输入关键词时显示简短的使用说明。
- 点击结果按 spec 10：小时/日结条目 → `/today/<date>?hl=<period>:<itemId>`；周月年 → `/review/<level>/<period>?item=<id>`；IM → 上下文弹窗（弹窗里"去时间线"跳 `/today/<date>`）；邮件、日程 → 详情弹窗（复用 06 票的弹窗）。
- 顶栏搜索框 ⌘K 回车进来时直接带结果。

### 3/3 设置页 `/settings`（ui.md 5.7）

- 参与口径：8 个开关（五种形态、我参加的日程、我发出的邮件、收件人是我的邮件），说明"只影响之后生成"，改动即保存（`PUT /api/settings`）并轻提示。
- 模型：名称、地址、数据去向（`destination`），"测试连接"按钮（显示成功/失败和耗时）。
- 数据源：名称；我：名称。
- 演示脱敏：开关（和顶栏同一个状态，任一处改了另一处同步）。说明替换规则（人名保留姓、群名换编号、金额 ***、邮箱只留首字符）。
- 关于：版本号、数据目录说明一行（静态文案即可）。

## 自查

同 06/07：截搜索（有结果、空结果、无关键词）、设置正常态各一张，存 `docs/design/screens/08-*.png`；回顾页选中旧版本、备份页来源卡各补一张。收尾 `npm run typecheck`（两个 tsconfig）、`npx vite build`。

## Comments

### 做了什么

- **1/3 接新字段**：`DrawerTarget` 去掉页面传入的 `ordinal`，抽屉头部改成 `data.item.itemIndex`（假数据按条目在**该版本**里的位置算，选旧版本时读的是旧版本的条目序列）；`getCard` 支持 `version`（真实模式拼 `&version=N`，假数据从版本列表取该版条目和元信息）；回顾页选中版本轨上的旧版本时，左栏摘要卡换成那个版本，卡片顶部出“正在查看 v2（历史版本）· 回到最新”，条目上的“vN 新增/修改”标签改从选中版本的差异（`items` 模式）推出，全量对比时不出标签；`BackupSourceStatus.lastRun.added` 用于来源卡“上次 … · 新增 1,284 条”，`progress.read` 用于“已读取 1,024 条”。单位按来源（条/封/场），抽到 `format.sourceUnit`，备份记录表也改用它。
- **2/3 搜索页 `/search`**：56 高的大搜索框（自动聚焦、回车搜索）、时间分段（今天/本周/本月/全部，默认全部）、来源多选胶囊（默认全选，不允许全关）、“只看与我有关”开关（默认开），筛选全部写进 URL（默认值不写），刷新可恢复；结果行是类型图标 + 来源说明 + 高亮片段（`highlights` 用琥珀浅底）+ 时间，上方“共 N 条”，每页 50 条、底部“加载更多”；无关键词显示使用说明（有历史时附最近 5 次搜索词，存 localStorage），无结果显示“没有找到「关键词」”加 `hint`，加载中骨架、`?scenario=error` 显示失败重试；点击按 spec 10 走：小时/日结 → `/today/<date>?hl=<period>:<itemId>`，周月年 → `/review/<level>/<period>?item=<id>`，IM → 上下文弹窗（“去时间线”跳今天页），邮件/日程 → 复用 06 票的详情弹窗（`Drawer.tsx` 里那三个弹窗导出复用）；顶栏 ⌘K 回车进来的结果直接展示。
- **3/3 设置页 `/settings`**：单栏 880 宽五张卡——参与口径（8 个开关 + “只影响之后生成”说明，改动即 `PUT /api/settings` 并轻提示“已保存”，失败回滚）、模型（名称/地址/数据去向胶囊 + “测试连接”，结果用轻提示“连接成功 · 820 ms”/“连接失败：原因”）、数据源（数据源、我）、演示脱敏（与顶栏同一个状态，改任一处另一处同步，附替换规则与示例）、关于（版本号取自 `package.json`，数据目录一行静态文案）。`getSettings`/`testModel` 补进 `api.ts`。
- **假数据**：新增 `fixtures/search.ts`（把现有会话消息、邮件、日程和摘要条目摊成搜索池，做子串匹配、多词“与”、时间/来源/是否与我有关筛选、高亮合并、每页 50）和 `fixtures/settings.ts`（设置状态，脱敏开关与 `fixtureStatus` 共用）；`fixtures/evidence.ts` 补 `itemIndex`、`allImMessages/allMails/allEvents`；`?scenario=empty|error` 对两个新页面同样生效。
- 删掉没有使用者的 `web/src/pages/Placeholder.tsx` 和对应样式（搜索、设置都是真页面了）。

### 偏离票的地方和原因

- **无关键词状态**：票说“显示简短的使用说明”，ui.md 5.4 说“显示最近 5 次搜索词”。两处都做：使用说明为主，有搜索历史时补一行“最近搜索”（localStorage）。
- **分页形态**：票写“分页（每页 50）”，ui.md 5.4 写底部“加载更多”。合成：每页 50 条、底部“加载更多”按钮追加下一页。
- **数据去向胶囊颜色**：ui.md 只规定“仅本机”绿、“发送到 xxx”琥珀。假数据的“演示模型（不联网）”既不是“仅本机”也不往外发，按“不发到外部”处理成绿色（判断依据是 `destination` 是否以“发送到”开头），真实接口的两种取值仍照 ui.md。
- **来源卡的“新增”/“已读取”单位**：票写“新增 N 条”，实际按来源用条/封/场，和备份记录表一致。
- **回顾页的 `?version=N`**：票没要求，但选旧版本要能刷新恢复、也要能截静态图，加了只读的 URL 参数（不传就不写）。
- **条目的版本操作标签**：只看跟选中版本对应的那份差异（`diffTarget.a === card.version.version` 且是 `items` 模式）；全量生成的版本按全文对比，没有逐条差异，不出标签——沿用 06/07 的处理。
- 设置页多出“数据源”“关于”两张卡（票里列了内容，ui.md 5.7 只说三张卡），都在单栏 880 宽里，视觉不变。

### 测试结果

- `npx tsc --noEmit -p web/tsconfig.json`：通过。
- `npm run typecheck`：web 一侧通过；**根 tsconfig 有 13 个 `src/` 的既有错误**（`src/backup/coverage.ts` 2 处 `RawType`/`degradedItemCount` 未定义、`src/summary/evidence.ts` 8 处证据节点类型不匹配、`src/summary/hourly.ts` 1 处 `string | null`、`src/summary/store.ts` 2 处 sqlite 参数类型）。`git diff --stat 6597b59 -- src/` 为空，说明这些是 main 合进来之前就有的，本票只改 `web/`、不动 `src/`，留给管 `src/` 的票。
- `npx vite build`：通过（JS 354 kB，`package.json` 只内联了 `version` 字段，没有把 devDependencies 打进去）。
- Playwright 实际操作过：⌘K → 输入“迁移”回车进 `/search?q=迁移` 并出结果；点“本周”、关掉“邮件”后 URL 变成 `range=week&sources=summary,im,event`，刷新后筛选恢复；日结结果跳 `/today/2026-10-29?hl=2026-10-29:1` 并高亮 2 秒；小时摘要结果跳 `/today/2026-10-29?hl=2026-10-29T14:1` 并高亮；周摘要结果跳 `/review/week/2026-W44?item=1` 并高亮条目 2 秒；IM 结果打开上下文弹窗，“去时间线”跳 `/today/2026-10-29`；邮件结果打开 06 票的邮件详情弹窗；设置页关掉一个参与口径开关 → 轻提示“已保存”，测试连接 → “连接成功 · 820 ms”，脱敏开关与顶栏同步（两个开关同时翻转），`?scenario=error` 下搜索页和设置页都显示失败加重试；回顾页点版本轨 v2 → 卡片换成 v2 两条、顶部“正在查看 v2（历史版本）· 回到最新”，点“回到最新”恢复 v4 四条；抽屉头部显示“本周至今 · v4 · 第 1 条”；备份页来源卡显示“上次 今天 02:00 · 成功 · 新增 1,284 条”，`?scenario=generating` 时显示“已读取 1,024 条”。
- 截图（1536×1024 headless Chrome，设置页加高到 1536×1460 才装得下五张卡）：`docs/design/screens/08-search.png`、`08-search-empty.png`、`08-search-idle.png`、`08-settings.png`、`08-review-version.png`、`08-backup-source.png`、`08-backup-running.png`。

### 遗留

- `src/server/routes/` 里还没有 `/api/search`、`/api/settings`（票 05）。非 fixtures 模式下搜索页和设置页会显示加载失败；接口按 `api-types.ts` 第 19、20 节实现后前端不用改。
- 根 tsconfig 的 13 个 `src/` 错误见上，需要管 `src/` 的票收。
- 搜索假数据里“与我有关”是近似（我发的消息或正文含“我”），不是备份时按口径算的真实标记。
