// 本机存储：node:sqlite，一个文件。表结构对应 spec 第 12 节。
// 改表结构时同时改这里的 SCHEMA_VERSION 并在 migrate() 里加升级步骤。

export const SCHEMA_VERSION = 1

export const SCHEMA = /* sql */ `
-- 键值：水位、我的身份、设置、脱敏编号计数等
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL            -- JSON
);

-- ───────── 原文备份 ─────────
CREATE TABLE IF NOT EXISTS sessions (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL,       -- group | private
  alias_no  INTEGER              -- 演示脱敏的"群 N"编号，首次需要时分配，永久固定
);

CREATE TABLE IF NOT EXISTS im_messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  sender_name    TEXT NOT NULL,
  time           INTEGER NOT NULL,
  text           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  is_system      INTEGER NOT NULL,
  mentions       TEXT NOT NULL,  -- JSON string[]
  mention_all    INTEGER NOT NULL,
  reply_to_id    TEXT,
  directed_to_me INTEGER NOT NULL,
  related_to_me  INTEGER NOT NULL, -- 备份时按当时口径算好：本条所在"会话×小时"是否参与会话
  backed_up_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS im_by_time ON im_messages(time);
CREATE INDEX IF NOT EXISTS im_by_session ON im_messages(session_id, time);

CREATE TABLE IF NOT EXISTS mails (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  sender        TEXT NOT NULL,   -- JSON MailAddress
  recipients    TEXT NOT NULL,   -- JSON MailAddress[]（To）
  cc            TEXT NOT NULL,   -- JSON MailAddress[]
  time          INTEGER NOT NULL,
  text          TEXT NOT NULL,
  folder        TEXT NOT NULL,
  related_to_me INTEGER NOT NULL,
  backed_up_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mails_by_time ON mails(time);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  start         INTEGER NOT NULL,
  end           INTEGER NOT NULL,
  all_day       INTEGER NOT NULL,
  organizer     TEXT NOT NULL,   -- JSON Person
  attendees     TEXT NOT NULL,   -- JSON (Person & {response})[]
  location      TEXT NOT NULL,
  notes         TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  related_to_me INTEGER NOT NULL,
  backed_up_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_start ON events(start);

CREATE TABLE IF NOT EXISTS contacts (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT
);

-- 原文可用性：只记"丢失"的判定结果，判定过就不再反复查客户端
CREATE TABLE IF NOT EXISTS raw_lost (
  raw_type   TEXT NOT NULL,      -- im | mail | event
  raw_id     TEXT NOT NULL,
  reason     TEXT NOT NULL,      -- backup_gap | gone_at_backup | expired_unbacked
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (raw_type, raw_id)
);

-- ───────── 备份运行 ─────────
CREATE TABLE IF NOT EXISTS backup_runs (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL, -- im | mail | calendar
  trigger         TEXT NOT NULL, -- scheduled | retry | manual | startup
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  result          TEXT,          -- success | partial | failed | running
  error           TEXT,
  added           INTEGER NOT NULL DEFAULT 0,
  watermark_after INTEGER
);

-- 逐日核对结果（覆盖条的数据来源）。同一天以最近一次核对为准
CREATE TABLE IF NOT EXISTS backup_days (
  source       TEXT NOT NULL,
  day          TEXT NOT NULL,    -- YYYY-MM-DD
  client_count INTEGER NOT NULL,
  local_count  INTEGER NOT NULL,
  run_id       INTEGER NOT NULL,
  PRIMARY KEY (source, day)
);

-- ───────── 摘要 ─────────
CREATE TABLE IF NOT EXISTS series (
  id               INTEGER PRIMARY KEY,
  level            TEXT NOT NULL, -- hour | day | week | month | year
  period           TEXT NOT NULL, -- 2026-10-29T09 | 2026-10-29 | 2026-W44 | 2026-10 | 2026
  current_version  INTEGER NOT NULL DEFAULT 0,  -- 0 = 还没有成功的版本
  is_final         INTEGER NOT NULL DEFAULT 0,
  upstream_changed INTEGER NOT NULL DEFAULT 0,
  next_item_id     INTEGER NOT NULL DEFAULT 1,  -- 条目编号系列内永不复用
  state            TEXT NOT NULL DEFAULT 'idle', -- idle | generating | failed
  last_error       TEXT,          -- 最近一次生成失败的原因；成功后清空
  UNIQUE (level, period)
);

-- 只存成功的版本；失败只体现在 series.state / last_error 和任务运行记录里
CREATE TABLE IF NOT EXISTS versions (
  id           INTEGER PRIMARY KEY,
  series_id    INTEGER NOT NULL REFERENCES series(id),
  version      INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  trigger      TEXT NOT NULL,    -- scheduled | catchup | close | manual | late | startup
  mode         TEXT NOT NULL,    -- incremental | full
  inputs       TEXT NOT NULL,    -- JSON {seriesId, version}[]：用到的下层版本
  model        TEXT NOT NULL,
  total_msgs   INTEGER,          -- 仅小时：全部消息数
  related_msgs INTEGER,          -- 仅小时：与我有关的原文数
  is_final     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (series_id, version)
);

CREATE TABLE IF NOT EXISTS items (
  version_id INTEGER NOT NULL REFERENCES versions(id),
  item_id    INTEGER NOT NULL,   -- 系列内编号
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  op         TEXT NOT NULL,      -- keep | edit | add
  PRIMARY KEY (version_id, item_id)
);

CREATE TABLE IF NOT EXISTS refs (
  version_id     INTEGER NOT NULL,
  item_id        INTEGER NOT NULL,
  target_type    TEXT NOT NULL,  -- item | im | mail | event
  target_version INTEGER,        -- target_type=item：下层 versions.id
  target_item    INTEGER,        -- target_type=item：下层条目编号
  raw_id         TEXT,           -- 原文 ID
  is_new         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS refs_by_item ON refs(version_id, item_id);
CREATE INDEX IF NOT EXISTS refs_by_target ON refs(target_version);

-- ───────── 定时任务 ─────────
CREATE TABLE IF NOT EXISTS jobs (
  name        TEXT PRIMARY KEY,  -- hourly | daily | catchup | yearly | backup_im | backup_calendar | backup_mail
  enabled     INTEGER NOT NULL,
  rule        TEXT NOT NULL,     -- JSON ScheduleRule
  last_run_at INTEGER,
  next_run_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_runs (
  id           INTEGER PRIMARY KEY,
  job          TEXT NOT NULL,
  target       TEXT NOT NULL,    -- 例如 "2026-10-29T19"、"2026-10-29"、"im"
  scheduled_at INTEGER,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  result       TEXT NOT NULL,    -- running | success | skipped | failed | interrupted
  trigger      TEXT NOT NULL,    -- scheduled | manual | startup | retry
  note         TEXT NOT NULL DEFAULT '',
  outputs      TEXT NOT NULL DEFAULT '[]' -- JSON {level, period, version}[]
);
CREATE INDEX IF NOT EXISTS runs_by_job ON task_runs(job, started_at);
`
