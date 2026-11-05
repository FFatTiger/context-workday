Status: resolved
Blocked by: 01

# 02 摘要器、摘要存储、小时摘要、证据链

先读：`AGENTS.md`、`CONTEXT.md`、ADR 0001–0004、spec 第 1、3、7、8 节和第 13 节的 1、3、4、8、14、15，`src/llm/types.ts`、`src/db/schema.ts`、`src/api-types.ts`。复用 01 票的 `src/participation.ts`、`test/fake-source.ts`、`test/helpers.ts`。

## 范围

- `src/llm/index.ts`、`src/llm/openai.ts`、`src/llm/mock.ts`、`src/llm/prompts.ts`
- `src/summary/store.ts`、`src/summary/hourly.ts`、`src/summary/evidence.ts`
- `src/server/routes/timeline.ts`、`src/server/routes/evidence.ts`（挂到 `app.ts`）
- `src/backup/` 里补 `coverage.degradedItems` 和 `/api/backup/affected`
- 测试：`test/llm.test.ts`、`test/hourly.test.ts`、`test/evidence.test.ts`

## 步骤

### 1/5 摘要器

- `openai.ts`：`POST {baseUrl}/chat/completions`（用全局 `fetch`，不加 SDK），`temperature: 0.2`，超时 `timeoutMs`（默认 120s）。提示词在 `prompts.ts`，中文，要求只输出 JSON（不要依赖 `response_format`，自己从回复里剥出 JSON，兼容 ```json 围栏）。输出不合格式抛 `SummarizerFormatError`。网络错误、超时、5xx 按 spec 14 重试 3 次（10s / 30s / 90s；等待时间做成可注入的，测试里设成 0）。`ping()` 发一个极短请求测耗时。
  - 小时：输入原文行（带 ref、类型、时间、会话/主题、发送者、文本，上下文消息标"仅供理解，不可引用"），要求最多 maxItems 条，每条一句话（建议 40 字内、最多 80 字）、写"我做了什么/推进了什么"、给出 refs。
  - 全量上层：输入下层条目（带 ref），同样要求。
  - 增量：输入上一版条目（带 id）+ 新的下层条目，要求逐条输出 keep / edit / delete / add（见 `RollupOp`）。
- `mock.ts`：不联网、确定性。小时：按会话（`where`）分组，每组挑一条最像结论的消息（含"定/确认/通过/结论/上线/同意/安排"等词优先，其次是我说的最长那条），拼成"在「会话」…"式的一句话，refs 指向该组 1–3 条可引用原文；日程、邮件各自成条（"参加「周会」…"、"发邮件给… 说明…"）；最多 maxItems。上层全量：从输入里按工作线去重挑前 maxItems 条改写成一句；增量：已有条目里提到同一个「…」的改为 edit（新文本 + 新 refs），否则 add；超上限删最旧的。`model = 'mock'`，`endpoint = null`。
- `index.ts`：按配置返回其一。

### 2/5 摘要存储 `store.ts`

- 系列：`getSeries(db, level, period)`、`ensureSeries`。
- `saveVersion(db, input)`：在一个 `tx()` 里写 versions、items、refs，分配新条目编号（`next_item_id` 递增，永不复用），更新 `current_version`、清 `upstream_changed`、`state='idle'`、`last_error=null`；然后给"当前版本用到了本系列旧版本"的上层系列标 `upstream_changed=1`（判断依据是上层当前版本的 `inputs`）。返回新版本号。
- `beginGeneration / failGeneration`：系列级互斥，已经在 `generating` 就抛"正在生成"（spec：同一系列串行）。失败写 `last_error`。
- 读：当前版本（含条目和引用）、指定版本、版本列表（03 票会用）。
- 版本元数据、条目、引用的字段全部按 `schema.ts`；失败不占版本号。

### 3/5 小时摘要 `hourly.ts`（spec 第 3 节，一步一步照做）

- `pendingHours(ctx): string[]`：过去 7 天内已结束、在 `task_runs` 里没有 job=`hourly` 且 target=该小时、结果为 success/skipped 的小时，按时间升序。
- `runHour(ctx, hourKey, trigger): Promise<{result:'success'|'skipped'|'failed', version?, note}>`：从客户端读该小时消息、日程、邮件 → 口径筛选 + 降噪 + 每个参与会话附本小时前最近 10 条上下文 → 无与我有关原文则跳过 → 调摘要器（上限 3，格式错带 feedback 重试一次）→ 校验引用（只留指向本小时可引用原文的，无引用条目丢弃；超上限带提示重试一次，仍超保留前 3）→ `saveVersion`（记录 total_msgs、related_msgs、mode='full'）。**本函数自己写 task_runs 记录**（job='hourly'，target=hourKey，trigger 按入参），04 票的调度直接调用它。
- 手动重新生成小时 = `runHour(ctx, key, 'manual')`。
- 我的邮箱：`me().email ?? 通讯录里按 id 找`。把这段解析抽成 `participation.ts` 的导出函数，`backup/run.ts` 里现有的写法改成调用它，小时摘要也用它。

### 4/5 证据链 `evidence.ts`（spec 第 7 节、ADR-0002）

- 原文可用性：本机有 → 可用；`raw_lost` 有记录 → 丢失；否则在客户端保留期内 → 调 `source.findX` 查（没实现 findX 视为没有），查到就可用，查不到判定丢失并写 `raw_lost`；超出保留期且本机没有 → 丢失。丢失原因：那天备份覆盖是 ok → `gone_at_backup`；邮件且从未备份覆盖 → `expired_unbacked`；其他 → `backup_gap`。
- **计数要便宜**：时间线、卡片上的 `degraded` 计数不调客户端，规则是"本机有或在客户端保留期内视为可用，`raw_lost` 有或超保留期本机没有视为丢失"（写 `ponytail:` 注释）。只有证据抽屉才真正查客户端。
- `evidenceTree(ctx, ref, expandRaw)` → `EvidenceResponse`：直接证据一层；下层条目节点带 `latestVersion`（引用的不是最新时）和 `degraded`；`expandRaw` 时递归展开到原文，最多 50 条原文，其余合成 `{kind:'more'}`；`path` 往上找引用了本条的上层条目（当前版本），拼出"本月 v16 › 本周 v4 › 今天 v1 › 09:00"。
- `itemView(...)` 供时间线、卡片复用：`counts`、`degraded`。
- 原文详情：IM 上下文（同会话前后 30 分钟，本机 + 客户端合并去重）、邮件详情、日程详情。

### 5/5 接口

`api-types.ts` 的 1（时间线：hours、gaps、activity、nextHourlyAt 先按"下一个 :05"算，04 票接配置）、3、4（含 `/api/raw/mail/:id`、`/api/raw/event/:id`）、8（本票只支持 level=hour，其余层级返回 501，03 票补）、14 的 `degradedItems`、15。

## 测试（`npx vitest run test/llm.test.ts test/hourly.test.ts test/evidence.test.ts`）

用 01 票的假客户端 + 一个"脚本化假摘要器"（按调用顺序返回预设输出）。必测 spec 测试 1、3、9，以及：openai 实现对一个本地假 HTTP 服务（`node:http` 起在随机端口）的成功、格式错误重试、5xx 重试；mock 摘要器对同一输入输出稳定；`saveVersion` 中途抛错不留半个版本；重跑小时产生 v2 后引用它的日结被标上游已变更（日结版本可以在测试里直接用 `saveVersion` 造）。

## 验收

测试全过，`npm run typecheck` 通过。端口 4402 起 `--demo` 服务，`curl -X POST /api/backup/run` 后手动跑几个小时（可以写个一次性 node 脚本调 `runHour`，不提交），再 `curl /api/timeline?date=今天` 和 `/api/evidence?...`，结果摘要贴进 Comments。

注意：`EvidenceResponse.item.itemIndex`（条目在版本里的序号，从 1 起）是新加的字段，别漏。

## Comments

### 做了什么（2026-11-01）

提交：`685fc76`（claimed）、`c8f2c4a`（摘要器）、`6f50994`（store）、`a1dfdb9`（hourly）、`8be3066`（evidence）、`a4b4b69`（接口）、`14a4037`（测试）、`027f525`（收尾）、`3239175`（补提交类型修复与 mock 邮件判定修复；期间票 03/04 的会话并行提交了接口合同调整 b31dcbe/cf4f58f，已一并验证兼容）。

1. **摘要器 `src/llm/`**：`prompts.ts` 中文提示词（小时/全量/增量三套，feedback 注入，要求只输出 JSON）；`openai.ts` 全局 fetch 打 `{baseUrl}/chat/completions`，temperature 0.2、超时默认 120s，网络错/超时/5xx 按 10s/30s/90s 重试 3 次（sleep 可注入），4xx 不重试，JSON 剧本容忍 ```json 围栏和前后杂文，不合格式抛 `SummarizerFormatError`（message 可作 feedback），`ping()` 单次极短请求测耗时；`mock.ts` 确定性实现：小时按会话分组挑结论词优先的核心消息（结论词：定/确认/通过/结论/上线/同意/安排）→“在「会话」推进：…”，日程、邮件各成条（区分我发/收到的），上层全量按「工作线」去重，增量同工作线 edit/新工作线 add/超上限优先删本轮未更新的最旧条目；`index.ts` 按配置返回其一。
2. **摘要存储 `src/summary/store.ts`**：`getSeries/ensureSeries`；`saveVersion` 一个 tx 写完版本+条目+引用，条目编号系列内永不复用（keep/edit 沿用，add 从 next_item_id 分配），旧引用不标 is_new、新引用标 is_new，成功后清 upstream_changed、state=idle、last_error=null，并给“当前版本 inputs 用到本系列”的上层系列标上游已变更；`beginGeneration` 系列级互斥（generating 时抛“正在生成”），`failGeneration`/`releaseGeneration`；读：当前版本、指定版本（含条目+引用）、版本列表（03 票用）。失败不占版本号。
3. **小时摘要 `src/summary/hourly.ts`**：`pendingHours`（过去 7 天已结束、无 success/skipped 记录，升序）；`runHour` 逐步照 spec 3：读客户端 → 参与会话判定 + 降噪 + 每会话附前 24h 内最近 10 条非系统上下文（x 前缀，仅供理解）→ 无与我有关原文记 skipped → 摘要器上限 3、格式错带 feedback 重试一次 → 引用校验（只留本小时可引用原文，无引用条目丢弃）→ 超上限带提示重试一次仍超保留前 3 → saveVersion（total/related 统计、mode=full）。自己写 task_runs（job=hourly）；手动重跑 = trigger 'manual'。我的邮箱抽成 `participation.ts` 的 `myEmailAddress`，backup/run.ts 改为调用它。
4. **证据链 `src/summary/evidence.ts`**：可用性两级——便宜规则（本机有或保留期内=可用；raw_lost 有或超保留期本机无=丢失，`ponytail:` 注释标明不调客户端，供时间线/卡片/affected）和精确判定（抽屉：本机→raw_lost→保留期内 findX 反查一次，查不到写 raw_lost 且查到的对象在本次请求内复用，避免二次反查）；丢失原因：那天覆盖 ok→gone_at_backup、邮件且从未覆盖→expired_unbacked、其他→backup_gap。`evidenceTree`：直接证据一层，小时条目任一原文丢失即降级（ADR-0002，AI 当时概述=条目文本+生成时间+原因），下层条目带 latestVersion，expandRaw 递归展开到原文、预算 50 条超出合成 more 节点，path 由当前版本向上拼“今天 v1 › 09:00”；`itemViews` 供时间线/卡片复用（counts + degraded）；`imContext`（同会话前后 30 分钟本机+客户端合并去重，客户端不可用回落本机）、`mailDetail`/`eventDetail`（本机优先，客户端反查）；`affectedItems` + `degradedItemCount`。
5. **接口**：`routes/timeline.ts`（GET /api/timeline：hours/gaps/activity/nextHourlyAt 按“下一个 :05”，activity 用本机备份数据；POST /api/series/:level/:period/regenerate，仅 hour，其余 501）；`routes/evidence.ts`（/api/evidence、/api/raw/im/:id/context、/api/raw/mail/:id、/api/raw/event/:id）；`coverage.ts` 补 degradedItems、`routes/backup.ts` 的 /api/backup/affected 实现；全部挂到 app.ts。`itemIndex` 已返回。
6. **测试**：`test/helpers.ts` 加 `ScriptedSummarizer`（按调用顺序返回预设输出，Error 直接抛，记录 feedback）；`test/llm.test.ts` 12 例（node:http 随机端口假服务：成功/围栏/格式错不重试/5xx 重试后成功/重试用尽/4xx 不重试/ping；mock 确定性+规则）；`test/hourly.test.ts` 14 例（spec 1/3、格式重试、超限重试、无有效条目失败、客户端不可用、pendingHours、saveVersion 原子性与编号复用/is_new、上游已变更）；`test/evidence.test.ts` 9 例（spec 9 三种丢失原因、raw_lost 后不再查客户端、展开/latestVersion/path、上层 degraded 累计、IM 上下文合并、邮件日程详情、affected+coverage 计数）。

### 偏离票的地方

- mock 增量“超上限删最旧”：优先删本轮未更新的最旧幸存条目，避免把刚 edit 的条目立刻删掉（票面只说“删最旧”，按演示效果做了优先级）。验收时顺带发现并修了 mock 对“我发出的邮件”的判定（流水线给的 who 是“我 → 收件人”，不是我的名字）。
- 上下文取数窗口：小时前 24 小时内取每会话最近 10 条非系统消息（票面只说“本小时前最近 10 条”，24h 窗口覆盖实际场景且限制读数据量）。
- 重新生成遇到 skipped（如该小时原文已过保留期）返回 400 + 原因，不另造 `version: null` 形状。

### 测试结果

- `npm run typecheck` 通过；`npx vitest run` → **6 文件 60 用例全过**（本票 35 + 票 01 的 25，无回归）。
- 验收（端口 4402，mktemp 数据目录，--demo）：
  - `POST /api/backup/run` → im/calendar/mail 三源 success（8 天 / 153 场 / 274 封）；
  - 一次性脚本跑最近小时：周日“周末零星”节奏下 3 个 success（01/17/20 点）、其余 skipped；`POST /api/series/hour/2026-11-01T20/regenerate` → v2、v3；
  - `/api/timeline?date=2026-11-01`：3 张小时卡（含 mock 文案“在「Q4 预算评审」推进：我把 Q4 预算初稿更新到共享文档了…”、“发邮件「述职提纲 v1，请王总过目」说明：…”），gaps `[{2,17},{18,20}]`，activity 1:1 17:2 20:1，nextHourlyAt 23:05；
  - `/api/evidence?…T17&expand=raw`（人工删除一条被引消息并记 raw_lost 后）：lost 节点 reason=gone_at_backup + 正常 im 节点，totals degraded=1，itemIndex=1，path [17:00]；
  - `/api/raw/im/:id/context`：科技部大群 16 条合并去重、isTarget 唯一；`/api/raw/mail/:id`：主题/发件人/正文正确；
  - `/api/backup/affected`：1 条降级小时条目（reason、usedBy 空——日结 03 票才有）；coverage degradedItems=1；
  - 非小时重新生成 501、未来小时 400；task_runs 记录 success/skipped/manual 齐全。

### 遗留

- 摘要卡片（接口 2）、日/周/月/年重新生成、/api/runs：票 03/04。
- 活动条 activity 用本机备份数据：当天还没备份的小时不计入（`ponytail:` 已标，06 票做页面时留意）。
- `/api/evidence` 在客户端不可用且原文需反查时会报 500（spec 未定义此场景的降级展示，界面票如果需要再定）。
