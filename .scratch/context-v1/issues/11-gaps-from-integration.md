Status: resolved

# 11 收口：走查发现的四个规则缺口

10 票末尾的 Comments"需要产品/后续票决定的问题"列了四条，规则已定如下，照做。先读 10 票 Comments、spec 第 4、7、9 节，`src/backup/coverage.ts`、`src/jobs/registry.ts`、`src/summary/rollup.ts`、`src/summary/evidence.ts`、`src/api-types.ts`。

## 1/4 备份时间之前不算缺口

规则：某一天在"该天结束后的第一次 IM 备份计划时间"之前，不判缺口，状态为新的 `pending`（等待备份）。例如 02:00 备份：11/01 这一天在 11/02 02:00 之前是 `pending`；今天始终是 `pending`（除非已经有当天的核对记录且一致，那就是 `ok`）。备份计划时间读任务配置（`rules.ts`）。邮件、日程同理用各自的任务。

- `api-types.ts`：`CoverageState` 加 `'pending'`；告警和 `unbackedInWindow` 不计 `pending`。
- 前端覆盖条：`pending` 画成浅灰底 + 虚线描边，悬停"等待 HH:MM 备份"；图例加一项"等待备份"。
- 测试：00:30 时昨天和今天都不是缺口、无告警；02:30 时如果 02:00 那次备份失败，昨天变成"缺口·可补救"、出现告警。

## 2/4 补跑处理"有小时摘要、没有日结"的日子

规则：补跑任务（00:30）在处理昨天之前，先找出过去 7 天里（不含今天、不含昨天）**有小时摘要版本但日结系列没有成功版本**的日子，按时间先后对每一天执行日结流程（`runDaily(ctx, day, 'catchup')`，会顺带增量更新那一周、那一月；已收尾的周期按现有规则只标上游已变更）。启动补跑时同样检查一次。

- 测试：造一个"10/13–10/15 只有小时摘要"的库，跑一次补跑，三天各出现日结 v1，所在周、月各多出版本；已收尾的周只被标上游已变更。

## 3/4 同一小时条目的多条丢失原文合并成一个降级框

规则（ADR-0002：降级停在小时条目）：一个小时条目下，只要有原文丢失，证据树里**只出一个降级框**（文本 = 该小时条目、生成时间、丢失原因、"N 条原文已丢失"），其余**可用**原文照常列出。丢失原因不一时，取最先判定的那个并写"等 N 条"。

- `api-types.ts`：`lost` 节点加 `count: number`（合并的条数）、`text: string`、`generatedAt: number`；`EvidenceResponse.item` 加 `degraded?: { generatedAt: number; reason: LostReason; count: number }`（根条目本身是降级的小时条目时）。
- `evidence.ts` 按新形状输出；前端 `Drawer` 用新字段渲染（去掉 10 票里"靠 totals 兜底判断"的写法），降级框里显示"N 条原文已丢失"。
- 测试：一个小时条目引用 3 条原文、丢 2 条 → 树里 1 个 lost 节点（count=2）+ 1 个 im 节点。

## 4/4 收尾

`npm run typecheck`、`npm test`、`npm run build` 通过。用 `npx tsx src/cli.ts sim --days 30 --data <tmp>` + `start --demo --port 4411` 验证：00:00–02:00 之间（用 sim 结束时刻不好控，可以写一次性脚本调 coverage 函数传 ManualClock）无假告警；`/api/evidence` 对一个多原文丢失的条目只返回一个 lost 节点。截一张抽屉降级框的图存 `docs/design/screens/11-drawer-degraded.png`（headless Chrome，前端用 `npm run build` 后由 4411 直接提供）。

## Comments

### 做了什么（2026-11-02）

提交：`2113d44`（claimed）、`15b35e4`（1/4 pending）、`f96d34f`（2/4 补日结）、`2b9742b`（3/4 合并降级框）、`3b48cbe`（收尾小修 + 全量验证）、`<收尾提交>`（截图、报告）。

**1/4 备份时间之前不算缺口**
- `dayState` 判断顺序：整天核对一致 → ok；安装前无数据 → no_data；核对出过不一致 → 真缺口（不等计划时间，保持“检出即告”）；未到“该天结束后的第一次备份计划时间” → pending；之后才是可补救/已过期。计划时间用 `nextRun(任务规则)` 计算，邮件/日程各读各的任务（邮件周日 03:00，周三的缺口要等到下周日才判）。
- ok 的口径比旧代码严了一档：核对记录一致且**覆盖了整天**才算 ok（记录的运行开始时间 ≥ 当天结束）；只有今天例外——今天只能核对一部分，一致就算 ok。副作用：旧代码里“只核对过当天前半夜、之后备份一直没跑成”的日子会永远显示 ok，现在过了计划时间会正确地变成可补救缺口（测试“缺口超过保留期”的 daysLeft 断言从 2 改为 1，就是这个场景）。
- `CoverageResponse` 加 `rule`（该来源备份任务的时间规则）；告警和 `unbackedInWindow` 不计 pending。前端覆盖条 pending = 浅灰底 + 虚线描边，悬停“等待 HH:MM 备份”（每天/每周/每月规则分别显示 02:00 / 周日 03:00 / 1 日 03:00），图例加“等待备份”，7 天窗口标签的未备份数不再把 pending 算进去。

**2/4 补跑先补没有日结的日子**
- `rollup.ts` 新增 `backfillMissingDailies(ctx)`：窗口 today-7 … today-2（不含今昨），有小时摘要版本且日结系列 current_version=0 的日子按时间先后逐天 `runDaily(ctx, day, 'catchup')`；周月的增量更新、收尾都由 runDaily/updatePeriod 现有逻辑顺带完成。`catchupDef.execute` 在处理昨天之前先跑这一步，定时和启动补跑共用同一条路径。
- `runDaily` 的触发方式加 `'catchup'`：版本的 trigger 记“补跑”，task_runs 的 trigger 记“定时”（TaskRun.trigger 合同没有补跑这一项，没改它）。
- 已收尾周期的“上游已变更”从“只看引用”改为**按周期包含判断**：补出来的日结是新系列，旧收尾版本不可能引用过它，按引用判断永远标不到；按包含判断后补出的日结落在已收尾周里也会标（更符合 spec 第 5 节“下层又出了新版本就标”）。原引用判断是这个判断的子集，现有测试不受影响。

**3/4 同一小时条目多条丢失原文合并成一个降级框**
- `lost` 节点带 `count`/`text`/`generatedAt`（原因不同加 `mixedReasons: true`，取最先判定那条的原因）；`item` 节点的 `degraded` 补了 `count`；`EvidenceResponse.item` 加 `degraded`（根条目自己就是降级小时条目时）。
- 证据树里丢失原文先合并成一个框（不占 50 条预算），可用原文照常列出；展开上层时小时条目下同样只出一个框。`rawNode` 收窄为只渲染可用原文（丢失分支改抛错，调用方已过滤，防形状静默不完整）。
- 前端降级框：“N 条原文已丢失 · 降级为 AI 当时概述”，正文用小时条目文本，原因不同时“… 等 N 条”；删掉了 10 票里靠父节点/根条目兜底的写法。

### 测试结果

- `npm run typecheck`（根 + web）：通过。
- `npm test`：**13 文件 125 用例全过**（新增 6 例：pending 两例、补日结四例、合并降级框两例；改了一例旧断言，见上）。中途一次失败是测试自己的引用键写错（模型引用键是 m1/m2/c1 不是原文 ID），修正后全绿。
- `npm run build`：通过。
- 真机：`sim --days 30`（降级小时条目 3 个）→ `node dist/cli.mjs start --demo --port 4411`。一次性脚本（ManualClock 拨 sim 库）：00:46 和 01:30 时 IM/邮件的昨天、今天都是 pending，`alerts=[]`（旧代码这里会报“IM 备份失败 · 还剩 7 天可补救”）；02:30（假如 02:00 备份没跑成）昨天变 gap_recoverable、告警 daysLeft=6，今天仍 pending。`/api/evidence` 对 2026-10-03T10（2 条原文全丢）只返回 1 个 lost 节点（count=2）+ item.degraded；日结展开到小时同样 1 个 lost:2。备份页 UI：覆盖格 2 格 pending，悬停“11/01 · 等待 02:00 备份”，7 天窗口显示“全部已备份 ✓”，无告警横幅，0 控制台错误。截图 `docs/design/screens/11-drawer-degraded.png`（1536×1024，playwright 驱动系统 Chrome）。注：`npx tsx src/cli.ts start` 解析的 webDir 是 `src/web/`（不存在），要由打包后的 `dist/cli.mjs` 提供前端，票里“由 4411 直接提供”按此理解。

### 偏离票的地方和原因

- “今天始终是 pending（除非已经有当天的核对记录且一致）”落地为：**一致即 ok**（哪怕记录只覆盖了当天一部分）；而昨天及更早的日子要求记录覆盖整天才算 ok，否则在计划时间前是 pending。这样“02:00 备份失败后昨天变缺口”才成立（昨天的部分核对记录不能把它钉死在 ok 上）。
- “已收尾的周只被标上游已变更”：按现有引用规则这个标记在补日结场景永远不可能触发（旧收尾版本没引用过新系列），改成按周期包含判断，见上。
- 补跑窗口“过去 7 天（不含今昨）”取 today-7 … today-2 共 6 天；票里没写开闭边界，按包含两端落地。
- spec.md 第 9 节的覆盖状态、第 5 节的补跑描述没有同步更新（票没要求改文档），本票规则以本文为准，后续如需可另开票补文档。

### 遗留问题

- 无。所有自己起的进程已结束、临时目录已删、`git status` 干净。
