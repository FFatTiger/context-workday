// 仿真企业 IM 客户端（票 01）：确定性地生成一个科技公司产品经理的工作流。
// 同一个小时的内容只由「种子 + 该小时」决定；now 只影响保留期过滤、撤回可见性和日程编辑。
// 内网替换时只需按 src/source/types.ts 实现真实适配器（见 docs/intranet.md）。
import { DAY_MS, HOUR_MS, dayKey, fromLocal, local, startOfDay } from '../time.js'
import { SourceUnavailableError } from './types.js'
import type { CalendarEvent, Contact, ImMessage, Mail, Person, Session, SourceAdapter, SourceContext, TimeRange } from './types.js'

// ───────────────────────── 随机数：mulberry32 + FNV-1a 哈希 ─────────────────────────

function fnv(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(r: () => number, arr: readonly T[]): T => arr[Math.floor(r() * arr.length)]
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

// ───────────────────────── 人物与通讯录 ─────────────────────────

const ME: Person = { id: 'u_me', name: '陈思远' }
const ME_EMAIL = 'chensiyuan@example.com'

const PEOPLE: Array<Person & { email: string }> = [
  { id: 'u_me', name: '陈思远', email: ME_EMAIL },
  { id: 'u_wang', name: '王总', email: 'wangzong@example.com' }, // 直属领导
  { id: 'u_limin', name: '李敏', email: 'limin@example.com' },
  { id: 'u_zhaolei', name: '赵磊', email: 'zhaolei@example.com' },
  { id: 'u_zhouting', name: '周婷', email: 'zhouting@example.com' },
  { id: 'u_sunhao', name: '孙浩', email: 'sunhao@example.com' },
  { id: 'u_liuyang', name: '刘洋', email: 'liuyang@example.com' },
  { id: 'u_hejing', name: '何静', email: 'hejing@example.com' },
  { id: 'u_wubin', name: '吴斌', email: 'wubin@example.com' },
  { id: 'u_zhengjie', name: '郑洁', email: 'zhengjie@example.com' },
  { id: 'u_machao', name: '马超', email: 'machao@example.com' },
  { id: 'u_linfang', name: '林芳', email: 'linfang@example.com' },
  { id: 'u_gaoxiang', name: '高翔', email: 'gaoxiang@example.com' },
  { id: 'u_huangli', name: '黄丽', email: 'huangli@example.com' },
  { id: 'u_xulei', name: '徐磊', email: 'xulei@example.com' },
  { id: 'u_songjia', name: '宋佳', email: 'songjia@example.com' },
  { id: 'u_luojing', name: '罗静', email: 'luojing@example.com' },
  { id: 'u_liangchen', name: '梁晨', email: 'liangchen@example.com' },
  { id: 'u_xiefeng', name: '谢锋', email: 'xiefeng@example.com' },
  { id: 'u_tangyue', name: '唐悦', email: 'tangyue@example.com' },
  { id: 'u_hanxue', name: '韩雪', email: 'hanxue@example.com' },
]
const P: Record<string, Person & { email: string }> = Object.fromEntries(PEOPLE.map((p) => [p.id, p]))
/** 通讯录里没有的发件人 */
const BOT: Person = { id: 'u_ops_bot', name: '运维机器人' }
const ADMIN: Person = { id: 'u_admin', name: '部门助理' }
const person = (id: string): Person => P[id] ?? (id === 'u_ops_bot' ? BOT : id === 'u_admin' ? ADMIN : { id, name: id })

// ───────────────────────── 会话 ─────────────────────────

const SESSIONS: Session[] = [
  { id: 'g_budget', name: 'Q4 预算评审', type: 'group' },
  { id: 'g_supply', name: '供应链对接', type: 'group' },
  { id: 'g_dash', name: '数据看板 2.0 项目组', type: 'group' },
  { id: 'g_mobile', name: '移动端需求评审', type: 'group' },
  { id: 'g_weekly', name: '产品周会', type: 'group' },
  { id: 'g_dept', name: '科技部大群', type: 'group' },
  { id: 'g_ops', name: '运维告警', type: 'group' },
  { id: 'g_hrbp', name: 'HR 对接 · 述职答疑', type: 'group' },
  { id: 'g_ann', name: '部门公告', type: 'group' },
  { id: 'p_wang', name: '王总', type: 'private' },
  { id: 'p_limin', name: '李敏', type: 'private' },
  { id: 'p_zhaolei', name: '赵磊', type: 'private' },
  { id: 'p_zhouting', name: '周婷', type: 'private' },
  { id: 'p_sunhao', name: '孙浩', type: 'private' },
]

// ───────────────────────── 台词库 ─────────────────────────

interface LineEntry {
  who: string // 通讯录 ID，或 u_ops_bot / u_admin
  texts: string[]
  mentionMe?: boolean
  mentionAll?: boolean
  replyToMine?: boolean
  directed?: boolean
  kind?: 'image' | 'file'
}

const FILLERS = ['收到', '好的', '明白', 'ok', '辛苦了', '稍等，我看下', '嗯嗯', '+1', '这个思路可以', '赞']

/** 跨周推进的工作线：phase.days 是该阶段天数，按天数循环往复 */
interface Phase {
  days: number
  topic: string
  activity: number // 0–1，该阶段的群活跃度
  pool: LineEntry[]
}
interface Storyline {
  offset: number
  phases: Phase[]
}

const LINES: Record<string, Storyline> = {
  budget: {
    offset: 0,
    phases: [
      {
        days: 7,
        topic: '预算初稿',
        activity: 0.7,
        pool: [
          { who: 'u_me', texts: ['我把 Q4 预算初稿更新到共享文档了，看板的服务器费用这次单独列了一行', '初稿好了，移动端推广费先按上季度的 1.2 倍估，大家看看口径', '预算初稿 v0.2 发群里了，重点看人力和服务器两块'] },
          { who: 'u_limin', texts: ['收到，我下午对一遍明细', '明细表我核了一遍，有两处要跟你对'] },
          { who: 'u_limin', texts: ['@陈思远 明细表第 3 项的单位是不是写成千元了', '@陈思远 预算底稿用哪年的口径？21 还是 22'], mentionMe: true },
          { who: 'u_zhaolei', texts: ['服务器这块上季度我们组超了 15%，这次得留 buffer', '压测机器按 3 台估的吧？我觉得不够'] },
          { who: 'u_wang', texts: ['初稿周五前给我，别压着假期', '口径先跟财务对齐，别自己发明'] },
        ],
      },
      {
        days: 7,
        topic: '预算评审',
        activity: 0.85,
        pool: [
          { who: 'u_me', texts: ['评审会前我把口径统一了：人均费用按部门实际在岗人数算', '评审材料打包发大家邮箱了，会上只过争议项'] },
          { who: 'u_me', texts: ['[文件] Q4预算初稿_v0.3.xlsx'], kind: 'file' },
          { who: 'u_wang', texts: ['推广费砍一半，先跑灰度再看效果', '评审会 14:00，都到场'] },
          { who: 'u_limin', texts: ['你说的第 3 项我改好了，再确认下', '两处口径不一致的我标黄了，会上过一下'], replyToMine: true },
          { who: 'u_zhaolei', texts: ['接口压测的云资源建议放进资本性支出，评审时我提'] },
        ],
      },
      {
        days: 8,
        topic: '预算调整（砍 8%）',
        activity: 0.9,
        pool: [
          { who: 'u_wang', texts: ['上面定了，整体砍 8%，各条线周五前报调整后的版本', '砍 8% 是硬指标，别跟我讨价还价'] },
          { who: 'u_me', texts: ['收到，我们线砍 8% 之后看板服务器预算还够，推广费得再压', '调整版我在做，砍的部分优先动渠道费用'] },
          { who: 'u_me', texts: ['[图片]'], kind: 'image' },
          { who: 'u_limin', texts: ['@陈思远 调整表发你了，确认下数字'], mentionMe: true },
          { who: 'u_zhaolei', texts: ['砍 8% 有点狠，压测机器只能从 3 台降到 2 台了'] },
        ],
      },
      {
        days: 8,
        topic: '预算定稿',
        activity: 0.6,
        pool: [
          { who: 'u_me', texts: ['定稿版已发邮件，各位确认后回我一声', '按砍 8% 之后的版本提交，今天走完审批'] },
          { who: 'u_wang', texts: ['就这么定了，按这版报上去', '定稿归档到预算目录'] },
          { who: 'u_limin', texts: ['确认，没问题', '已归档，回执我转你邮箱'] },
        ],
      },
    ],
  },
  supply: {
    offset: 9,
    phases: [
      {
        days: 8,
        topic: '接口对接',
        activity: 0.7,
        pool: [
          { who: 'u_me', texts: ['接口文档我按字段清单过了一遍，价格回传缺一个币种字段', '对接清单我列了 17 个接口，先跑主流程的 6 个'] },
          { who: 'u_zhaolei', texts: ['我拉了他们技术的对接群，今天下午碰', '文档里回调地址是测试环境的，上线前要换'] },
          { who: 'u_sunhao', texts: ['@陈思远 联调环境今天 15:00 开放，账号发你邮箱', '测试账号我申请好了，共 4 套'], mentionMe: true },
        ],
      },
      {
        days: 8,
        topic: '报错排查',
        activity: 0.9,
        pool: [
          { who: 'u_me', texts: ['下单回传报 -1002，报文我抓出来发群里了', '重放了 3 笔，2 笔超时 1 笔报错，像是他们网关的问题', '错误码表里 -1002 根本没定义，让他们给说明'] },
          { who: 'u_sunhao', texts: ['[图片]'], kind: 'image' },
          { who: 'u_zhaolei', texts: ['是他们网关的超时配置配错了，让他们改', '他们定位到了，今晚发补丁'] },
          { who: 'u_me', texts: ['补丁后我重测，大家等我消息'] },
        ],
      },
      {
        days: 8,
        topic: '联调通过',
        activity: 0.6,
        pool: [
          { who: 'u_zhaolei', texts: ['全量用例跑完，通过率 100%', '联调报告初稿我起了个头'] },
          { who: 'u_me', texts: ['好的，我把结论更新进联调报告', '主流程和异常分支都过了，可以约压测'] },
          { who: 'u_sunhao', texts: ['环境保持到月底，压测还能用'] },
          { who: 'u_liuyang', texts: ['压测脚本我这边准备'] },
        ],
      },
      {
        days: 8,
        topic: '接口压测',
        activity: 0.7,
        pool: [
          { who: 'u_liuyang', texts: ['压测今天 14:00 开跑，目标 500 QPS', '压测报告出了：平均响应 82ms，P99 210ms，达标'] },
          { who: 'u_me', texts: ['压测目标 500 QPS，供应商确认过限流阈值 800，没问题', '报告我转发给王总和李敏'] },
          { who: 'u_zhaolei', texts: ['压测通过，接口这块可以出结论了', '剩下运维接手监控告警'] },
        ],
      },
    ],
  },
  dash: {
    offset: 17,
    phases: [
      {
        days: 7,
        topic: '看板需求',
        activity: 0.7,
        pool: [
          { who: 'u_me', texts: ['看板 2.0 需求文档初稿好了，核心是把 T+1 改成准实时', '这版需求我砍掉了 3 个低频图表，聚焦核心指标页'] },
          { who: 'u_hejing', texts: ['准实时对底层数据压力很大，得和数据组对齐链路', '需求文档我有两处批注，明早回你'] },
          { who: 'u_limin', texts: ['@陈思远 需求评审约在周四 14:00，会议室已订'], mentionMe: true },
        ],
      },
      {
        days: 7,
        topic: '设计评审',
        activity: 0.8,
        pool: [
          { who: 'u_me', texts: ['设计评审通过，图表交互按新方案来', '设计稿第二版我确认了，下钻和筛选都补全了'] },
          { who: 'u_hejing', texts: ['陈思远，埋点方案这版你看下行不行'], directed: true },
          { who: 'u_liuyang', texts: ['前端排期两周，能赶上月底'] },
        ],
      },
      {
        days: 7,
        topic: '开发跟进',
        activity: 0.75,
        pool: [
          { who: 'u_liuyang', texts: ['开发分支已提测，自测通过', '主流程页面都出来了，还差导出功能'] },
          { who: 'u_me', texts: ['我过了一遍主流程，购物车维度少了一个下钻，提了个 bug', '测试用例我补了 12 条异常场景'] },
          { who: 'u_hejing', texts: ['埋点我验收了一半，剩下的明天给结论'] },
        ],
      },
      {
        days: 7,
        topic: '看板灰度',
        activity: 0.7,
        pool: [
          { who: 'u_me', texts: ['灰度 10% 已开，盯三天核心指标', '灰度首日数据正常，加载时长降了 40%'] },
          { who: 'u_limin', texts: ['灰度期的日报我每天早上发一份'] },
          { who: 'u_hejing', texts: ['指标口径我核对过，和旧看板能对上'] },
        ],
      },
      {
        days: 7,
        topic: '看板上线',
        activity: 0.6,
        pool: [
          { who: 'u_me', texts: ['全量上线完成，感谢大家', '上线公告我已同步部门群'] },
          { who: 'u_me', texts: ['[文件] 看板2.0上线说明.pdf'], kind: 'file' },
          { who: 'u_limin', texts: ['上线首日 DAU 持平，报错率下降 60%'] },
          { who: 'u_hejing', texts: ['复盘会下周三，我出会议议程'] },
        ],
      },
    ],
  },
  mobile: {
    offset: 4,
    phases: [
      {
        days: 7,
        topic: '需求收集',
        activity: 0.6,
        pool: [
          { who: 'u_zhouting', texts: ['@陈思远 客户提了 5 个移动端需求，我整理了清单', '需求清单按客户原话整理的，没有加工'], mentionMe: true },
          { who: 'u_me', texts: ['我筛了下优先级，P0 保留两个：手势优化和离线缓存', '其余 3 个排 P2，下季度再看'] },
        ],
      },
      {
        days: 7,
        topic: '需求评审会',
        activity: 0.8,
        pool: [
          { who: 'u_me', texts: ['评审会明天 10:00，会议室 A，线上同步开', '评审材料我发大家了，重点看 P0 的验收标准'] },
          { who: 'u_zhouting', texts: ['你说的验收标准我补进去了，再帮我看一遍', 'P0 两个需求评审通过，细节我更新文档'], replyToMine: true },
          { who: 'u_liuyang', texts: ['安卓端的适配工作量我评估了下，一周够'] },
        ],
      },
      {
        days: 7,
        topic: '方案修改',
        activity: 0.6,
        pool: [
          { who: 'u_me', texts: ['按评审意见把交互改了，弱网提示也补上了', '手势优化的 demo 我录了个视频，群里看下'] },
          { who: 'u_zhouting', texts: ['安卓适配我找刘洋看过了，没问题'] },
        ],
      },
      {
        days: 7,
        topic: '开发排期',
        activity: 0.55,
        pool: [
          { who: 'u_liuyang', texts: ['移动端两个 P0 排进下个迭代，11 月中上线'] },
          { who: 'u_me', texts: ['好的，我跟客户同步时间', '上线前一周做一轮回归，别挤到最后'] },
          { who: 'u_zhouting', texts: ['客户侧我来对接，有变化我再拉群'] },
        ],
      },
    ],
  },
  review: {
    offset: 26,
    phases: [
      {
        days: 7,
        topic: '述职通知',
        activity: 0.5,
        pool: [
          { who: 'u_wang', texts: ['年度述职 11 月下旬开始，材料这月中旬前准备好', '述职重点放业务结果，别写成工作流水账'] },
          { who: 'u_me', texts: ['收到，我会按业务结果、方法沉淀、明年规划三块来写'] },
        ],
      },
      {
        days: 10,
        topic: '述职材料准备',
        activity: 0.6,
        pool: [
          { who: 'u_me', texts: ['述职提纲写好了，先给王总过一遍', '数据我在拉：预算执行率、看板上线后的效率提升'] },
          { who: 'u_me', texts: ['[文件] 述职提纲_v1.docx'], kind: 'file' },
          { who: 'u_sunhao', texts: ['去年我述职被挑战的是量化结果不够，你多放数据', '提纲发我看看，帮你挑挑毛病'] },
        ],
      },
      {
        days: 7,
        topic: '述职预演',
        activity: 0.55,
        pool: [
          { who: 'u_wang', texts: ['周四下午 4 点给我预演一遍，控制在 15 分钟', '预演前把 P10 之后的内容砍掉，评委没耐心'] },
          { who: 'u_me', texts: ['好的，我控制在 20 页以内', '预演我约了会议室，线上线下都开'] },
        ],
      },
      {
        days: 7,
        topic: '正式述职',
        activity: 0.5,
        pool: [
          { who: 'u_me', texts: ['今天述职顺，评委主要问了预算收缩下的取舍', '述职讲完一身轻，感谢各位帮我磨材料'] },
          { who: 'u_wang', texts: ['讲得不错，结果下周出'] },
        ],
      },
    ],
  },
}

/** 会话 → 讨论哪几条工作线 */
const SESSION_LINES: Record<string, string[]> = {
  g_budget: ['budget'],
  g_supply: ['supply'],
  g_dash: ['dash'],
  g_mobile: ['mobile'],
  g_weekly: ['budget', 'dash', 'mobile', 'supply', 'review'],
  g_hrbp: ['review'],
}

const WEEKLY_POOL: LineEntry[] = [
  { who: 'u_me', texts: ['周会材料我发大家了，各线 3 分钟讲进展', '这周会上主要对齐风险项，进度看文档'] },
  { who: 'u_wang', texts: ['各线把上周进展发一下，数据说话', '周会上只过风险项，别念流水账'] },
  { who: 'u_limin', texts: ['周会纪要我稍后发邮件'] },
  { who: 'u_zhaolei', texts: ['供应链联调这周有节点，会上细说'] },
]

const HRBP_POOL: LineEntry[] = [
  { who: 'u_hejing', texts: ['@所有人 述职模板已更新，请从门户下载最新版', '@所有人 述职答疑每周三下午 3 点，线上会议'], mentionAll: true },
  { who: 'u_me', texts: ['述职材料的模板用哪个版本？门户那个是旧的吗'] },
  { who: 'u_hanxue', texts: ['绩效材料 11 月 20 日截止，别拖到最后一天'] },
]

const DEPT_CHAT: LineEntry[] = [
  { who: 'u_wubin', texts: ['中午食堂有酸菜鱼，冲', '楼下咖啡机修好了'] },
  { who: 'u_zhengjie', texts: ['有人下午茶拼单吗', '11 楼空调太冷了，行政能调调吗'] },
  { who: 'u_machao', texts: ['恭喜我司通过等保测评', '这周的科技播报出了，内网门户可看'] },
  { who: 'u_linfang', texts: ['打印机又卡纸了，行政在吗', '新来的实习生是谁带的？'] },
  { who: 'u_gaoxiang', texts: ['今晚篮球馆有人去吗', '加班餐报销流程改了，看邮件'] },
  { who: 'u_huangli', texts: ['地铁 11 号线又故障了，今天迟到的不止我一个吧'] },
  { who: 'u_xulei', texts: ['内网门户今晚例行维护，早点下班'] },
  { who: 'u_songjia', texts: ['周五下午 3 点全员会在 B1 报告厅，别忘了'] },
  { who: 'u_tangyue', texts: ['部门团建报名接龙开始，这周五截止'] },
  { who: 'u_luojing', texts: ['分享个效率工具，周报自动汇总的那种'] },
]
const DEPT_ADMIN: LineEntry[] = [
  { who: 'u_admin', texts: ['@所有人 明晚 22:00–24:00 机房网络割接，请提前保存文件', '@所有人 请在月底前完成信息安全考试', '@所有人 内网门户今晚例行维护，期间无法访问'], mentionAll: true },
]
const ANN_POOL: LineEntry[] = [
  { who: 'u_admin', texts: ['@所有人 Q4 差旅报销截止 11/20，逾期顺延至明年', '@所有人 本季度 OKR 录入截止周五 18:00', '@所有人 年度体检套餐选择本周五截止'], mentionAll: true },
]
const OPS_POOL: LineEntry[] = [
  { who: 'u_ops_bot', texts: ['[运维播报] 主机 prod-app-03 CPU 使用率 87%，持续 5 分钟', '[运维播报] 任务调度心跳丢失：etl-job-12', '[运维播报] 磁盘使用率超过 80%：data-node-05', '[运维播报] 网关 5xx 比例 0.6%，高于基线', '[恢复播报] prod-app-03 CPU 恢复正常', '[值班] 今日值班：孙浩'] },
]

const PRIVATE_POOLS: Record<string, LineEntry[]> = {
  p_wang: [
    { who: 'u_wang', texts: ['预算那边你盯紧点，别到评审才发现漏项', '述职材料先给我看一版', '这周进展我看了，节奏可以', '下午有空吗，聊十分钟'] },
    { who: 'u_me', texts: ['好的，我今天把调整版发您', '述职提纲明天给您', '预算砍 8% 后的版本我重排了优先级，晚点发您', '王总，看板灰度数据不错，加载时长降了 40%'] },
  ],
  p_limin: [
    { who: 'u_limin', texts: ['预算明细我又核了一遍，两处口径问题', '周会纪要发你邮箱了'] },
    { who: 'u_me', texts: ['收到，口径问题我来改', '看板灰度日报记得抄送我'] },
  ],
  p_zhaolei: [
    { who: 'u_zhaolei', texts: ['供应商那边的补丁今晚出，明早重测', '联调报告你写还是我写？'] },
    { who: 'u_me', texts: ['报告我来写，你提供数据就行', '明早 9 点半我们过一遍用例结果'] },
  ],
  p_zhouting: [
    { who: 'u_zhouting', texts: ['客户又追加了一个小需求，不急的话排下季度', '评审纪要我整理好了'] },
    { who: 'u_me', texts: ['追加的先记需求池，别插队', '纪要发我一份，我要同步给王总'] },
  ],
  p_sunhao: [
    { who: 'u_sunhao', texts: ['述职 PPT 模板给你了，参考我去年的', '预演要我旁听吗'] },
    { who: 'u_me', texts: ['要，你帮我看时间控制', '模板收到，改天请你喝咖啡'] },
  ],
}

/** 每日保底注入的台词：保证五种参与形态每个工作日都出现 */
const MENTION_TEXTS = ['@陈思远 这个你拍个板', '@陈思远 文档里第 3 条我改了，你看下', '@陈思远 下午的会对齐一下？', '@陈思远 这个数据你能拉到吗']
const DIRECTED_TEXTS = ['陈思远，这事你确认下再发', '陈思远，看完回我一声', '陈思远，这个方案我持保留意见，你定']
const REPLY_ME_TEXTS = ['这个我来跟进', '收到，我看下', '结论我今晚整理出来']
const REPLY_TEXTS = ['好的，那按你说的来', '行，等你消息', '这样最稳，支持']

// ───────────────────────── 日计划（日程、邮件、保底注入） ─────────────────────────

const ANCHOR = fromLocal(2026, 1, 5) // 周一；工作线的阶段按它循环
const STORY_GROUPS = ['g_budget', 'g_supply', 'g_dash', 'g_mobile', 'g_weekly']
const PRIVATE_IDS = Object.keys(PRIVATE_POOLS)

type Response = 'accepted' | 'tentative' | 'declined' | 'none'
interface EvDraft {
  title: string
  /** 从当天 0 点起的分钟数 */
  minute: number
  durMin: number
  allDay?: boolean
  organizer: string
  attendees: Array<{ id: string; response: Response }>
  location: string
  notes: string
  editable?: boolean
}
interface MailDraft {
  hour: number
  from: string | { name: string; address: string }
  to: string[]
  cc?: string[]
  subject: string
  body: string[]
  sent?: boolean
}

interface DayPlan {
  focus: Record<string, string> // 会话 → 当天主推的工作线
  weeklyFocus: string
  mention: { h: number; sess: string }
  directed: { h: number; sess: string }
  reply: { h: number; sess: string }
  priv: { h: number; sess: string }
  events: EvDraft[]
  mails: MailDraft[]
}

function phaseOf(lineId: string, dayIndex: number): Phase {
  const line = LINES[lineId]
  const cycle = line.phases.reduce((s, p) => s + p.days, 0)
  let t = (dayIndex + line.offset) % cycle
  for (const p of line.phases) {
    if (t < p.days) return p
    t -= p.days
  }
  return line.phases[line.phases.length - 1]
}

const att = (id: string, response: Response) => ({ id, response })

/** 邮件候选：按各工作线当天所处阶段给出（收件人用通讯录 ID） */
function mailCandidates(dayIndex: number): MailDraft[] {
  const out: MailDraft[] = []
  const bp = phaseOf('budget', dayIndex).topic
  if (bp === '预算初稿')
    out.push({ hour: 9, from: 'u_me', to: ['u_wang', 'u_limin'], subject: '【预算】Q4 预算初稿 v0.3，请过目', body: ['各位：', 'Q4 预算初稿见附件，口径按财务 22 号文执行。', '服务器费用单独列支，移动端推广费按上季度 1.2 倍估算。', '周五评审会前请反馈意见。', '陈思远'], sent: true })
  if (bp === '预算评审')
    out.push({ hour: 11, from: 'u_limin', to: ['u_me'], subject: 'RE: 【预算】评审意见汇总（两处口径）', body: ['思远：', '评审会的意见我汇总好了，两处口径问题需要你确认：', '1. 人均费用按在岗还是编制；2. 推广费是否单列。', '详见附件，今天 17:00 前回我。'] })
  if (bp === '预算调整（砍 8%）')
    out.push({ hour: 10, from: 'u_wang', to: ['u_me', 'u_limin', 'u_zhaolei'], subject: '【预算】整体口径调整：砍 8%', body: ['各线负责人：', '管理层决定 Q4 预算整体削减 8%，为硬指标。', '请各条线周五前提交调整后的版本，优先压缩渠道类费用。', '有困难当面来谈。'] })
  if (bp === '预算定稿')
    out.push({ hour: 16, from: 'u_me', to: ['u_wang'], subject: '【预算】Q4 定稿版已提交财务', body: ['王总：', '定稿版已按砍 8% 后的口径提交财务审批，流转号 CT-1104。', '执行率我会按月跟踪汇报。', '陈思远'], sent: true })
  const sp = phaseOf('supply', dayIndex).topic
  if (sp === '报错排查')
    out.push({ hour: 14, from: 'u_zhaolei', to: ['u_me', 'u_sunhao'], subject: '【联调】接口报错清单（-1002 等）', body: ['今天联调的问题清单如下：', '1. 下单回传 -1002，错误码表未定义；', '2. 回调超时集中在 200ms 断开。', '已推动供应商今晚出补丁。'] })
  if (sp === '联调通过')
    out.push({ hour: 15, from: 'u_sunhao', to: ['u_me'], subject: '【联调】全量用例 100% 通过', body: ['思远：', '全量 217 个用例跑完，通过率 100%。', '联调环境保留到月底，压测可直接复用。', '结论请更新进报告。'] })
  if (sp === '接口压测')
    out.push({ hour: 17, from: 'u_liuyang', to: ['u_me'], cc: ['u_zhaolei'], subject: '【压测】报告初稿：平均 82ms @500QPS', body: ['压测报告初稿见附件，核心数据：', '平均响应 82ms，P99 210ms，错误率 0.02%。', '500 QPS 下供应商限流阈值未触发，结论达标。'] })
  const dp = phaseOf('dash', dayIndex).topic
  if (dp === '看板需求')
    out.push({ hour: 10, from: 'u_me', to: ['u_hejing', 'u_limin', 'u_liuyang'], subject: '【看板 2.0】需求文档 v1.2', body: ['各位：', '看板 2.0 需求文档 v1.2 已上传门户，核心变化：', '1. 核心指标 T+1 改为准实时；2. 砍掉 3 个低频图表。', '周四 14:00 评审会讨论。', '陈思远'], sent: true })
  if (dp === '看板灰度')
    out.push({ hour: 9, from: 'u_liuyang', to: ['u_me'], subject: '【看板 2.0】灰度日报（D1）', body: ['灰度 10% 首日数据：', 'DAU 持平，平均加载时长 1.2s → 0.7s（-40%）。', '报错率 0.03%，无新增告警。明天继续盯。'] })
  if (dp === '看板上线')
    out.push({ hour: 11, from: 'u_hejing', to: ['u_wang', 'u_limin'], cc: ['u_me'], subject: '【看板 2.0】全量上线公告', body: ['各位：', '数据看板 2.0 已于今日 10:00 全量上线。', '感谢项目组，复盘会下周三 15:00。'] })
  const mp = phaseOf('mobile', dayIndex).topic
  if (mp === '需求收集')
    out.push({ hour: 13, from: 'u_zhouting', to: ['u_me'], subject: '【移动端】客户需求清单（5 项）', body: ['思远：', '客户这周提了 5 个移动端需求，按原话整理成清单。', '优先级你来定，我猜 P0 是手势优化和离线缓存。'] })
  if (mp === '需求评审会')
    out.push({ hour: 17, from: 'u_me', to: ['u_zhouting', 'u_liuyang'], subject: '【移动端】评审纪要与结论', body: ['纪要如下：', 'P0 两项（手势优化、离线缓存）评审通过；其余 3 项排 P2。', '验收标准按会上修订版执行。', '陈思远'], sent: true })
  const rp = phaseOf('review', dayIndex).topic
  if (rp === '述职通知')
    out.push({ hour: 9, from: 'u_hanxue', to: ['u_me', 'u_limin', 'u_zhaolei'], subject: '【述职】时间安排与模板下载', body: ['各位：', '年度述职 11 月下旬开始，材料 11 月 15 日前提交。', '模板请从门户下载最新版，旧模板已作废。'] })
  if (rp === '述职材料准备')
    out.push({ hour: 20, from: 'u_me', to: ['u_wang'], subject: '述职提纲 v1，请王总过目', body: ['王总：', '提纲按「业务结果 / 方法沉淀 / 明年规划」三块组织。', '量化数据在补充中，周四前给完整版。', '陈思远'], sent: true })
  return out
}

const MAIL_NOISE: MailDraft[] = [
  { hour: 16, from: 'u_machao', to: ['u_wang'], cc: ['u_me'], subject: 'RE: 部门月度经营分析（10 月）', body: ['10 月经营分析已更新门户，两点提醒：', '1. 供应链线成本环比 +6%；2. 移动端获客 CPA 走高。', '详见附件。'] },
  { hour: 12, from: 'u_tangyue', to: ['u_wubin', 'u_zhengjie'], cc: ['u_me'], subject: '食堂菜单投票（本周）', body: ['本周菜单投票开始：', 'A 酸菜鱼 / B 麻辣香锅 / C 轻食沙拉。', '周三 14:00 截止。'] },
  { hour: 10, from: { name: '信息安全中心', address: 'sec@example.com' }, to: ['u_wubin'], cc: ['u_me'], subject: '信息安全月度提醒：请勿使用弱口令', body: ['本月安全扫描发现 3 个弱口令账号，已重置。', '请各团队自查，门户有检查工具。'] },
]

function buildDayPlan(dk: string, r: () => number): DayPlan {
  const dayStart = fromLocal(Number(dk.slice(0, 4)), Number(dk.slice(5, 7)), Number(dk.slice(8, 10)))
  const l = local(dayStart)
  const wd = l.wd
  const weekend = wd >= 6
  const dayIndex = Math.round((dayStart - ANCHOR) / DAY_MS)

  const focus: Record<string, string> = {}
  for (const [sid, lines] of Object.entries(SESSION_LINES)) focus[sid] = lines.length === 1 ? lines[0] : lines[Math.floor(r() * lines.length)]

  const plan: DayPlan = {
    focus,
    weeklyFocus: SESSION_LINES.g_weekly[Math.floor(r() * SESSION_LINES.g_weekly.length)],
    mention: { h: int(r, 9, 11), sess: pick(r, STORY_GROUPS) },
    directed: { h: int(r, 14, 16), sess: pick(r, STORY_GROUPS) },
    reply: { h: int(r, 10, 16), sess: pick(r, STORY_GROUPS) },
    priv: { h: int(r, 10, 17), sess: pick(r, PRIVATE_IDS) },
    events: [],
    mails: [],
  }
  if (weekend) {
    const off = { h: -1, sess: '' }
    plan.mention = plan.directed = plan.reply = plan.priv = off
  }

  // ── 日程：工作日 1–3 个；月度固定事件（15 号全员会、8/22 号全天培训） ──
  const evs: EvDraft[] = []
  if (wd === 1) {
    evs.push({
      title: '产品周会', minute: 10 * 60, durMin: 90, organizer: 'u_wang',
      attendees: [att('u_me', 'accepted'), att('u_limin', 'accepted'), att('u_zhaolei', 'tentative'), att('u_zhouting', 'accepted'), att('u_sunhao', 'accepted'), att('u_liuyang', 'accepted'), att('u_hejing', 'accepted')],
      location: '会议室 A / 线上', notes: '每周产品线对齐：进展、风险、下周计划',
    })
  }
  if (l.d === 15) evs.push({ title: '科技部全员季度会', minute: 17 * 60, durMin: 60, organizer: 'u_machao', attendees: [att('u_me', 'declined'), att('u_wubin', 'accepted')], location: 'B1 报告厅', notes: '季度经营通报（我请假）' })
  if (!weekend && (l.d === 8 || l.d === 22)) evs.push({ title: '数据安全培训（全天）', minute: 0, durMin: 24 * 60, allDay: true, organizer: 'u_hanxue', attendees: [att('u_me', 'accepted')], location: '线上', notes: '年度必修，完成后有考试' })
  if (!weekend) {
    const candidates: EvDraft[] = []
    const topics = (Object.keys(LINES) as string[]).map((id) => phaseOf(id, dayIndex).topic)
    if (topics.includes('预算评审'))
      candidates.push({ title: 'Q4 预算评审会', minute: 14 * 60, durMin: 60, organizer: 'u_me', attendees: [att('u_wang', 'accepted'), att('u_limin', 'accepted'), att('u_zhaolei', 'accepted')], location: '会议室 C', notes: '过争议项：推广费、服务器 buffer' })
    if (topics.includes('设计评审'))
      candidates.push({ title: '看板 2.0 设计评审', minute: 15 * 60, durMin: 60, organizer: 'u_me', attendees: [att('u_hejing', 'accepted'), att('u_limin', 'accepted'), att('u_liuyang', 'accepted')], location: '线上', notes: '交互方案与埋点确认' })
    if (topics.includes('需求评审会'))
      candidates.push({ title: '移动端需求评审会', minute: 10 * 60, durMin: 60, organizer: 'u_zhouting', attendees: [att('u_me', 'accepted'), att('u_liuyang', 'accepted')], location: '会议室 A', notes: 'P0 两项的验收标准' })
    if (topics.includes('报错排查'))
      candidates.push({ title: '供应商联调对齐会', minute: 16 * 60, durMin: 30, organizer: 'u_zhaolei', attendees: [att('u_me', 'accepted'), att('u_sunhao', 'accepted'), att('u_liuyang', 'tentative')], location: '线上', notes: '-1002 报错定位进展' })
    while (candidates.length && evs.length < 2 && r() < 0.8) evs.push(candidates.splice(Math.floor(r() * candidates.length), 1)[0])
    if (r() < 0.3) evs.push({ title: '1:1 · 王总', minute: 16 * 60 + 30, durMin: 30, organizer: 'u_wang', attendees: [att('u_me', 'accepted')], location: '王总办公室', notes: '近期重点事项同步' })
    if (r() < 0.35) evs.push({ title: '设计组周会', minute: 11 * 60, durMin: 45, organizer: 'u_linfang', attendees: [att('u_huangli', 'accepted'), att('u_gaoxiang', 'accepted')], location: '会议室 B', notes: '与我无关：设计组内部' })
    if (evs.length === 0) evs.push({ title: '需求对齐（产品组）', minute: 15 * 60, durMin: 30, organizer: 'u_me', attendees: [att('u_limin', 'accepted'), att('u_zhouting', 'accepted')], location: '工位白板', notes: '日常对齐' })
  }
  for (const e of evs) e.editable = r() < 0.12
  plan.events = evs.slice(0, 3)

  // ── 邮件：工作日 2–6 封 ──
  if (!weekend || r() < 0.3) {
    const cand = [...mailCandidates(dayIndex), ...MAIL_NOISE]
    const count = weekend ? 1 : int(r, 2, 6)
    const shuffled: MailDraft[] = []
    while (cand.length && shuffled.length < count) shuffled.push(cand.splice(Math.floor(r() * cand.length), 1)[0])
    plan.mails = shuffled
  }
  return plan
}

// ───────────────────────── 消息生成 ─────────────────────────

interface Draft {
  sessionId: string
  senderId: string
  minute: number
  second: number
  text: string
  kind: string
  isSystem: boolean
  mentions: string[]
  mentionAll: boolean
  replyWanted: boolean
  directed: boolean
  recallable: boolean
}

type SessClass = 'story' | 'weekly' | 'hrbp' | 'dept' | 'ops' | 'ann' | 'private'

function sessClass(id: string): SessClass {
  if (id === 'g_weekly') return 'weekly'
  if (id === 'g_hrbp') return 'hrbp'
  if (id === 'g_dept') return 'dept'
  if (id === 'g_ops') return 'ops'
  if (id === 'g_ann') return 'ann'
  if (SESSION_LINES[id]) return 'story'
  return 'private'
}

/** 工作日 9–12、14–19 密集，午休和晚上稀疏，周末零星 */
function hourWeight(cls: SessClass, wd: number, h: number): { p: number; lo: number; hi: number } {
  const work = wd <= 5
  const dense = h >= 9 && h < 12
  const afternoon = h >= 14 && h < 19
  const lunch = h === 12 || h === 13
  switch (cls) {
    case 'dept':
      if (work) {
        if (dense || afternoon) return { p: 0.98, lo: 8, hi: 16 }
        if (lunch) return { p: 0.7, lo: 4, hi: 8 }
        if (h === 19 || h === 20) return { p: 0.4, lo: 3, hi: 6 }
        return { p: 0.06, lo: 1, hi: 2 }
      }
      return h >= 10 && h < 21 ? { p: 0.5, lo: 4, hi: 9 } : { p: 0.05, lo: 1, hi: 2 }
    case 'ops':
      return h >= 8 && h <= 22 ? { p: 0.65, lo: 1, hi: 4 } : { p: 0.2, lo: 1, hi: 2 }
    case 'ann':
      return work && h >= 9 && h <= 18 ? { p: 0.07, lo: 1, hi: 1 } : { p: 0, lo: 0, hi: 0 }
    case 'story':
      if (!work) return h >= 10 && h <= 20 ? { p: 0.03, lo: 1, hi: 2 } : { p: 0, lo: 0, hi: 0 }
      if (dense) return { p: 0.75, lo: 2, hi: 7 }
      if (afternoon) return { p: 0.5, lo: 1, hi: 5 }
      if (lunch) return { p: 0.15, lo: 1, hi: 2 }
      if (h === 19) return { p: 0.2, lo: 1, hi: 3 }
      return { p: 0.02, lo: 1, hi: 2 }
    case 'weekly':
      if (wd === 1) {
        if ((h >= 9 && h < 12) || (h >= 14 && h < 17)) return { p: 0.9, lo: 3, hi: 8 }
        return { p: 0.2, lo: 1, hi: 3 }
      }
      if (!work) return { p: 0.02, lo: 1, hi: 2 }
      if (dense || afternoon) return { p: 0.15, lo: 1, hi: 3 }
      return { p: 0.03, lo: 1, hi: 2 }
    case 'hrbp':
      if (!work) return { p: 0.02, lo: 1, hi: 2 }
      return h >= 9 && h <= 18 ? { p: 0.12, lo: 1, hi: 3 } : { p: 0.02, lo: 1, hi: 2 }
    case 'private':
      if (!work) return h >= 10 && h <= 20 ? { p: 0.04, lo: 1, hi: 2 } : { p: 0, lo: 0, hi: 0 }
      if (h >= 9 && h <= 19) return { p: 0.22, lo: 1, hi: 3 }
      return { p: 0.02, lo: 1, hi: 2 }
  }
}

function entryToDraft(sess: Session, e: LineEntry, r: () => number, minute: number): Draft {
  return {
    sessionId: sess.id,
    senderId: e.who,
    minute: Math.min(59, minute),
    second: Math.floor(r() * 60),
    text: pick(r, e.texts),
    kind: e.kind ?? 'text',
    isSystem: e.who === 'u_ops_bot',
    mentions: e.mentionMe ? ['u_me'] : [],
    mentionAll: e.mentionAll === true,
    replyWanted: e.replyToMine === true,
    directed: e.directed === true,
    recallable: false,
  }
}

/** 补齐撤回标记（发出 30 分钟后撤回，只允许前 25 分钟内发出的消息，保证通知不跨小时） */
function finalize(drafts: Draft[], r: () => number): Draft[] {
  for (const d of drafts) d.recallable = d.minute < 25 && r() < 0.01
  drafts.sort((a, b) => a.minute - b.minute || a.second - b.second)
  return drafts
}

interface Gen {
  seed: string
  planCache: Map<string, DayPlan>
}

function dayPlanOf(g: Gen, dk: string): DayPlan {
  let p = g.planCache.get(dk)
  if (!p) {
    p = buildDayPlan(dk, mulberry32(fnv(`${g.seed}|plan|${dk}`)))
    g.planCache.set(dk, p)
  }
  return p
}

function composeSessionHour(g: Gen, sess: Session, hourStart: number): Draft[] {
  const dk = dayKey(hourStart)
  const l = local(hourStart)
  const plan = dayPlanOf(g, dk)
  const r = mulberry32(fnv(`${g.seed}|${sess.id}|${dk}|${l.h}`))
  const cls = sessClass(sess.id)
  const w = hourWeight(cls, l.wd, l.h)

  const forced =
    plan.mention.sess === sess.id && plan.mention.h === l.h ? 'mention'
    : plan.directed.sess === sess.id && plan.directed.h === l.h ? 'directed'
    : plan.reply.sess === sess.id && plan.reply.h === l.h ? 'reply'
    : plan.priv.sess === sess.id && plan.priv.h === l.h ? 'priv'
    : null
  if (!forced && r() >= w.p) return []
  const dayIndex = Math.round((startOfDay(hourStart) - ANCHOR) / DAY_MS)
  const n = forced ? Math.max(2, int(r, w.lo, w.hi)) : int(r, w.lo, w.hi)
  if (n <= 0) return []

  const minuteOf = (i: number) => Math.min(59, Math.floor(((i + r() * 0.8) * 60) / n))

  if (cls === 'ops') {
    const drafts: Draft[] = []
    for (let i = 0; i < n; i++) drafts.push(entryToDraft(sess, pick(r, OPS_POOL), r, minuteOf(i)))
    return finalize(drafts, r)
  }
  if (cls === 'ann') {
    return finalize([entryToDraft(sess, pick(r, ANN_POOL), r, int(r, 0, 59))], r)
  }
  if (cls === 'dept') {
    const drafts: Draft[] = []
    for (let i = 0; i < n; i++) drafts.push(entryToDraft(sess, r() < 0.08 ? pick(r, DEPT_ADMIN) : pick(r, DEPT_CHAT), r, minuteOf(i)))
    return finalize(drafts, r)
  }
  if (cls === 'private') {
    const pool = PRIVATE_POOLS[sess.id]
    const drafts: Draft[] = []
    for (let i = 0; i < n; i++) drafts.push(entryToDraft(sess, pool[i % pool.length], r, minuteOf(i)))
    return finalize(drafts, r)
  }

  // story / weekly / hrbp：工作线台词 + 通用口水话
  const lineId = cls === 'hrbp' ? 'review' : cls === 'weekly' ? plan.weeklyFocus : plan.focus[sess.id]
  const activityScale = cls === 'hrbp' ? phaseOf('review', dayIndex).activity : cls === 'story' ? phaseOf(lineId, dayIndex).activity : 1
  if (!forced && r() > activityScale) return []
  const basePool: LineEntry[] = cls === 'weekly' ? WEEKLY_POOL : cls === 'hrbp' ? HRBP_POOL : phaseOf(lineId, dayIndex).pool
  const shuffled = [...basePool]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  let ptr = 0
  const myEntries = shuffled.filter((e) => e.who === 'u_me')
  const castIds = basePool.map((e) => e.who).filter((id) => id !== 'u_me' && id !== 'u_admin')
  const myActive = r() < (cls === 'weekly' ? 0.7 : 0.45)
  let usedMine = false
  const drafts: Draft[] = []
  for (let i = 0; i < n; i++) {
    if (myActive && !usedMine && myEntries.length > 0 && (i === 1 || i === n - 1)) {
      drafts.push(entryToDraft(sess, myEntries[drafts.length % myEntries.length], r, minuteOf(i)))
      usedMine = true
      continue
    }
    const e = ptr < shuffled.length && r() < 0.55 ? shuffled[ptr++] : { who: pick(r, castIds), texts: FILLERS }
    drafts.push(entryToDraft(sess, e, r, minuteOf(i)))
  }

  // 每日保底注入（五种参与形态每个工作日至少各一次）
  if (forced === 'mention') {
    drafts.push(entryToDraft(sess, { who: pick(r, castIds), texts: MENTION_TEXTS, mentionMe: true }, r, int(r, 0, 59)))
  } else if (forced === 'directed') {
    drafts.push(entryToDraft(sess, { who: pick(r, castIds), texts: DIRECTED_TEXTS, directed: true }, r, int(r, 0, 59)))
  } else if (forced === 'reply') {
    drafts.unshift(entryToDraft(sess, { who: 'u_me', texts: REPLY_ME_TEXTS }, r, Math.min(5, minuteOf(0))))
    drafts.push(entryToDraft(sess, { who: pick(r, castIds), texts: REPLY_TEXTS, replyToMine: true }, r, int(r, 12, 50)))
  }

  // 同会话同小时内容完全相同的转发（降噪测试素材）；只有本阶段有别的发言人时才转发
  if (drafts.length >= 3 && r() < 0.12) {
    const src = drafts[Math.floor(r() * drafts.length)]
    const others = castIds.filter((id) => id !== src.senderId)
    if (others.length > 0) {
      const who = pick(r, others)
      drafts.push({ ...src, senderId: who, second: Math.min(59, src.second + 1), replyWanted: false, directed: false, mentions: [], mentionAll: false })
    }
  }
  return finalize(drafts, r)
}

/** 生成某个整点小时内全部消息（跨会话排序、ID 分配、回复解析、撤回替换） */
function buildHour(g: Gen, hourStart: number, now: number): ImMessage[] {
  const l = local(hourStart)
  const stamp = dayKey(hourStart).replaceAll('-', '') + String(l.h).padStart(2, '0')
  const all: Draft[] = []
  for (const sess of SESSIONS) all.push(...composeSessionHour(g, sess, hourStart))

  // 撤回：发出 30 分钟后从客户端消失，换成一条系统提示
  const kept: Draft[] = []
  for (const d of all) {
    const time = hourStart + d.minute * 60_000 + d.second * 1000
    if (d.recallable && now >= time + 30 * 60_000) {
      kept.push({ ...d, text: `${person(d.senderId).name} 撤回了一条消息`, kind: 'recall', isSystem: true, mentions: [], mentionAll: false, replyWanted: false, directed: false, minute: Math.min(59, d.minute + 30), recallable: false })
    } else kept.push(d)
  }
  kept.sort((a, b) => a.minute - b.minute || a.second - b.second || (a.sessionId < b.sessionId ? -1 : 1))

  const msgs: ImMessage[] = kept.map((d, i) => ({
    id: `m_${stamp}_${String(i).padStart(3, '0')}`,
    sessionId: d.sessionId,
    senderId: d.senderId,
    senderName: person(d.senderId).name,
    time: hourStart + d.minute * 60_000 + d.second * 1000,
    text: d.text,
    kind: d.kind,
    isSystem: d.isSystem,
    mentions: d.mentions,
    mentionAll: d.mentionAll,
    replyToId: null,
    directedToMe: d.directed,
  }))
  // 回复我：指向同会话本小时内我更早的一条
  for (let i = 0; i < kept.length; i++) {
    if (!kept[i].replyWanted) continue
    let target = -1
    for (let j = 0; j < i; j++) if (kept[j].sessionId === kept[i].sessionId && kept[j].senderId === 'u_me') target = j
    if (target >= 0) msgs[i].replyToId = msgs[target].id
  }
  return msgs
}

// ───────────────────────── 日程 / 邮件生成 ─────────────────────────

function buildEvents(g: Gen, dk: string, now: number): CalendarEvent[] {
  const plan = dayPlanOf(g, dk)
  const dayStart = fromLocal(Number(dk.slice(0, 4)), Number(dk.slice(5, 7)), Number(dk.slice(8, 10)))
  return plan.events
    .map((e) => {
      const start = dayStart + e.minute * 60_000
      const edited = e.editable === true && now >= start + 2 * DAY_MS
      return {
        title: e.title,
        start,
        end: start + e.durMin * 60_000,
        allDay: e.allDay === true,
        organizer: person(e.organizer),
        attendees: e.attendees.map((a) => ({ ...person(a.id), response: a.response })),
        location: e.location + (edited ? '（已调整）' : ''),
        notes: e.notes + (edited ? '（议程已更新）' : ''),
        updatedAt: edited ? start + 2 * DAY_MS : start,
      }
    })
    .sort((a, b) => a.start - b.start || a.title.localeCompare(b.title))
    .map((e, i) => ({ ...e, id: `ev_${dk.replaceAll('-', '')}_${String(i).padStart(2, '0')}` }))
}

function buildMails(g: Gen, dk: string): Mail[] {
  const plan = dayPlanOf(g, dk)
  const r = mulberry32(fnv(`${g.seed}|mail|${dk}`))
  const addr = (id: string | { name: string; address: string }) =>
    typeof id === 'string' ? { name: person(id).name, address: P[id]?.email ?? 'unknown@example.com' } : id
  const byHour = new Map<number, number>()
  return plan.mails.map((m) => {
    const hour = Math.min(23, m.hour + (r() < 0.3 ? 1 : 0))
    const seq = byHour.get(hour) ?? 0
    byHour.set(hour, seq + 1)
    return {
      id: `mail_${dk.replaceAll('-', '') + String(hour).padStart(2, '0')}_${String(seq).padStart(2, '0')}`,
      subject: m.subject,
      from: addr(m.from),
      to: m.to.map(addr),
      cc: (m.cc ?? []).map(addr),
      time: fromLocal(Number(dk.slice(0, 4)), Number(dk.slice(5, 7)), Number(dk.slice(8, 10)), hour, Math.floor(r() * 60)),
      text: m.body.join('\n'),
      folder: m.sent ? 'sent' : 'inbox',
    }
  })
}

// ───────────────────────── SourceAdapter 实现 ─────────────────────────

export function createMockSource(sctx: SourceContext): SourceAdapter {
  const seed = String(sctx.options['seed'] ?? 'ctx-demo')
  const imDownDays = new Set(Array.isArray(sctx.options['imDownDays']) ? (sctx.options['imDownDays'] as string[]) : [])
  const down = sctx.options['down'] === true
  const g: Gen = { seed, planCache: new Map() }
  const now = () => sctx.now()
  const fail = () => {
    throw new SourceUnavailableError('仿真客户端不可用（down）')
  }

  const retentionDays = { im: 7, mail: 90, calendar: 90 }

  function eachHour(range: TimeRange, fn: (hourStart: number) => void) {
    for (let t = Math.floor(range.from / HOUR_MS) * HOUR_MS; t < range.to; t += HOUR_MS) fn(t)
  }
  function eachDay(range: TimeRange, fn: (dk: string) => void) {
    for (let t = startOfDay(range.from); t < range.to; t += DAY_MS) fn(dayKey(t))
  }

  return {
    name: '仿真客户端（演示）',
    retentionDays,

    me: async () => {
      if (down) fail()
      return { ...ME }
    },
    contacts: async () => {
      if (down) fail()
      return PEOPLE.map((p): Contact => ({ id: p.id, name: p.name, email: p.email }))
    },
    sessions: async () => {
      if (down) fail()
      return SESSIONS.map((s) => ({ ...s }))
    },

    messages: async (range) => {
      if (down) fail()
      const n = now()
      for (let t = startOfDay(range.from); t < range.to; t += DAY_MS) {
        if (imDownDays.has(dayKey(t))) throw new SourceUnavailableError(`仿真客户端：${dayKey(t)} 当天 IM 不可用`)
      }
      const out: ImMessage[] = []
      const from = Math.max(range.from, n - retentionDays.im * DAY_MS)
      const to = Math.min(range.to, n)
      eachHour({ from, to }, (hourStart) => {
        for (const m of buildHour(g, hourStart, n)) if (m.time >= from && m.time < to) out.push(m)
      })
      return out
    },

    events: async (range) => {
      if (down) fail()
      const n = now()
      const from = Math.max(range.from, n - retentionDays.calendar * DAY_MS)
      const to = Math.min(range.to, n + 30 * DAY_MS)
      const out: CalendarEvent[] = []
      eachDay({ from, to }, (dk) => {
        for (const e of buildEvents(g, dk, n)) if (e.start >= from && e.start < to) out.push(e)
      })
      return out
    },

    mails: async (range) => {
      if (down) fail()
      const n = now()
      const from = Math.max(range.from, n - retentionDays.mail * DAY_MS)
      const to = Math.min(range.to, n)
      const out: Mail[] = []
      eachDay({ from, to }, (dk) => {
        for (const m of buildMails(g, dk)) if (m.time >= from && m.time < to) out.push(m)
      })
      return out
    },

    findMessage: async (id) => {
      if (down) fail()
      const m = /^m_(\d{4})(\d{2})(\d{2})(\d{2})_\d{3}$/.exec(id)
      if (!m) return null
      const n = now()
      const found = buildHour(g, fromLocal(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])), n).find((x) => x.id === id)
      if (!found) return null
      return found.time > n - retentionDays.im * DAY_MS && found.time <= n ? found : null
    },
    findMail: async (id) => {
      if (down) fail()
      const m = /^mail_(\d{4})(\d{2})(\d{2})(\d{2})_\d{2}$/.exec(id)
      if (!m) return null
      const n = now()
      const found = buildMails(g, `${m[1]}-${m[2]}-${m[3]}`).find((x) => x.id === id)
      if (!found) return null
      return found.time > n - retentionDays.mail * DAY_MS && found.time <= n ? found : null
    },
    findEvent: async (id) => {
      if (down) fail()
      const m = /^ev_(\d{4})(\d{2})(\d{2})_\d{2}$/.exec(id)
      if (!m) return null
      const n = now()
      const found = buildEvents(g, `${m[1]}-${m[2]}-${m[3]}`, n).find((x) => x.id === id)
      if (!found) return null
      return found.start >= n - retentionDays.calendar * DAY_MS && found.start < n + 30 * DAY_MS ? found : null
    },
  }
}
