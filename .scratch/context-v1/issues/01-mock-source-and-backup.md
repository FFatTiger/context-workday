Status: resolved

# 01 仿真数据源、口径、三个备份任务

## 背景

内网的 企业 IM 客户端我们这边拿不到，所以先做一个"仿真客户端"，让整套系统在外网就能跑起来、演示、测试。内网只需要按 `src/source/types.ts` 换掉它。本票还要做口径判定和备份，它们是后面所有票的地基。

先读：`AGENTS.md`、`CONTEXT.md`、`.scratch/context-v1/spec.md` 第 1、9 节和第 13 节的 13–18、21、`src/source/types.ts`、`src/db/schema.ts`、`src/api-types.ts`、`src/time.ts`、`src/context.ts`。

## 范围（只改这些）

- `src/source/mock.ts`（替换桩）
- `src/participation.ts`（新建）
- `src/settings.ts`（新建，只做读取：`getSettings(db): Settings`，默认全开，存在 meta `settings`；`saveSettings` 留给 05 票）
- `src/backup/*.ts`（新建）
- `src/server/routes/backup.ts`（新建）并在 `src/server/app.ts` 挂上
- `test/fake-source.ts`、`test/helpers.ts`、`test/mock-source.test.ts`、`test/participation.test.ts`、`test/backup.test.ts`（新建）

## 步骤

### 1/4 仿真客户端 `createMockSource(ctx)`

要像真实的一个科技公司产品经理的工作，演示时别人一看就信。内容全是简体中文。

- 我：`{ id: 'u_me', name: '陈思远' }`。通讯录约 20 人（王总=直属领导、李敏、赵磊、周婷、孙浩、刘洋、何静……带邮箱 `xxx@example.com`）。
- 会话约 14 个：
  - 我常发言的群：`Q4 预算评审`、`供应链对接`、`数据看板 2.0 项目组`、`移动端需求评审`、`产品周会`；
  - 我很少发言的吵闹群：`科技部大群`（每小时十几条闲聊和通知）、`运维告警`（几乎全是系统播报，`isSystem` 或机器人消息）；
  - 私聊：王总、李敏、赵磊、周婷、孙浩。
- 内容由几条**跨周推进的工作线**驱动，摘要往上汇总时才有连贯的主线。至少 5 条，例如 Q4 预算（初稿 → 评审 → 砍 8% → 定稿）、供应商接口联调（对接 → 报错排查 → 联调通过 → 压测）、数据看板 2.0（需求 → 设计评审 → 开发 → 灰度 → 上线）、移动端需求评审、年度述职准备。每条线按日期处在不同阶段，同一阶段内每天说的话有变化。每条消息的文本由"阶段 × 模板 × 随机种子"拼出，要像真聊天（有短句、有"好的""收到"、有数字和结论句）。
- 节奏：工作日 9–12、14–19 点密集，午休和晚上稀疏，周末零星；不是每个小时都有我参与的会话（时间线要有空档）。
- 必须覆盖五种参与形态：我开口、@我、回复我（`replyToId` 指向我的消息）、私聊、群里 `directedToMe`；也要有只 `mentionAll` 的消息、别人在我参与的群里拍板但没 @我 的消息、同一会话同一小时内容完全相同的转发、非文本消息（`[图片]`、`[文件] xxx.pdf`）。
- 日程：工作日每天 1–3 个（周一 10:00 产品周会、评审会、1:1、偶尔全天培训 `allDay`），我有时是组织者，有时是参会人，偶尔 `declined`；也有与我无关的。
- 邮件：工作日每天 2–6 封，有我发出的（folder `sent`）、To 有我的、只 Cc 我的（不算与我有关）。正文 2–6 行。
- **确定性**：同一个小时的内容只由"种子 + 该小时"决定（用一个简单的种子 PRNG，例如 mulberry32），任意时间范围查询结果都一致。ID 也由此确定（如 `m_2026102909_003`）。
- **客户端保留期**：`messages()` 只返回 `now - 7 天` 之后的，`mails()` 只返回 `now - 90 天` 之后的，日程返回 `now - 90 天` 到 `now + 30 天`。都不返回 `now` 之后的消息和邮件。`retentionDays = { im: 7, mail: 90, calendar: 90 }`。
- **撤回**：约 1% 的消息在发出 30 分钟后从客户端消失（换成一条"xx 撤回了一条消息"的系统消息），用来产生"备份时已不存在"。
- **故障注入**（`ctx.options`）：`imDownDays: string[]`（这些日期里 `messages()` 抛 `SourceUnavailableError`，用来做备份缺口），`down: boolean`（全部方法都抛）。
- `findMessage / findMail / findEvent` 按 ID 反查（解析 ID 里的小时，重新生成该小时），同样遵守保留期。

### 2/4 口径 `src/participation.ts`（纯函数，spec 第 1 节）

导出至少：

- `participatingSessions(msgs: ImMessage[], meId, sessionTypes: Map<id, 'group'|'private'>, flags): Set<sessionId>`——输入是同一个小时的消息；
- `isRelatedEvent(ev, meId, flags)`、`isRelatedMail(mail, meAddress, flags)`；
- `denoise(msgs)`：去掉系统消息；同一会话内文本完全相同的只留第一条。

规则一字不差按 spec：@所有人不算；系统播报不算定向；全天日程不算；抄送、密送不算；私聊里任何消息都算。

### 3/4 备份 `src/backup/`（spec 第 9 节）

- `runBackup(ctx, source: 'im'|'mail'|'calendar', trigger): Promise<BackupRun>`：读水位之后的数据 → 按 ID 去重写入（`INSERT … ON CONFLICT DO NOTHING`；日程按 `updatedAt` 有变化就更新）→ 逐日核对（本机条数 < 客户端条数 = 不一致）→ 推进水位（部分成功时只推进到最早不一致那天的 0 点）→ 写 `backup_runs` 和 `backup_days`。
  - 首次运行（没有水位）从 `now - 保留期` 开始。安装时间记在 meta `installed_at`。
  - IM 备份同时同步 `sessions` 和 `contacts`。
  - 写 IM 消息时算好 `related_to_me`：按"会话 × 小时"判定参与，一个会话一个小时只要参与，该会话该小时的全部消息都是 1。跨水位边界的小时，要用本机已有的消息一起重新判定（写入后对涉及的"会话 × 小时"整体重算）。
  - 抛错（含 `SourceUnavailableError`）记为失败，水位不动，`error` 写原因。
- `needsRetry(db, source): boolean`：最近一次是失败或部分成功（调度在 04 票，每小时调用一次）。
- `coverage(ctx, source, days)`：逐日 `ok / gap_recoverable / gap_expired / no_data`，规则见 spec 9 和 `api-types.ts` 的 `CoverageResponse`；`degradedItems` 先返回 0（证据链在 02 票，它会补上）。
- `alerts(ctx)`：IM 有可补救缺口 → `{source:'im', daysLeft}`，daysLeft = 最早那天距离超过 7 天还剩的天数（向上取整）；邮件剩余 ≤ 14 天才告警。
- `storage(ctx)`：数据库文件（含 -wal）大小；原文、摘要占用按各表文本长度估算即可（`ponytail:` 注释说明）；完整性 = 最近一次 IM 备份的核对结果。
- 所有时间用 `ctx.clock.now()`。

### 4/4 接口 `src/server/routes/backup.ts`

实现 `api-types.ts` 里 13–18：`GET /api/backup/status`、`/coverage`、`/affected`（先返回空列表，02 票补）、`/runs`、`/storage`，`POST /api/backup/run`（依次跑三个来源，立即返回 `{started:true}`，后台执行）。`BackupSourceStatus.rule / nextRunAt` 先用 spec 第 2 节的默认规则写死，04 票会接上任务配置。同时在 `app.ts` 里加 `GET /api/status` 的告警和 IM 部分（`daily` 先固定 `{state:'none', at:null, scheduledAt:null}`，03 票补）。

## 测试（`npx vitest run test/mock-source.test.ts test/participation.test.ts test/backup.test.ts`）

`test/fake-source.ts`：一个可编程的假客户端（测试往里推消息、日程、邮件，能设 `down`、能删除某条模拟过期/撤回），`test/helpers.ts`：建内存库 + `ManualClock` + 假客户端的 `Ctx`。后面的票都会复用这两个文件，写得通用些。

必测：
- 仿真客户端：同一范围查两次结果相同；不返回 now 之后和保留期之前的数据；一周内五种参与形态都出现过；有撤回。
- 口径：spec 测试 2（别人没 @我 的拍板消息所在会话算参与；只有 @所有人 的会话不算），以及日程、邮件、降噪各一条。
- 备份：spec 测试 10（失败时水位不动，下次成功把积压一次补齐；核对不一致记为部分成功、水位停在不一致那天之前；可补救 / 已过期的判定和告警天数）；重复运行不重复写入；related_to_me 按会话×小时。

## 验收

- 上面的测试全过，`npm run typecheck` 通过。
- 用端口 4401 和 `mktemp -d` 的数据目录起服务：`npx tsx src/cli.ts start --demo --port 4401 --data <tmp>`（记下 pid，验完 kill），`curl` 一遍 `POST /api/backup/run`、`/api/backup/status`、`/api/backup/coverage?source=im&days=60`、`/api/status`，结果摘要贴进 Comments。

## Comments

### 做了什么（2026-11-01）

按步骤 1→4 完成，提交：`4146588`（claimed）、`05d2709`（口径+设置）、`6b0bd32`（仿真客户端）、`1cc184e`（备份+接口）、`a42d20a`（测试）、`e06e6fc`（收尾）。

1. **仿真客户端 `src/source/mock.ts`**：21 人通讯录（陈思远 + 20 同事，example.com 邮箱）、14 会话（9 群 + 5 私聊）。5 条跨周工作线（Q4 预算初稿→评审→砍 8%→定稿、供应商联调对接→报错→通过→压测、看板 2.0 需求→设计→开发→灰度→上线、移动端需求收集→评审→修改→排期、年度述职通知→材料→预演→述职），每条线按天数循环推进，同一阶段每天台词由“阶段 × 模板 × 小时种子”变化。节奏：工作日 9–12/14–19 密集、午休晚间稀疏、周末零星；科技部大群每小时十几条闲聊、运维告警几乎全是机器人播报。每日保底注入五种参与形态各一次，另有拍板不 @我、只 @所有人、同文本转发、非文本消息、约 1% 消息 30 分钟后撤回（换系统提示）。mulberry32+fnv 确定性：同一小时内容只由种子+小时决定，任意范围切法结果一致；`m_YYYYMMDDHH_NNN` 等 ID 可反解重建。保留期 im 7 天 / mail、calendar 90 天，不返回 now 之后。故障注入 `imDownDays` / `down`。
2. **口径 `src/participation.ts`**：纯函数，规则一字不差按 spec 1（@所有人不算、系统播报不算定向、全天不算、抄送密送不算、私聊任何消息都算），含 `denoise`（去系统消息 + 同会话同文本去重）。
3. **备份 `src/backup/`**：`run.ts`（水位/去重写入/日程按 updatedAt 更新/逐日核对/部分成功回滚水位到最早不一致日 0 点/失败水位不动/`needsRetry`；im 同步 sessions+contacts，related_to_me 按“会话×小时”整体重算，跨水位边界用本机已有消息一起重判）、`coverage.ts`（逐日 ok/gap_recoverable/gap_expired/no_data + 告警，degradedItems 先 0）、`storage.ts`（文件大小 + 文本长度估算 + 最近一次 im 核对为完整性）。首次运行从 now-保留期起，`installed_at` 记 meta。日程按客户端全窗口读（老日程也会被编辑）。
4. **接口 `src/server/routes/backup.ts`**：13–18 全部实现（/affected 返回空，02 票补），rule/nextRunAt 按 spec 2 默认规则写死（每天 02:00 / 周日 03:00），POST /run 后台依次跑三个来源；`app.ts` 挂载并新增 GET /api/status（daily 固定 none，03 票补）。
5. **测试**：`fake-source.ts`（可编程：push/删/down/imDownDays/messagesImpl 接管逐次返回）、`helpers.ts`（内存库 + ManualClock + 假客户端 + 假模型的 Ctx），mock/口径/备份三组共 25 用例。

### 偏离票的地方

- 核对采用“逐日重查客户端”而不是用本次读到的数据计数：这样才能发现“读和核对之间新到/变更”的不一致（部分成功的真实成因），测试用 `messagesImpl` 精确模拟。
- 邮件/日程的首次运行核对覆盖整个保留窗口（邮件 90 天逐日重查）：代价是一次多几十个客户端查询，换来缺口判定准确。
- 告警天数公式按票面：deadline = 最早缺口日 0 点 + 保留期（7/90 天），daysLeft = ceil(剩余)。覆盖状态里“仍可补救”按整天是否离开保留窗口判，两者在边界上有一天之差，不影响演示。
- mock 的消息 ID 采用整小时全局序号（跨会话按时间排序后编号），保证 findMessage 只重建一个小时即可命中。

### 测试结果

- `npm run typecheck` 通过；`npx vitest run test/mock-source.test.ts test/participation.test.ts test/backup.test.ts` → **3 文件 25 用例全过**（含 spec 测试 2、10 和重复写入、会话×小时重算）。
- 验收（端口 4401，mktemp 数据目录，`--demo`）：
  - `POST /api/backup/run` → `{"started":true}`，后台 im/calendar/mail 三次运行均 success（新增 1264 / 153 / 274 条）；
  - `/api/backup/status`：三源 ok，im 已备份 8 天、日程 153 场、邮件 274 封，nextRunAt 为明天 02:00（邮件下周日 03:00）；
  - `/api/backup/coverage?source=im&days=60`：52 天 no_data（安装前）+ 8 天 ok，unbackedInWindow 0；
  - `/api/status`：im success/8 天、alerts 空、daily none、redact false；
  - `/api/backup/storage`：totalBytes 935056、rawBytes 128523、integrity“逐日核对一致”；/runs、/affected 正常。
  - 数据抽样：与我有关 im 456/1264（11 个会话参与过）、邮件 131/274、日程 118/153。

### 遗留

- degradedItems 恒 0、/affected 空列表：票 02 补。
- BackupSourceStatus.rule/nextRunAt 与 /status 的 daily：票 03/04 接。
- 存储估算用字符数×3（ponytail 注释已标）：中文为主时可接受，后续要精确可换 SUM(LENGTH(CAST(x AS BLOB)))。
