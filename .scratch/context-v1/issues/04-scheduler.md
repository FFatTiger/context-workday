Status: resolved
Blocked by: 03

# 04 定时任务、启动补跑、运行记录

先读：`AGENTS.md`、spec 第 2 节、第 9 节的重试规则、第 13 节的 10–13、`src/api-types.ts`（`Job`、`ScheduleRule`、`TaskRun`）、`src/db/schema.ts`（`jobs`、`task_runs`）。复用 `hourly.ts`（`pendingHours`、`runHour`）、`rollup.ts`（`runDaily`、`runCatchup`、`runYearly`）、`backup/`（`runBackup`、`needsRetry`）。

## 范围

- `src/jobs/rules.ts`（默认规则、校验、下次运行时间）、`src/jobs/scheduler.ts`（替换桩）、`src/jobs/registry.ts`（7 个任务的名字、标题、说明、执行函数）
- `src/server/routes/jobs.ts`；把 02、03 票里写死的"下一个 :05""20:30"和 01 票备份状态里写死的规则，改成读任务配置（调用 `rules.ts`）
- 测试：`test/scheduler.test.ts`

## 要点

- 默认规则和允许范围照 spec 第 2 节的表。校验不通过返回中文提示（"日结时间需在 12:00 到 23:59 之间"）。年摘要的日期 1–28。
- `nextRun(rule, now)`：上海时区，用 `src/time.ts`。
- 调度器：`startScheduler(ctx, {intervalMs})` 返回 `{ stop(), tick(): Promise<void> }`。`tick()` 检查到期任务并依次执行（同一任务同一时刻只一个实例；不同任务可以并发，但摘要类任务之间串行更安全——用一个摘要队列）。定时器只负责周期性调用 `tick()`，所以 sim 和测试可以不用定时器、直接拨 `ManualClock` 再 `await tick()`。
- 每个任务按"待处理清单"工作：小时摘要跑 `pendingHours`；日结跑今天；补跑跑昨天；年摘要跑上个月；备份任务跑一次备份。备份失败或部分成功后，每小时整点后自动 `trigger='retry'` 重跑，直到成功。
- 启动：先把 `task_runs` 里 `running` 的记为 `interrupted`（`backup_runs` 同理）；然后每个启用的任务立即检查一次待处理清单，trigger='startup'（spec 验收：错过的小时摘要按时间顺序补齐，触发方式"启动补跑"）。日结和补跑在启动时：如果今天的日结时间已过且今天没有日结 → 跑日结；昨天的补跑没跑过且已过补跑时间 → 跑补跑。
- 停用的任务不再定时运行，`nextRunAt=null`；立即运行仍允许。
- 接口：`GET /api/jobs`、`PATCH /api/jobs/:name`、`POST /api/jobs/:name/run`（正在运行 409）、`GET /api/runs`（按 job、result 筛选，分页 50）。`Job.lastRun`、`running` 从 `task_runs` 算。
- 任务表首次启动时写入默认规则。

补充（07 票提出）：`BackupSourceStatus.lastRun.added`（上次新增条数）和备份进行中的 `progress.read`（`runBackup` 在内存里更新一个进度计数，状态接口读它）。这两个字段在 01 票的备份模块里补，属于本票范围。

03 票留下的写死时间（`rollup.ts` 里的 `nextDailyRunAt` / `nextYearlyRunAt` / `scheduledAtFor`，`routes/backup.ts` 里自带的一份 nextRun 计算，`routes/timeline.ts` 的 nextHourlyAt）全部改成调用 `rules.ts` 读任务配置，删掉重复实现。

## 测试（`npx vitest run test/scheduler.test.ts`）

- 规则校验和 `nextRun`（跨天、跨月、周日、闰年 2 月不需要——日期上限 28）。
- spec 测试 11：`ManualClock` 模拟睡眠 3 小时后启动，3 个小时摘要按先后补齐，触发方式是 startup；超过 7 天的小时不追。
- 同一任务并发调用 `run` 第二次被拒；停用后到点不跑；备份失败后下一个整点重试。

## 验收

测试全过，`npm run typecheck` 通过。端口 4404 起 `--demo`，`GET /api/jobs`、`PATCH` 一个非法时间、`POST run`，结果贴进 Comments。

## Comments

### 做了什么（2026-11-01）

提交：`76e371b`（claimed）、`9ea68fc`（调度核心）、`8c4227e`（测试）、`a41a216`（进度计数单测）、报告随最后提交。

1. **`src/jobs/rules.ts`**：7 个任务的默认规则（照 spec 第 2 节的表，有单测锁住）；`validateRule` 按任务允许范围校验（小时摘要 1–30 分、日结 12:00–23:59、补跑 00:00–05:59、年摘要每月 1–28 日、备份任意但格式合法），中文提示如"日结时间需在 12:00 到 23:59 之间"；`nextRun`/`prevRun`（上海时区，严格晚于 now / 不晚于 now，跨天、跨周、跨月、2 月 28 日都有用例；prevRun 供启动时判断"最近一次计划运行是否错过"）；jobs 表读写（`ensureJobs` 首次写默认、`saveJob` 保存后重算下次、停用置 null、`recordJobRan` 跑完更新 last/next、`getJobRule` 缺行时回落默认）。
2. **`src/jobs/registry.ts`**：7 个任务的名字、标题、说明、执行函数。小时摘要走 `pendingHours` → 逐个 `runHour`；日结今天、补跑昨天、年摘要上个月；备份任务包一层 task_runs（结果映射：success→success、partial/failed→failed，note 写"部分成功：10/27、10/28 核对不一致"或"新增 N 条"）。`JobRunner`：同一任务互斥（inflight），摘要类任务共用串行队列（gate），每个 Ctx 一个实例（WeakMap），调度器和路由拿到同一个。
3. **`src/jobs/scheduler.ts`**（替换桩）：`startScheduler(ctx, {intervalMs=60s})` 返回 `{stop, tick}`，定时器 unref、只周期调 tick，测试/sim 直接拨 ManualClock 后 `await tick()`。构造时：`ensureJobs` → `markInterrupted`（task_runs 里 running→interrupted；backup_runs 同理记 failed+"程序退出时中断"）→ 后台跑一次启动补跑（trigger='startup'）；`tick()` 先等启动补跑完成再查到期任务。启动补跑按票面：小时摘要追待处理清单；日结=今天日结时间已过且今天没有日结；补跑=已过补跑时间且昨天没跑过；年摘要=最近一次计划运行的目标月份与"现在该处理的月份"一致且没跑过；备份=最近一次计划运行时刻之后没有任何运行记录。备份失败/部分成功：进入新的小时后自动 trigger='retry' 重跑直到成功（用 hourKey(now)≠hourKey(上次运行) 判断"过了整点"）。
4. **接口 `src/server/routes/jobs.ts`**（挂到 app.ts）：`GET /api/jobs`（running/lastRun 从 task_runs 算，lastRun 取最近一条非 running）、`PATCH /api/jobs/:name`（校验→保存→重算下次，不合法 400）、`POST /api/jobs/:name/run`（正在运行 409，返回 {runId}，停用的任务也允许）、`GET /api/runs`（job/result 筛选，分页 50）。
5. **写死时间全部改接配置**：`rollup.ts` 的 `nextDailyRunAt`/`nextYearlyRunAt`/`scheduledAtFor` 签名改为带 db、从 jobs 表读（日结/补跑/年摘要规则）；`routes/timeline.ts` 的 nextHourlyAt 改 `nextRun(hourly 规则)`；`routes/backup.ts` 删掉自带的 DEFAULT_RULES + nextRunAt 一份实现，改读 jobs 表，停用的备份任务 nextRunAt=null；`startRun` 从 rollup 导出供 registry 复用（不再复制）；`runCatchup` 的 trigger 加 'manual'。
6. **07 票补充的两字段**：`BackupSourceStatus.lastRun.added` 已有（01 票就在）；`progress.read` 在 `backup/run.ts` 加内存计数（每次运行重置，主读 + 逐日核对累计），状态接口仅在该源 running 时返回。`POST /api/backup/run` 改走 JobRunner（写 task_runs），手动立即备份也进 Job.lastRun 和 /api/runs。
7. **测试 `test/scheduler.test.ts` 16 例**：规则校验（各任务边界+错误文案）、nextRun/prevRun（跨天/跨周/跨月/2 月 28 日/恰在点上）、jobs 表默认与停用重算、spec 测试 11（3 个小时按先后补齐、trigger=startup、8 天前不追、14:05 不跑日结）、中断标记、同一任务并发被拒、停用后到点不跑（含启用后按计划跑的对照组）、备份失败同整点不重试/下个整点 trigger=retry/成功后不再重试、备份进度计数。

### 偏离票的地方

- 小时摘要任务除了 `runHour` 自己写的逐小时记录外，另写一条任务级聚合记录（target="N 个小时"，特意不与小时周期键同形，避免被 `pendingHours` 误认成已处理）；`POST /api/jobs/hourly/run` 返回该聚合行的 runId。/api/runs?job=hourly 会同时看到两类记录。
- 备份部分成功在 task_runs 里记为 failed（note 注明"部分成功"）：TaskRun.result 没有 partial，且部分成功本就该触发每小时重试。
- `markInterrupted` 对 backup_runs 记 failed+错误文案，不用 interrupted：BackupRun.result 的合同值没有 interrupted。
- 年摘要启动补跑的"错过"判定多了一个目标月份一致性条件：月初 03:00 前后 prevRun 的目标月会从上月跳到本月，避免误触发。
- `progress.read` 在 mock 数据源下备份太快，验收时没能在线抓到运行中的值（返回 state=ok、progress=null），计数行为用单测锁住。

### 测试结果

- `npm run typecheck` 通过；`npx vitest run test/scheduler.test.ts` → **16 例全过**；全量 `npx vitest run` → **9 文件 97 例全过**（本票 16 + 前 81，无回归）。

### 验收（端口 4404，mktemp 数据目录，`--demo`，跑完已 kill、无残留进程）

- 启动即完成启动补跑：`GET /api/jobs` 7 个任务齐全（标题/说明/启用/下次运行都对），启动时错过的一批任务全部跑完：backup_im `startup` 新增 1265 条、catchup 10-31 `日结 v1 · 本周 v2 · 10 月 v1 · 收尾10 月 v2`、daily 11-01 `生成 日结 v1 · 本周 v1 · 本月 v1`、yearly `2026 年 v1`。
- `PATCH /api/jobs/daily` 改 03:00 → 400 `{"error":"日结时间需在 12:00 到 23:59 之间"}`；yearly 改 30 日 → 400 `{"error":"年摘要日期需在 1 到 28 日之间"}`；日结改 21:00 → 下次运行立即变为明天 21:00，改回 20:30 同步更新。
- `POST /api/jobs/backup_im/run` → `{"runId":176}`，/api/runs 里该记录 `manual success 新增 0 条`（启动时已备满）。
- `GET /api/runs?result=success` 分页 50（total=73），outputs 带产出版本（如 catchup 的 4 个版本）。
- `GET /api/backup/status`：rule/nextRunAt 从任务配置来（im/calendar 明天 02:00、邮件下周日 03:00），`lastRun.added` 有值，非运行中 progress=null。
- 时间线跟随配置：PATCH hourly 改第 10 分后 `nextHourlyAt` 变为本小时 :10，改回 5 后变为下一小时 :05；PATCH catchup 停用后 `nextRunAt=null`（已恢复）。

### 遗留

- 任务页、运行记录页的前端（06/07 票）；`Job.running` 在日结执行中会因逐小时 runHour 短暂为 true（如实反映在做小时摘要）。
- progress 是同进程内存计数，不跨进程（单机单进程设计内没问题）。
- sim/打包（09 票）会用 `tick()`，本票已保证无定时器也可拨钟驱动。
