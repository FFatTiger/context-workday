Status: resolved
Blocked by: 04, 05

# 09 sim（演示历史）和打包

先读：`AGENTS.md`、01–05 票末尾的 Comments，`src/main.ts`、`src/source/mock.ts`、`src/jobs/scheduler.ts`、`docs/intranet.md`。

## 范围

`src/sim.ts`、`src/main.ts`（只在需要时小改）、`package.json` 的 scripts/files、`examples/`（已有，不要改内容，只确认进了包），测试 `test/sim.test.ts`。

## 步骤

### 1/2 sim

`context-workday sim --days 45 [--data 目录] [--force]`：
- 只允许 mock 数据源（否则报错退出）；已有数据的目录拒绝运行，除非 `--force`。
- 用 `ManualClock` 从 `now - days` 的 0 点开始，自己组装 `Ctx`（虚拟时钟传给 mock 数据源的 `ctx.now`，摘要器用 mock），启动调度器但不用定时器：每次拨 1 小时、`await scheduler.tick()`，直到真实的现在；每过一天打印一行进度（日期、本日版本数）。
- 演示降级：第 `days-20` 到 `days-11` 天之间让 IM 备份失败——sim 内部包一层数据源，这段时间里跨度超过 2 小时的 `messages()` 调用抛 `SourceUnavailableError`，小时摘要的 1 小时查询不受影响（写注释说明这是演示手段）。这样备份页有一段"已过期"的红色缺口，对应日子的小时条目在证据链里显示降级。
- 结束后打印：各层级版本数、最终版数、降级小时条目数、耗时。45 天应在 1 分钟内跑完（mock 摘要器）。
- 结束时数据库就是一份正常的数据目录：之后 `context-workday start --demo --data 同一目录` 能直接接着用（调度器启动补跑把 sim 结束到真实现在之间的空隙补上）。

测试：`sim` 跑 10 天（测试里可以直接调导出的函数、传入较小的天数），断言有小时/日/周版本、有至少一个最终版周摘要、有降级条目、备份覆盖里有 `gap_expired`。

### 2/2 打包

- `package.json` 的 `files` 包含 `dist`、`docs/intranet.md`、`examples`、`src/source/types.ts`（内网对照合同用）。
- `npm run pack:intranet` 产出 tgz。验证（写进 Comments，命令和输出摘要）：
  1. `P=$(mktemp -d); npm i -g --prefix $P ./context-workday-*.tgz`；
  2. `$P/bin/context-workday --help`；
  3. `$P/bin/context-workday sim --days 20 --data $D`（`D=$(mktemp -d)`）；
  4. `$P/bin/context-workday start --demo --port 4409 --data $D &`，`curl` 首页（返回 HTML）、`/api/status`、`/api/timeline?date=<今天>`、`/api/card?level=week&date=<今天>`；
  5. `$P/bin/context-workday doctor --data $D`（mock 源，全部 ✓）；
  6. 用 `examples/im-source/` 复制一份到 `$D/source/`、把 TODO 用最少的假数据填上（不提交），`config.json` 指向它，`doctor` 能加载并报告——验证"外部模块加载"这条路是通的。
  7. 关掉服务，删临时目录。

## 验收

`npm run typecheck`、`npm test`、`npm run build` 通过；打包验证 1–7 通过。

## Comments

### 做了什么（2026-11-01）

提交：`f7a7b70`（claimed）、`442b80c`（sim + 404 修复 + 打包）、`7a8ebf6`（sim 性能）、`<收尾提交>`（本 Comments）。

1. **sim `src/sim.ts`**：`runSim({config, log, days, force})` 自己组装 Ctx——`ManualClock` 从 `now-days` 的 0 点拨到真实的现在，mock 数据源的 `ctx.now` 用同一虚拟时钟，摘要器固定 mock；`startScheduler` 定时器间隔放到最大，每小时拨到 :06 后 `await tick()`（:05 到期的小时摘要准点到点），日结/补跑/备份按任务规则自然发生。启动补跑在第一次 tick 里完成：首次安装的备份补 7 天 IM / 90 天邮件日程 + 过去 7 天小时摘要，和真实首次启动一致。每过一天打一行进度（日期、本日版本数），结束打印各层级版本数、最终版数、降级小时条目数、耗时，关库收尾——目录可直接 `start --demo --data 同一目录` 接着用。
2. **限制**：非 mock 数据源报错退出；数据目录已有 `context.db` 拒绝运行，`--force` 放行（main.ts 加 `--force` 参数，sim 提前分派，不走 systemClock 路径）。
3. **演示降级**：sim 内包一层 `degradeDemoSource`（注释标明是演示手段）：窗口内跨度 > 2 小时的 `messages()` 抛 `SourceUnavailableError`，小时摘要 1 小时查询不受影响。窗口：45 天跑第 days-20 到 days-11 天（第 25–34 天），恢复后水位只回 7 天保留期，第 25–26 天永久丢失；小天数（< 31）从第 1 天断 10 天，效果相同。实测 20 天：备份覆盖开头 3 天 gap_expired，降级小时条目 168 个。
4. **打包 404 修复（追加的已确认缺陷）**：`src/cli.ts` 用自己所在的 `new URL('./web/', import.meta.url)` 作参数传给 `main(argv, webDir)`；main 不再自己算（打包后 main 被拆进 `dist/chunks/`，在那里算是 `chunks/web/`）。已验证 tgz 安装后首页返回 index.html。
5. **package.json**：`files` 加 `src/source/types.ts`（内网对照合同），其余不变。
6. **测试 `test/sim.test.ts` 3 例**：12 天快进断言小时/日/周版本、≥1 个最终版周摘要、降级条目 ≥1、IM 覆盖 gap_expired ≥3 天、jobs 表 7 行；非 mock 源拒绝 + `--days` 非法拒绝；已有数据目录拒绝、`--force` 放行。

### 偏离票的地方

- 票面说测试跑 10 天，实际用 12 天：10 天时演示窗口只能密到 2 个整天过期，周末两天会偶然没有降级条目；12 天保证开头 3 个整天（必含工作日，mock 工作日保底注入参与形态）确定性出现 gap_expired 和降级。
- 小天数的降级窗口从第 1 天起断（票面公式 `days-20..days-11` 按字面在小天数下是空窗口或断得太晚、恢复时还在保留期内，看不到缺口）；days ≥ 31 严格按票面。
- sim 的数据库连接加 `PRAGMA synchronous = NORMAL`（仅 sim 进程，产品路径不动）：默认 FULL 下几千次事务的 fsync 把 20 天拖到 65 秒（CPU 只占 17 秒，其余都在等盘），改后 20 天 8 秒、45 天 11 秒。WAL+NORMAL 对演示库只丢进程崩溃前的最后几笔提交，可接受。

### 测试结果

- `npm run typecheck` 通过；`npm test` → **13 文件 116 例全过**（本票 3 + 前 113，无回归）。
- `node dist/cli.mjs sim --days 45`（源码 tsx 同结果）：小时 509 · 日结 71 · 周 76 · 月 73 · 年 2；最终版周 5 · 月 2；降级小时条目 93；**耗时 11.0 秒**（票要求 1 分钟内）。

### 打包验证（1–7，命令与输出摘要）

1. `npm run pack:intranet` → `context-workday-0.1.0.tgz`（25 个文件：dist、docs/intranet.md、examples、src/source/types.ts）；`P=$(mktemp -d)`，`npm i -g --prefix $P ./context-workday-0.1.0.tgz` → added 1 package。
2. `$P/bin/context-workday --help` → 用法三行 + `--force` 已列出。
3. `$P/bin/context-workday sim --days 20 --data $D` → 每日进度 20 行 + 汇总：小时 242 · 日结 22 · 周 25 · 月 23 · 年 1；最终版周 3 · 月 1；降级 168；耗时 8.0 秒。
4. `$P/bin/context-workday start --demo --port 4409 --data $D &`（pid 记录）：首页 `curl /` 返回 `<!doctype html>`（index.html，404 修复生效）；`/api/status` → `im result success backedUpDays 17, daily ok, alerts []`；`/api/timeline?date=今天` → hours 带 items；`/api/card?level=week&date=今天` → 2026-W44 rangeLabel 10/26–11/01 带 items。启动补跑把 sim 结束到现在的空隙补上。
5. `$P/bin/context-workday doctor --data $D` → 12 ✓ · 0 ✗ · 4 ⚠（周日，四种参与形态自然为 0），exit 0。
6. 外部模块加载：`examples/im-source` 复制到 `$D/source/`，TODO 用最小假数据填上（未提交），`config.json` 写 `{"source": "./source/index.mjs"}`，`doctor` 显示“检查数据源：假内网客户端（打包验证）”→ 12 ✓ · 0 ✗ · 2 ⚠，字段校验/关联/统计都跑通。
7. `kill <记录的 pid>` 服务停止（curl 确认），`$P $D` 临时目录删除，`git status` 干净。

### 遗留

- 无。
