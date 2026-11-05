Status: resolved

# 05 搜索、设置、演示脱敏、doctor

**本票只做 1/5–3/5**（搜索、设置与脱敏、doctor）。4/5 sim 和 5/5 打包拆到 09 票（依赖 04 票的调度器），不要做。本票在独立分支 `be2` 上做，和 03/04 票并行：不要改 `src/summary/`、`src/jobs/`、`src/backup/`，`app.ts` 只加挂载行。

先读：`AGENTS.md`、spec 第 10、11 节和第 13 节的 19、20，`src/api-types.ts`，`src/main.ts`、`src/source/types.ts`、`src/source/mock.ts`、`src/jobs/scheduler.ts`。

## 范围

`src/search.ts`、`src/settings.ts`（补保存）、`src/redact.ts`、`src/server/routes/search.ts`、`src/server/routes/settings.ts`、`src/doctor.ts`、`src/sim.ts`、`src/main.ts`（只在需要时小改）、`package.json` 的 scripts。测试 `test/search.test.ts`、`test/redact.test.ts`、`test/doctor.test.ts`、`test/sim.test.ts`。

## 步骤

### 1/5 搜索（spec 第 10 节）

`LIKE` 子串匹配，空格分词按"与"；范围 = 所有系列当前版本的条目 + 本机备份的原文；时间（今天 / 本周 / 本月 / 全部）、来源多选、"只看与我有关"（原文用 `related_to_me`）；时间倒序、每页 50；`snippet` 以第一个命中为中心截 80 字左右，`highlights` 标出所有命中；`target` 按 `SearchHit` 定义；空结果且范围含今天时给 `hint`。

### 2/5 设置和演示脱敏（spec 第 11 节）

- `GET/PUT /api/settings`、`POST /api/settings/test-model`（调 `summarizer.ping()`）。`model.destination`：mock → "演示模型（不联网）"；localhost / 127.0.0.1 / ::1 → "仅本机"；其他 → "发送到 <主机名>"。
- 脱敏只在 API 出口做：在 `app.ts` 给 `/api` 加一个中间件，`settings.redact` 开启时把 JSON 响应里的字符串值按规则替换（id、period、时间等结构字段不动——用一个跳过的键名清单）。规则一字不差照 spec：人名保留姓其余每字换"*"（人名来自 `contacts` 和消息发送者，文本里出现的也要换，长名字先换）；群名换成"群 N"（`sessions.alias_no` 首次需要时分配并持久保存）、私聊显示"私聊 · 王*"，文本里「群名」也换；带货币单位的金额换"***"，百分比和时间不变；邮箱 @ 前只留第一个字符。
- spec 测试 12：各接口结果一致，同一个群编号固定。

### 3/5 doctor（内网对接的关键工具）

`context-workday doctor [--source 模块]` 逐项检查数据源，打印 ✓ / ✗ 和原因，最后汇总，有 ✗ 退出码 1：
- 每个方法都能调用、不超时（每项 30s）；`retentionDays` 三个字段都是正整数。
- 返回形状逐字段校验（类型、必填、枚举值），时间是毫秒（> 1e12）且不在未来太远，ID 非空且在一次返回里唯一。
- 关联：消息的 `sessionId` 都能在 `sessions()` 里找到；`me().id` 在通讯录里；`replyToId` 指向的消息能在同一批或 `findMessage` 里找到（找不到只警告）。
- 统计：最近 24 小时消息数、系统消息数、五种参与形态各命中多少、参与会话数、与我有关的日程和邮件数——**五种形态有为 0 的给警告**，提示内网同事检查字段映射。
- 打印 3 条样例消息（文本截断 30 字）。
- 测试：对 mock 数据源全过；对一个故意写错字段（秒级时间、缺 sessionId）的假数据源报出对应 ✗。

### 4/5 sim（演示历史）

`context-workday sim --days 45 [--data 目录]`：只允许 mock 数据源（否则报错退出）。用 `ManualClock` 从 `now - days` 开始，每次拨 1 小时、`await scheduler.tick()`，直到现在；进度每天打印一行。为了演示降级，在第 `days-20` 到 `days-11` 天之间让 IM 备份失败（sim 内部包一层数据源：这段时间里跨度超过 2 小时的 `messages()` 调用抛 `SourceUnavailableError`，小时摘要的 1 小时查询不受影响；写注释说明这是演示手段）。结束后打印各层级版本数、降级条目数。已有数据的目录拒绝运行（除非 `--force`）。用 mock 摘要器时 45 天应在 1 分钟内跑完。

### 5/5 打包

`npm run pack:intranet` 产出 tgz；验证：`npm i -g --prefix $(mktemp -d) ./context-workday-*.tgz` 后 `<prefix>/bin/context-workday --help` 能跑，`sim --days 10` + `start` 在端口 4405 能打开首页和 `/api/status`。把验证命令和结果写进 Comments。

## 验收

测试全过，`npm run typecheck`、`npm run build` 通过，打包验证通过。

## Comments

### 做了什么（2026-11-01）

只做了 1/5–3/5（sim/打包在 09 票）。提交：`ff9fd44`（claimed）、`de38706`（搜索）、`46a419e`（设置与脱敏）、`85b49d9`（doctor）、收尾提交（本 Comments）。

1. **搜索 `src/search.ts` + `routes/search.ts`**：SQL `LIKE ... ESCAPE` 子串匹配，空格分词按"与"（邮件按"主题 OR 正文"、日程按"标题 OR 地点 OR 备注"逐词联合命中）；范围 = 所有系列当前版本条目 + 本机备份原文（原文每类 LIMIT 2000）；时间今天/本周/本月/全部（按周期起点筛）、来源多选、`mine` 用备份时算好的 `related_to_me`；时间倒序、每页 50；`snippet` 以首个命中为中心截 80 字（首尾截断加"…"），`highlights` 标出片段内全部命中（含多词）；`target` 按 `SearchHit`；空结果且有关键词时给 `hint`。
2. **设置 `routes/settings.ts` + `settings.ts` 补保存**：GET/PUT `/api/settings`（`saveSettings` 只收布尔开关，非法返 400）、POST `/api/settings/test-model` 直调 `summarizer.ping()`；`model.destination` 按 `config.llm === 'mock'` → "演示模型（不联网）"，本机地址（localhost/127.0.0.1/::1/[::1]）→ "仅本机"，其他 → "发送到 <主机名>"；`me.name` 优先用备份存的 meta，客户端没开也能打开设置页。
3. **演示脱敏 `src/redact.ts` + `app.ts` 出口中间件**：`settings.redact` 开启时把 `/api` JSON 响应递归替换——人名（contacts + im_messages.sender_name + meta me，≥ 2 字，保留姓其余每字换 *，长名字先换）；群名 → "群 N"（`sessions.alias_no` 首次需要时分配并持久保存），文本里出现的群名也换；私聊只在展示会话名的 `session` 字段整串换"私聊 · 王*"（避免把参会人名误换）；带货币单位金额（¥/$/元/万/亿，万后跟量词不算）→ ***，百分比/时间不动；邮箱 @ 前只留第一个字符（如 c***@dom）。结构字段（id/period/version/level 等跳过键清单）不动。
4. **doctor `src/doctor.ts`**：retentionDays 正整数；me/contacts/sessions/messages/events/mails 逐个调用（每项 30s 超时）+ 逐字段形状校验（类型/必填/枚举）、时间毫秒（> 1e12 且消息/邮件不超未来 1 天、日程允许未来 31 天）、ID 非空且批内唯一；关联（sessionId ∈ sessions、me().id ∈ contacts、replyToId 同批或 findMessage，找不到只警告且限查 20 条）；统计（24h 消息/系统消息、五形态计数、参与会话、有关日程/邮件；五形态为 0 时警告并提示对应字段）；3 条样例消息（30 字截断）；有 ✗ 退出码 1。`main.ts` 只改一行把 `clock.now()` 传给 doctor。

### 偏离票的地方

- 搜索排序时间：摘要条目用周期起点（小时/天/周/月/年起始），不用版本生成时间——时间筛选对摘要才有意义（"今天"应含今天生成的日结条目）。
- 群编号是"Redactor 按群名首次出现懒分配"（同一次响应内多个群按名字长度降序拿号），持久化在 `sessions.alias_no`，跨请求/重启不变；而不是严格按"响应里某个字段出现的先后"——后者对同一份数据会因查询顺序不同而不稳定，不符合测试 12 的"编号固定"。
- 私聊整名替换只作用于 `session` 字段（api-types 里会话名的展示字段）；api-types 例子里 `群「供应链对接」· 王*` 这种复合 source 字段靠通用规则替换（群名→群 N、人名→姓+*），实测得到 `群「群 3」· 王*`，读起来稍重但规则一致。
- IM/邮件/日程原文搜索每类加 LIMIT 2000 上限（个人一年数据量级远小于此，防全表 LIKE 拖慢）。
- `npm run typecheck` 在本分支不过：`src/summary/rollup.ts` 有 6 个类型错误（`RunHandle.finish` 少第三个参数等），来自 03 票的提交 `bc9caad`，main 上 `855df1b` 已修复；本票按约不动 `src/summary/`，除此之外所有文件 0 错误（`npm run build` 和全部测试不受影响，esbuild/vitest 不做类型检查）。

### 测试结果

- `npx vitest run test/search.test.ts test/redact.test.ts test/doctor.test.ts` → **3 文件 15 用例全过**；全量 `npm test` → **9 文件 75 用例全过**（无回归）；`npm run build` 通过。
- 接口验收（端口 4403，mktemp 数据目录，`--demo`）：
  - `POST /api/backup/run` → 三源 success（im 1265 / 日程 153 / 邮件 274）；
  - `GET /api/search?q=预算&range=all` → 命中日程/IM/邮件，target/snippet/highlights 正确；
  - `GET /api/settings` → destination "演示模型（不联网）"、source/me 正确；`POST /api/settings/test-model` → ok:true, ms:0；
  - PUT `/api/settings` 开 redact 后：搜索结果里 `群「Q4 预算评审」· 王总` → `群「群 1」· 王*`、`陈思远` → `陈**`，`target.ref.period` 等结构字段不动；关掉后原文恢复；同一群两次请求都是 `群 1`；
  - `node dist/cli.mjs doctor --data <目录>` → 12 ✓ · 0 ✗ · 4 ⚠（当天是周日，四种形态自然为 0，警告文案正常），exit 0。
- 单测覆盖：mock 源全过 + 秒级时间/缺 sessionId 报对应 ✗ + down 报 ✗；脱敏规则逐条 + spec 测试 12（路由级一致性）。

### 遗留

- 4/5 sim、5/5 打包在 09 票（等 04 票调度器）。
- 搜索不搜"今天还没备份的原文"（只查本机，hint 已提示）；`/api/search` 的 sources 默认全部，前端可自行传参。
- rollup.ts 类型错误待 03 票合入 main 后自动消除（见上）。
