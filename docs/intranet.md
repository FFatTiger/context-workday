# 内网对接指南

这份文档写给在内网接手的人（或 agent）。Context 的页面、存储、定时任务、摘要、证据链、版本、备份、搜索都已在外网用仿真数据做完并测试过。内网只剩三件事：

1. **写数据源**：一个 `index.mjs`，把内网 IM 包的数据映射成第 3 节的合同。约 100–200 行，模板在 `examples/im-source/`。
2. **配模型**：在 `config.json` 填 OpenAI 兼容接口的地址、key、模型名。
3. **自检和试跑**：`context-workday doctor` 全部通过 → `context-workday start` → 按第 7 节验收。

除此之外不需要改 Context 的代码。真需要改（比如合同表达不了某个字段），见第 9 节。

---

## 1. 安装

要求 Node ≥ 22.13（用内置的 `node:sqlite`，没有原生模块，不需要编译）。

```bash
node -v                                   # ≥ v22.13
npm i -g ./context-workday-0.1.0.tgz      # 或发布到内网 npm 源后 npm i -g context-workday
context-workday --help
```

也可以不全局安装：`npx ./context-workday-0.1.0.tgz start`。

先用仿真数据确认装好了：

```bash
context-workday sim --days 30 --data /tmp/ctx-demo     # 用仿真客户端快进 30 天，约 10 秒
context-workday start --demo --data /tmp/ctx-demo      # 打开 http://127.0.0.1:4318
```

## 2. 数据目录和配置

数据目录默认 `~/.context-workday/`（Windows 是 `%USERPROFILE%\.context-workday\`），可用 `--data` 或环境变量 `CONTEXT_DATA_DIR` 换。里面：

```
~/.context-workday/
  config.json        配置（下面）
  context.db         全部数据：备份的原文、摘要、版本、运行记录（SQLite，单文件）
  source/            数据源模块（第 3 节），自带 package.json 和 node_modules
```

`config.json`：

```json
{
  "port": 4318,
  "host": "127.0.0.1",
  "source": "./source/index.mjs",
  "sourceOptions": {},
  "llm": {
    "baseUrl": "http://llm.example.corp/v1",
    "apiKey": "sk-...",
    "model": "qwen-max",
    "timeoutMs": 120000
  }
}
```

- `source`：相对路径按数据目录解析。`sourceOptions` 原样传给数据源工厂函数（放账号、端口之类）。
- `llm`：任何 OpenAI 兼容的 `/chat/completions` 接口。key 也可以用环境变量 `CONTEXT_LLM_API_KEY` 给，避免写进文件。填 `"mock"` 则不调模型（规则拼句，仅供演示）。
- `host` 保持 `127.0.0.1`：数据只在本机浏览器看。

## 3. 数据源合同

数据源是一个 ES 模块，默认导出工厂函数 `(ctx) => SourceAdapter`（可以是 async）。`ctx` 有 `options`（即 `sourceOptions`）、`now()`、`log(msg)`。完整类型定义在包里的 `src/source/types.ts`，下面是逐字段说明和容易踩的坑。

**通用**：时间一律 **epoch 毫秒**（内网包给秒要乘 1000）。ID 一律字符串，必须稳定（同一条消息每次读到的 ID 相同），备份靠它去重、证据链靠它找原文。范围 `{from, to}` 含 `from` 不含 `to`。

**客户端不可用**（没开、没登录、IPC 断开）时抛错即可。错误名设成 `SourceUnavailableError` 最好（模板里有），Context 会记为失败、每小时重试、页面告警。不要吞掉错误返回空数组，否则会被当成"这段时间没有消息"。

### 3.1 必须实现的

| 方法 | 返回 | 说明 |
|---|---|---|
| `name` | 字符串 | 显示在设置页 |
| `retentionDays` | `{ im: 7, mail: 90, calendar: 90 }` | 客户端保留原文的天数。决定备份缺口什么时候从"可补救"变"已过期"，按实际填 |
| `me()` | `{ id, name }` | 当前登录的我。`id` 必须和消息里的 `senderId`、`mentions` 是同一套 ID |
| `contacts()` | `[{ id, name, email? }]` | 通讯录。演示脱敏靠它识别人名 |
| `sessions()` | `[{ id, name, type }]` | 全部会话。`type`：`group` 群聊 / `private` 一对一私聊 |
| `messages({from, to})` | `ImMessage[]` | **全部会话**里发送时间在范围内的消息，含系统消息、含我没参与的会话 |
| `events({from, to})` | `CalendarEvent[]` | 开始时间在范围内的日程 |
| `mails({from, to})` | `Mail[]` | 收发时间在范围内的邮件，**含已发送** |

`ImMessage`：

| 字段 | 类型 | 怎么填 | 坑 |
|---|---|---|---|
| `id` | string | 客户端消息 ID | 必须全局唯一（不同会话不能撞） |
| `sessionId` | string | 所在会话 ID | 要能在 `sessions()` 里找到 |
| `senderId` / `senderName` | string | 发送者 | 我发的消息 `senderId` 必须等于 `me().id`，"我开口"靠它 |
| `time` | number | 发送时间，毫秒 | |
| `text` | string | 文本 | 图片、文件、卡片等填可读描述："[图片]"、"[文件] 方案.pdf"，卡片取标题 |
| `kind` | string | `text` 或原始类型名 | |
| `isSystem` | boolean | 入群、退群、撤回提示、系统播报、机器人通知 | 系统消息不进摘要，也不算"定向发给我" |
| `mentions` | string[] | 被 @ 的人的 ID | **不含 @所有人** |
| `mentionAll` | boolean | 是否 @所有人 | @所有人不算参与 |
| `replyToId` | string \| null | 引用回复的原消息 ID | "回复我"靠它：原消息是我发的就算 |
| `directedToMe` | boolean | 群里客户端标记为"定向发给我"的消息 | 没有这个概念就填 `false` |

`CalendarEvent`：`id, title, start, end, allDay, organizer{id,name}, attendees[{id,name,response}], location, notes, updatedAt`。`response` 取 `accepted / tentative / declined / none`。我是组织者、或我是参会人且没拒绝，就算与我有关；全天日程不计入摘要。`updatedAt` 用于发现日程变更，没有就填 `start`。

`Mail`：`id, subject, from{name,address}, to[], cc[], time, text, folder`。`text` 要纯文本（HTML 先去标签）。`folder` 已发送的填 `sent`。我发出的、或 To 里有我的才算与我有关（抄送不算），判断"我"用的是 `me()` 对应通讯录里的 `email`，所以通讯录里我的邮箱要对。

### 3.2 可选的

`findMessage(id)` / `findMail(id)` / `findEvent(id)`：按 ID 查单条，查不到返回 `null`。实现了，证据链能准确区分"本机没备份但客户端还有"和"已丢失"；不实现就当客户端里没有。`close()`：进程退出时调用。

### 3.3 性能

- 小时摘要每小时调一次 `messages`（1 小时范围）+ `events` + `mails`；IM 备份每天调一次 `messages`（从上次备份到现在，通常 1 天，首次 7 天）。
- 内网包如果只能按会话取历史：在 `messages` 里遍历 `sessions()`，每个会话取该时间段，再合并。会话列表可以缓存几分钟。
- 单次调用超过 30 秒 doctor 会报警。

## 4. 写数据源的步骤

```bash
cp -r "$(npm root -g)/context-workday/examples/im-source" ~/.context-workday/source
cd ~/.context-workday/source
npm i <内网 IM 包>
# 编辑 index.mjs 里所有 TODO
echo '{ "source": "./source/index.mjs" }' > ~/.context-workday/config.json   # 已有 config.json 就手动加这一项
context-workday doctor
```

## 5. doctor

`context-workday doctor` 逐项调用数据源，检查返回的形状、时间单位、ID 唯一、会话关联，并统计最近 24 小时五种参与形态各命中多少。有 ✗ 退出码为 1。

- ✗ 要全部修掉。没填完的模板（`me()` 是 TODO、会话和通讯录为空）会直接报 ✗。
- 统计看的是最近 24 小时，**在工作日下午跑**，周末或早上跑会出现很多"命中 0"的警告。
- "某种参与形态命中 0"是警告：可能那天确实没有，也可能字段映射错了（最常见：`senderId` 和 `me().id` 不是同一套 ID；`mentions` 里混进了 @所有人；`replyToId` 没填）。找一条你确定是"@我"或"回复我"的消息核对一下。

## 6. 跑起来

```bash
context-workday start
```

首次启动会：备份客户端里现有的全部 IM（7 天）、日程、邮件（90 天）→ 把过去 7 天每个有记录的小时补生成小时摘要 → 到点生成日结和周、月摘要。之后按任务页的时间自动运行（每小时第 5 分小时摘要，20:30 日结，00:30 补跑，02:00 IM 和日程备份，周日 03:00 邮件备份，每月 1 日 03:00 年摘要），时间可在任务页改。

电脑睡眠、程序关闭期间错过的任务，下次启动自动补上。想开机自启：Windows 用"任务计划程序"在登录时运行 `context-workday start`；macOS 用 launchd；也可以用 pm2。

## 7. 验收清单

1. `doctor` 全部 ✓，五种参与形态里至少"我开口""私聊"有命中。
2. 启动后打开备份页：IM、日程、邮件都有一次成功的备份，覆盖条最近 7 天是绿的。
3. 今天页：有记录的小时出现小时摘要，随便点一条，证据抽屉能展开到原文，原文和客户端里一致。
4. 设置页：模型地址和"数据去向"正确，"测试连接"成功。
5. 任务页：点"日结 · 立即运行"，今天卡片出现日结 v1，本周、本月版本号各加 1。
6. 打开"演示脱敏"，人名、群名、金额都被替换。

## 8. 调口径和提示词

- 参与口径：设置页 8 个开关，改了只影响之后生成。
- 摘要写得不好：提示词在源码 `src/llm/prompts.ts`。改了要重新 `npm run build` 打包（见第 9 节）。

## 9. 需要改代码时

源码仓库（`context-workday-src.zip`，含 git 历史）和 tgz 一起交付，结构见仓库根目录 `AGENTS.md`，功能规格 `.scratch/context-v1/spec.md`，每张实现票的报告在 `.scratch/context-v1/issues/`。开发：`npm install && npm run dev`（`--demo` 仿真数据，前端 5173）。改完 `npm run typecheck && npm test && npm run pack:intranet` 出新的 tgz。

改数据源合同（`src/source/types.ts`）要同时改这份文档和 `src/doctor.ts`。

## 10. 给内网 agent 的任务书（可直接粘贴）

> 你要把 Context（`context-workday` 包）接到本机的企业 IM 客户端。包已经装好，文档在 `$(npm root -g)/context-workday/docs/intranet.md`，先完整读一遍。
>
> 1. 找到内网 IM 包（名字：____）的文档或类型定义，确认它怎么取：当前用户、通讯录、会话列表、某时间段的消息（字段：发送者、@列表、@所有人、引用回复、系统消息、定向消息）、日程、邮件。
> 2. 按文档第 4 节把模板复制到 `~/.context-workday/source/`，实现所有 TODO。字段映射逐条对照第 3 节的表，尤其是表里"坑"那一列。
> 3. 反复运行 `context-workday doctor`，直到没有 ✗。参与形态有 0 的，找真实消息核对映射。
> 4. 在 `~/.context-workday/config.json` 配好模型（地址：____，模型：____，key 用环境变量 `CONTEXT_LLM_API_KEY`）。
> 5. `context-workday start`，按第 7 节逐条验收，把结果和遇到的问题写下来。
> 6. 不要改 Context 包本身的代码。确实有合同表达不了的，停下来说明。
