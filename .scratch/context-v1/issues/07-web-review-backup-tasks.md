Status: resolved
Blocked by: 06

# 07 前端：回顾页、备份页、任务页

接着 06 票做。先读 06 票末尾的 Comments（框架、组件、假数据的约定都在那里），再读 `docs/design/ui.md` 第 4 节（版本轨与差异框、日结小卡、覆盖条、任务行、运行记录行）、5.3、5.5、5.6、第 7 节，对照原型 `docs/design/prototype/index.html` 的回顾、备份、任务三个视图和 `review.png`、`backup.png`、`tasks.png`。接口形状：`src/api-types.ts` 的 2、5、6、7、8、10–18。

## 范围

只改 `web/`。复用 06 票的组件、`api.ts`、`useApi`、假数据机制；缺的组件补进 `web/src/components/`。`api-types.ts` 不够用写进 Comments，不要改 `src/`。

## 步骤

### 1/3 回顾页 `/review/:level/:period`

- 分段控件：小时 / 日 / 周 / 月 / 年，周期前后切换（不能到未来），默认本周。
- 左：当前版本的摘要卡（条目带"v4 新增 / v4 修改"标签，可点开证据抽屉），上游已变更标记 + 重建确认。周、月视图下方是下层输入（`children`）：周 → 7 张日结小卡，月 → 当月每天，年 → 12 个月，全部状态（已生成、已并入 vN、未生成、未来、无记录），点击跳今天页那一天。
- 右：版本轨（新 → 旧，选中项高亮，最终版标签）+ 差异框（"v4 相比 v3"，edit / add / delete；`fulltext` 时左右两列）+ "对比两个版本"弹窗 + "重新生成 vN+1"（确认后调 regenerate）。
- 从搜索或抽屉跳来带 `?item=<id>` 时高亮该条目 2 秒。

### 2/3 备份页 `/backup`

- 三张来源状态卡（IM / 邮件 / 日程，状态、累计、保留期、频率、上次/下次）。
- 覆盖卡：来源分段控件（IM 默认 60 天，邮件 120 天），覆盖条（四种颜色、今天描边、悬停显示日期/状态/客户端和本机条数、缺口下方标注、右端 7 格"可补救窗口"括号两种文案）；"受影响的摘要 n 条"可展开列表（`/api/backup/affected`）。
- 备份记录表（分页、按来源和结果筛选），"立即备份"按钮（运行中禁用）。
- 存储卡（总占用、原文、摘要与版本、完整性校验）。

### 3/3 任务页 `/tasks`

- 链路图："原文 → 小时 → 日 → 周 / 月 → 年"，含"次日补跑"回环（简单的 SVG 或 CSS 即可，和原型的 24 小时刻度尺放在同一张卡里也行）。
- 24 小时刻度尺（原型样式，按任务配置画点，每小时的 :05 点要看得见）。
- 7 行任务行：开关、名称、说明、时间规则（点击弹出编辑浮层，按类型编辑，非法时珊瑚色提示且保存禁用——前端先按 spec 第 2 节的允许范围校验，后端 400 的 `error` 也要显示）、上次运行、下次运行、"立即运行"（运行中禁用，409 时提示）。停用的行压暗、下次运行"已停用"。
- 运行记录列表：按任务、结果筛选，分页，点击展开详情（产出的版本可点击跳回顾页）。

## 假数据

在 `web/src/fixtures/` 补齐这些接口的假数据，内容延续原型（第 44 周、v1–v4、10/12–10/14 缺口等），类型严格符合 `api-types.ts`。`?scenario=empty|error|generating` 对新页面同样生效。

## 自查

同 06：`npx vite --port 5181 --strictPort`，headless Chrome 截三页正常态 + 各页一张异常态，存 `docs/design/screens/07-*.png`，和原型截图逐块对比修到一致。收尾 `npm run typecheck`、`npx vite build`。

## Comments

### 做了什么

- **接口与假数据**：`web/src/api.ts` 补齐 `getVersions` / `getDiff` / `getChildren` / `getJobs` / `patchJob` / `runJob` / `getRuns` / `getBackupStatus` / `getCoverage` / `getAffected` / `getBackupRuns` / `runBackup` / `getStorage`。假数据拆成 `fixtures/series.ts`（版本、差异、下层输入）、`fixtures/backup.ts`（来源状态、覆盖、受影响条目、备份记录、存储）、`fixtures/jobs.ts`（7 个任务、运行记录），场景开关挪到 `fixtures/scenario.ts`；`?scenario=empty|error|generating` 对三个新页面同样生效。
- **回顾页 `/review/:level/:period`**：层级分段控件（小时 / 日 / 周 / 月 / 年）、周期前后切换（未来禁用，默认本周）、状态胶囊（进行中 · 截至 10/29 / 最终版 / 上游已变更）；左栏是当前版本的摘要卡（条目带「v4 新增 / v4 修改」、修改条目按 `getDiff` 显示旧文本划掉，上游已变更时整卡带重建确认）、周 → 7 张日结小卡 / 月 → 当月每天 / 年 → 12 个月份小卡（已生成、已并入 vN、未生成、未来、无记录五种状态，点击跳今天页那一天）；日层级下面是「当天小时摘要」，小时层级是这一天的时间线，点小时卡的「版本 ›」切到那个小时的版本历史；右栏版本轨（新 → 旧、选中高亮、最终版标签）、差异框（`items` 逐条 edit / add / delete，`fulltext` 左右两列）、「对比两个版本」弹窗、「重新生成 vN+1」（确认后调 `regenerate`，新版本自动选中）；`?item=<id>` 高亮条目 2 秒。
- **备份页 `/backup`**：三张来源卡（状态胶囊、累计、客户端保留、频率、上次 / 下次，失败时珊瑚色原因加重试，备份中显示「正在读取客户端…」）；覆盖卡带来源分段控件（IM 60 天 / 邮件 120 天 / 日程 60 天）、四色覆盖条、今天描边、悬停日期与客户端 / 本机条数、缺口下方标注、最右 7 格「可补救窗口」括号两种文案、「受影响的摘要 n 条」展开 18 条可点开的降级条目；备份记录表（来源 / 结果筛选、分页、失败与部分成功的原因）、「立即备份」（备份中禁用）、存储卡（总占用、原文、摘要与版本、完整性校验）。
- **任务页 `/tasks`**：更新链路图（原文 → 小时 → 日 → 本周 / 本月 / 本年，右侧备份节点，节点时间取自任务配置）+「次日补跑」回环；24 小时刻度尺（每小时 `:05` 点、补跑 / 备份 / 日结事件、现在竖线）；7 行任务行（开关、名称、说明、可编辑时间规则、上次、下次、立即运行；停用压暗且下次显示「已停用」，运行中显示「运行中…」并禁用）；时间规则浮层按类型编辑，前端按 spec 第 2 节的范围校验（珊瑚色提示 + 保存禁用），后端 400 的 `error` 显示在同一位置；运行记录（按任务 / 结果筛选、分页、点击展开输入 / 产出 / 触发 / 耗时 / 原因，产出的版本可点进回顾页）。
- **组件**：`VersionPanel.tsx`（版本轨、差异框、对比弹窗）、`ChildCards.tsx`（日结小卡 / 月份小卡）、`CoverageBar.tsx`、`BackupSourceCard.tsx`、`TaskChain.tsx`（链路图 + 刻度尺）、`ScheduleEditor.tsx`；`ItemRow` 加回顾页用的 `review` 变体（序号、本版操作、修改前的旧文本）；`Timeline` 加可选的 `title` / `scroll` / `onSelectHour` / `selectedHour`；`format.ts` 补周期名、周期范围、周期前后移动、字节、时长、共同前缀。

### 偏离票的地方和原因

- **选旧版本时左侧摘要卡不换内容**：`api-types.ts` 没有「某个版本的条目」接口（`GET /api/card` 只给当前版本，`GET /api/series/:level/:period/diff` 只给变更行，补不出完整旧版本）。版本轨的选中项只驱动差异框（票里对版本轨的要求就是「选中项高亮 + 差异框 v4 相比 v3」），卡片固定显示当前版本；差异框标题一直写明「vN 相比 vM」，不会误读。
- **小时层级的 URL**：`/review/hour/<hourKey>`（点小时卡）或 `/review/hour/<date>`（从分段控件进来，默认选当天最后一个小时）。票只规定了 `/review/:level/:period`，小时键本身就能从抽屉跳过来，所以这里沿用周期键的写法，只额外容忍一个纯日期。
- **日层级左栏顺序**：摘要卡在上、「当天小时摘要」在下（ui.md 5.3 的顺序），时间线不再自己滚动。
- **备份中不显示「已读取 1,024 条」**：`BackupSourceStatus` 没有进度字段，只能显示「正在读取客户端…」；来源卡的「上次」显示「今天 02:00 · 成功」而不是「· 新增 1,284 条」，因为 `lastRun` 没有新增条数。两处都写进了下面的 api-types 缺口。
- **覆盖卡的可补救窗口文案**按最近 7 天里状态不是 `ok` 的天数算（`coverage.unbackedInWindow` 只统计可补救缺口，装完还没备份过时是 0，会显示「全部已备份」，与事实相反）；两者取大值。
- **备份记录表来源用「IM / 邮件 / 日程」简称**，与原型截图一致；来源卡标题仍是「IM 消息」。
- **第 44 周 v4 相比 v3 多一条删除**：为了让差异框同时演示 edit / add / delete 三种行（原型只有 ~ + +），假数据里 v3 多一条「回滚方案周五前补齐」，v4 删除它；卡片内容仍是原型的 4 条。
- **时间规则的允许范围**只在前端先校验（spec 第 2 节），后端返回 400 时把 `error` 原文显示出来；前端不限制任务类型，类型固定按任务名。
- **备份失败来源卡**（珊瑚色状态 + 原因 + 重试）代码已实现并复用同一套样式，但 `?scenario=error` 走的是接口失败（加载失败 + 重试），所以正常/异常截图里看不到这个状态；真实后端返回 `state: failed` 时就会出现。
- 空态下摘要卡不再显示版本徽标（`fixtureCard` 的 empty 分支清掉 `version`），不然「没有版本」和「v4」会同时出现。

### 需要 api-types 补的地方（本票没有改 src/）

- `GET /api/card` 加 `version` 参数（或 `GET /api/series/:level/:period/versions/:v`），返回某个历史版本的条目、本版操作和证据计数；现在 ui.md 5.3「选中版本轨后左栏换成那个版本的条目」实现不了。
- `BackupSourceStatus` 加 `progress?: { read: number }`（备份中已读取条数）和 `lastRun.added`，备份页才能照 ui.md 5.5 显示「已读取 1,024 条」「上次 · 新增 N 条」。
- `VersionListItem.changes` 里没有「修改了哪几条」，标题里的「修改 1」只能整体计数；差异框已经能逐条显示，暂时不影响。

### 验证

- `npm run typecheck`（根 tsconfig + `web/tsconfig.json`）通过；`npx vite build` 通过（52 modules，338 KB JS / 31.6 KB CSS）。
- 截图（1536×1024，headless Chrome / playwright-cli）：`docs/design/screens/07-review.png`、`07-review-day.png`、`07-review-month.png`、`07-review-year.png`、`07-review-hour.png`、`07-review-version.png`、`07-review-compare.png`、`07-review-regenerate.png`、`07-review-regenerated.png`、`07-review-empty.png`、`07-review-error.png`、`07-review-generating.png`、`07-backup.png`、`07-backup-affected.png`、`07-backup-generating.png`、`07-backup-empty.png`、`07-backup-error.png`、`07-tasks.png`、`07-tasks-schedule-error.png`、`07-tasks-empty.png`、`07-tasks-error.png`。和 `docs/design/prototype/review.png`、`backup.png`、`tasks.png` 逐块对比过（标题区、卡片栅格、版本轨、差异框、日结小卡、覆盖条、表格、刻度尺、任务行）。
- 用 playwright-cli 实际操作过：层级分段控件与前后周期（未来按钮禁用、切到第 43 周）、版本轨选中 v3 后差异框变「v3 相比 v2」、对比两个版本弹窗（A/B 下拉）、重新生成 v5（确认框 → 卡片与版本轨都变 v5 → 全量左右对比）、`?item=2` 高亮 2 秒后消失、条目点开证据抽屉（「本周至今 · v4 · 第 1 条」）、日 / 月 / 年 / 小时四个层级、备份页切邮件来源（120 天）、展开 18 条受影响的摘要、备份分页、任务开关（压暗 + 下次显示已停用）、时间规则浮层把日结改成 03 点（珊瑚色提示 + 保存禁用）、改成 21:30 保存后「下次运行」立即变今天 21:30、运行记录展开详情与产出里的版本链接、`generating` 场景下小时摘要行「运行中…」且按钮禁用、`empty` / `error` / `generating` 三个场景在三个页面都试过。
- 不依赖后端：`?fixtures=1` 下三页所有交互可用；正常态首屏有 300ms 骨架。

### 遗留

- 搜索、设置页仍是占位（08 票）。
- 非 fixtures 模式下这些接口要等后端（票 01–05）提供，前端不用改。
