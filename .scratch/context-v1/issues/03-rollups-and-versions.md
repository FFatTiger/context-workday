Status: resolved
Blocked by: 02

# 03 日结、周月年增量、补跑、收尾、版本与对比

先读：`AGENTS.md`、`CONTEXT.md`、ADR 0001、spec 第 4、5、6、8 节和第 13 节的 2、5、6、7、8、9、21，`src/llm/types.ts`（`RollupInput`、`RollupOp`）。复用 02 票的 `src/summary/store.ts`、`hourly.ts`、`evidence.ts`（`itemView`）。

## 范围

- `src/summary/rollup.ts`、`src/summary/diff.ts`
- `src/server/routes/summary.ts`（卡片、版本、对比、下层输入、重新生成、立即生成日结），`/api/status` 的 `daily` 部分
- 测试：`test/rollup.test.ts`、`test/diff.test.ts`

## 步骤

### 1/4 日结 `runDaily(ctx, dayKey, trigger)`（spec 第 4 节，按 1–7 步照做）

- 第 1 步调 02 票的 `pendingHours` / `runHour`（只跑这一天的）。
- 迟到核对：对当天每个已有版本的小时，用和 `runHour` 相同的口径重新数与我有关的原文，比版本里的 `related_msgs` 多就 `runHour(ctx, key, 'late')`。把"数与我有关的原文"抽成 `hourly.ts` 里的一个导出函数复用，不要复制口径代码。
- 全量 / 增量：没有日结 → `rollupFull`，引用当天各小时当前版本的条目；已有 → 只把"上次日结 inputs 之后新出的小时版本"作为输入做 `rollupIncremental`；没有新输入跳过。上限 6。
- 增量结果的落库规则（日、周、月、年通用，写成一个函数）：keep 原样带旧引用；edit 换文本、保留旧引用并追加新引用（`is_new=1`）；delete 不写入新版本；add 分配新编号、必须引用本次输入，否则丢弃；`ref` 不在本次输入里的引用去掉；超上限带提示重试一次，仍超按顺序截断。
- 然后增量更新本周、本月（第 2 步），运行记录说明形如"生成 日结 v1 · 本周 v4 · 本月 v16"。**本函数写 task_runs**（job='daily'）。

### 2/4 周、月、年（spec 第 5、6 节）

- `updatePeriod(ctx, level: 'week'|'month', period, newDayVersions, trigger)`：增量；已收尾的周期不再增量（只标上游已变更）。
- `runCatchup(ctx, dayKey)`（补跑，job='catchup'）：前一天日结之后有新的小时版本 → 日结增量 + 周月增量；前一天是周日 → 收尾上周；月末 → 收尾上月。
- `closePeriod(ctx, level, period)`：用周期内全部日结的最新版本全量生成，`is_final=1`，trigger='close'。
- `runYearly(ctx, monthKey)`（job='yearly'）：上个月没收尾先收尾，然后用上个月最终版的条目对本年增量。1 月 1 日并入 12 月后那一版标最终版。
- `regenerate(ctx, level, period)`：spec 13.8，校验不在未来、不在生成中；一律全量，用最新下层版本；日结及以上走 `rollupFull`，小时走 `runHour`。

### 3/4 对比 `diff.ts`

spec 8：同一增量链（两个版本都不是 full，或者 b 是 a 之后的增量）→ 按编号逐条 edit / add / delete / same；任一版本是全量 → `fulltext`。版本列表的 `changes` 计数和 `inputNote`（"并入周四日结"、"收尾"、"手动重建"）也在这里算。

### 4/4 接口

`api-types.ts` 的 2（`date` 推周期；`rangeLabel`；未生成时 `scheduledAt` 取日结默认 20:30，04 票接配置；`inputCount`；日结 `dayStats`）、5、6、7（周 → 7 天，月 → 当月每天，年 → 12 个月；`mergedIn`）、8（补齐非小时层级）、9；`/api/status` 的 `daily`。

补充（07 票提出）：卡片接口支持 `version=N` 参数，返回该历史版本的条目、本版操作和计数；也要支持 `level=hour`。

顺带修 02 票留下的两处（属于本票范围）：
- 时间线 `activity`：有小时版本的小时用版本里的 `related_msgs`，没有版本的才用本机备份计数。现在今天的活动条要等第二天备份后才有，主视图会是空的。
- `/api/evidence` 在客户端不可用时不要 500：反查客户端失败（抛错）时，这条原文按便宜规则判定（保留期内视为可用、显示为一个只有 ID 的"原文暂不可读 · 客户端未连接"节点，不写 `raw_lost`）。需要的话在 `EvidenceNode` 的 `lost` 里加一个 `reason: 'client_unavailable'`，并在 Comments 说明，前端票会跟进。

## 测试（`npx vitest run test/rollup.test.ts test/diff.test.ts`）

假客户端 + 脚本化假摘要器 + `ManualClock`。必测 spec 测试 4、5、6、7、8，以及：增量里 add 没引用本次输入被丢弃；已收尾周期不再增量；年摘要只用最终版月摘要。

## 验收

测试全过，`npm run typecheck` 通过。端口 4403 起 `--demo`，跑一次备份 + `POST /api/daily/run`，`curl` 卡片、版本列表、对比、下层输入，结果摘要贴进 Comments。

## Comments

### 做了什么（2026-11-01）

提交：`a717db0`（claimed）、`53045db`（hourly 抽出 gatherHourInput）、`bc9caad`（rollup）、`982aaf2`（diff）、`855df1b`（接口）、`3872fea`（测试）、`0ce1db4`（客户端不可用修复）、`b2a4dc0`（收尾）。（期间同库并行会话提交了 17b6fcf 票 05 拆分，与本票无冲突）

1. **hourly.ts**：把“读客户端 → 口径筛选 → 降噪 → 数与我有关的原文”抽成导出的 `gatherHourInput`，`runHour` 和日结的迟到核对共用同一套口径，不复制判定代码。
2. **rollup.ts**：
   - `runDaily`（job=daily，自写 task_runs）：先跑当天待处理小时 → 迟到核对（重数比版本 related_msgs 多就 `runHour('late')`）→ 无小时摘要则跳过 → 首次 `rollupFull`（上限 6）/已有则只把“上次 inputs 之后新出的小时版本”做增量、无新输入跳过 → 增量更新本周本月 → 运行记录“生成 日结 v1 · 本周 v4 · 本月 v16”（带“迟到重跑 N 个小时”“N 个小时生成失败”前缀）。
   - 增量落库规则写成通用的 `applyIncrementalOps`：keep 原样带旧引用；edit 换文本、保留旧引用并追加本次输入内的新引用（追加时去重）；delete 不写入；add 分配新编号、必须引用本次输入否则丢弃；不在本次输入里的引用去掉；超上限带提示重试一次，仍超按顺序截断。
   - `updatePeriod`（周/月增量）：已收尾只标上游已变更不再增量；`runCatchup`（job=catchup）：前一天有新小时版本才日结增量+周月增量，前一天周日/月末收尾；`closePeriod`：全量+is_final；`runYearly`（job=yearly）：先收尾上月，再用上月最终版条目对本年增量，1 月并入 12 月后那版标最终版；`regenerate`：校验未来/生成中，一律全量用最新下层版本（小时走 runHour），已收尾周期重建仍是最终版。
   - 版本的 `inputs` 记录**本版条目引用到的全部下层版本**（不只是本次新输入），这样 store 的上游已变更标记对任何被引用下层都准确；“新出的小时版本”按“inputs 里没有该系列或版本号更低”判定。
   - 另导出 `dailyStatus`（/api/status 的 daily）、`nextDailyRunAt`（日结默认 20:30、补跑 00:30）、`scheduledAtFor`、`dayStats`。
3. **diff.ts**：`diffVersions`——同一增量链（(a,b] 全为增量）按编号逐条 edit/add/delete/same，任一全量则 `fulltext`；`versionChanges`（版本列表变更计数，全量重建的新编号天然表现为全加全删）；`inputNote`（“并入周四日结”“收尾”“手动重建”“首次生成”，>2 份用“并入 N 份”）。
4. **接口 routes/summary.ts**（挂到 app.ts）：卡片（date 推周期、rangeLabel、未生成 scheduledAt、inputCount=引用的下层系列数、日结 dayStats=当天各小时当前版本统计之和、version=N 看历史版本、支持 level=hour，07 票要求）、版本列表（新→旧+changes+inputNote）、对比（a/b 自动排序）、下层输入（周→7 天/月→当月每天/年→12 个月，state ok/none/future/empty + preview 前 2 条 + mergedIn + 今天的 scheduledAt）、重新生成（从 timeline.ts 移来，小时级保持 02 票行为）、`POST /api/daily/run`（并发 409）。`/api/status` 的 daily 接 `dailyStatus`。
5. **顺带修 02 遗留两处**：时间线 activity 有小时版本的小时用版本 related_msgs，无版本才用本机备份计数（今天的活动条不再空白）；`/api/evidence` 反查客户端抛 SourceUnavailableError 时不再 500——保留期内按可用处理，返回新节点类型 `{kind:'unreadable'}`（只有 ID，前端显示“原文暂不可读 · 客户端未连接”），不写 raw_lost、不计降级；`meId` 在客户端不可用且 meta 无缓存时返回空串（只影响 isMine）。

### 偏离票的地方

- “原文暂不可读”没有用票面建议的“lost 节点加 reason: client_unavailable”，而是加了独立的 `EvidenceNode` 变体 `{kind:'unreadable'}`：它语义上不是丢失（保留期内视为可用、不降级、不写 raw_lost），挂进 LostReason 会污染 /affected、coverage 的降级计数。前端票跟进时注意这个新节点类型。
- 版本 inputs 记录全部被引用下层（非仅本次新输入），理由见上；副作用是周月的 keep 条目旧引用对应的小时也在 inputs 里，inputNote 会对 3 份以上输入显示“并入 N 份小时摘要”（如 17 点重跑后的日结增量）。
- `versionChanges` 对全量重建版本记为“全加全删”（新编号与旧编号无交集的自然结果），没有另做“重建”特例。
- 未生成卡片的 scheduledAt：今天/未来周期按日结 20:30（未来周期取该周期首日 20:30）、本周本月取下一次日结/补跑、年取下月 1 日 03:00、已完全过去的周期 state=empty 无 scheduledAt。

### 测试结果

- `npm run typecheck` 通过；`npx vitest run` → **8 文件 82 用例全过**（本票 rollup 21 + diff 8 + evidence 补 1，票 01/02 无回归）。
- 必测覆盖：spec 4（迟到重跑→日结引用小时 v2）、5（编号不变、edit 旧引用保留+追加新引用、delete 不写入、无引用 add 丢弃）、6（日结后新小时才产生日结 v2 且周月各 +1，无新内容跳过）、7（周一凌晨收尾上周最终版、月末收尾+年摘要只用最终版月摘要、1 月并入 12 月标最终版）、8（下层重跑标记出现、上层重建后消失）。
- 验收（端口 4403，mktemp 数据目录，--demo）：
  - `POST /api/backup/run` 三源 success（8 天/153 场/274 封）；`/api/status` daily none→scheduledAt 当晚 20:30；
  - `POST /api/daily/run` → `success “生成 日结 v1 · 本周 v1 · 本月 v1”`（11-01 周日，3 个小时摘要）；
  - 日结卡片：dayStats {totalMsgs:14, relatedMsgs:4, hours:3}，3 条目各 evidence 1；本周卡片 rangeLabel “10/26 – 11/01”；
  - `POST /api/series/hour/2026-11-01T17/regenerate` → 小时 v2，日结卡片 upstreamChanged=true；再跑日结 → “生成 日结 v2 · 本周 v2 · 本月 v2”，日结版本列表 v2 incremental·“并入 3 份小时摘要”，diff v1→v2 items 模式全 same（确定性 mock 重跑文本不变）；
  - 下层输入：周日 11/01 ok+mergedIn:1，其余 6 天 empty；
  - 一次性脚本验证补跑收尾：周一凌晨 `runCatchup('2026-11-01')` → “收尾第 44 周 v3”，W44 is_final=1，版本列表 v3 trigger=close·“收尾”·changes 全加全删；`runYearly('2026-10')` 无内容正确 skipped；证据链 日结条目→小时条目→原文 path “第 44 周 v3 › 今天”。

### 遗留

- 卡片/版本列表/对比/下层输入的前端页面：票 06/07。
- `unreadable` 节点的展示样式：前端票。
- jobs 表的调度（daily 20:30、catchup 00:30、yearly 每月 1 日 03:00 目前只在函数与 scheduledAt 计算里写死）：票 04 接配置后 `nextDailyRunAt`/`nextYearlyRunAt`/`scheduledAtFor` 换成读任务配置。
- mock 增量摘要器对“重跑后内容不变”的输入会输出同文本 edit，diff 显示 same；真实模型下不会这么整齐。
