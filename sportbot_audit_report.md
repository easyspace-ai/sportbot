# SportBot 代码审计报告

Sports Prediction Market Router · 全面分析 & 修复方案

仓库: github.com/easyspace-ai/sportbot  ·  分析日期: 2026-05-08

| 🔴 严重 Bug：2 个（移动止损核心缺陷） | 🟡 安全隐患：4 个（含认证、CORS） | 🟢 性能优化：3 个（N+1、串行 API） |
| --- | --- | --- |

---

# 一、移动止损失败 — 根本原因诊断

经过对整个代码库的全面分析，确认移动止损（Trailing Stop）失败的直接原因有两个，互相叠加导致止损系统完全失效。

## Bug #1（致命）：`running` 任务在进程重启后永久卡死

这是最核心的 Bug，直接导致止损触发后订单永远无法成交。

**问题位置**

```
apps/bot/src/services/riskService.ts  →  processRiskTasksOnce()
```

**问题描述**

`processRiskTasksOnce` 运行流程如下：

- 取出 `status = 'pending'` 或 `'failed'` 的任务
- 立即将任务状态设为 `'running'`
- 调用 `executePolymarketSell` 执行卖出
- 成功 → 设为 `'succeeded'`；失败 → 设为 `'failed'` 并按退避算法设置 `nextRunAt` 重试

致命缺陷：如果进程在第 2～3 步之间崩溃（OOM、SIGKILL、手动 `docker restart`），任务状态被永久留在 `'running'`。

重启后 `processRiskTasksOnce` 的查询条件是：

```ts
where: { status: { in: ['pending', 'failed'] }, nextRunAt: { lte: new Date() } }
```

**`'running'` 不在查询条件中，任务从此被永远跳过，止损仓位再也不会被平掉。**

**修复方案**（`apps/bot/src/index.ts` `main()` 函数，数据库连接后立即添加）

```ts
// ✅ 修复：启动时将卡死的 running 任务重置为 pending
await prisma.riskTask.updateMany({
  where: { status: 'running' },
  data: {
    status: 'pending',
    nextRunAt: new Date(),
    lastError: 'reset_after_restart',
  },
});
log.info('risk: reset stale running tasks on startup');
```

---

## Bug #2（严重）：缺少手动调整止损价的 API 端点

仪表板 `RiskControl` 页面展示了每个持仓的 `stopLossPct` 和 `highWaterCents`，但整个代码库中不存在任何 PATCH/PUT 接口可修改这两个字段。

- 用户无法手动「移动」止损线到合适位置
- 若市场出现剧烈波动，无法临时收紧或放宽单个持仓的止损比例
- 唯一修改途径是直接操作 SQLite 数据库，生产环境完全不可行

**修复方案**（在 `apps/bot/src/routes/risk.ts` 末尾添加）

```ts
// ✅ 新增：手动移动止损端点
router.patch('/api/risk/positions/:id', async (req, res) => {
  const { id } = req.params;
  const body = req.body as { stopLossPct?: number; highWaterCents?: number };

  const update: Prisma.RiskPositionUpdateInput = {};

  if (body.stopLossPct != null) {
    if (body.stopLossPct < 1 || body.stopLossPct > 99)
      return res.status(400).json({ error: 'stopLossPct must be 1-99' });
    update.stopLossPct = body.stopLossPct;
  }
  if (body.highWaterCents != null) {
    if (body.highWaterCents <= 0 || body.highWaterCents > 100)
      return res.status(400).json({ error: 'highWaterCents must be 0-100' });
    update.highWaterCents = body.highWaterCents;
  }
  if (Object.keys(update).length === 0)
    return res.status(400).json({ error: 'no updatable fields' });

  const pos = await prisma.riskPosition.update({
    where: { id },
    data: update,
  });
  log.info({ id, update }, 'risk position stop updated manually');
  res.json({ ok: true, position: pos });
});
```

---

## Bug #3（中等）：`ensureCloseTask` 存在 TOCTOU 竞态

当 `riskEvaluateTokenAfterBookUpdate` 与 `processRiskTasksOnce` 同时运行（前者是 WS 事件驱动，后者是 3s 定时器），两次 `findFirst + create` 可能同时插入重复的 `close_position` 任务，导致同一持仓被提交两笔卖单。

**修复方案**（`riskService.ts` → `ensureCloseTask`）

```ts
// ✅ 修复：用 upsert + 唯一约束代替 findFirst + create
// 先在 Prisma schema 添加唯一约束：
// @@unique([positionId, type, status], name: 'uq_active_task')
// 简单方案：捕获 unique constraint 异常
try {
  await prisma.riskTask.create({ data: { ... } });
} catch (e: any) {
  if (e?.code === 'P2002') return; // 已存在，幂等忽略
  throw e;
}
```

---

# 二、安全问题清单

## 安全漏洞 #1（高危）：API 完全无认证

- `POST /api/trade` 可让局域网任意主机签名并提交链上交易（花掉真实资金）
- `POST /api/risk/close-all` 可立即平掉所有持仓
- `PUT /api/config/:key` 可修改代理地址，注入 SSRF 攻击目标

**建议修复**

```ts
// apps/bot/src/middleware/auth.ts
import { timingSafeEqual } from 'crypto';

export function requireApiKey(req, res, next) {
  const token = req.headers['x-api-key'];
  const expected = process.env.BOT_API_KEY;
  if (!expected) return next(); // 未配置时跳过（向后兼容）
  if (!token || !timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
    return res.status(401).json({ error: 'unauthorized' });
  next();
}
// 在 app.ts 中对写操作路由挂载此中间件
```

---

## 安全漏洞 #2（中危）：CORS 完全开放

`app.use(cors())` 不限制来源，任何网页都可通过浏览器跨域调用本 Bot API，包括恶意广告页面触发的 CSRF。

**建议修复**

```ts
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3001'],
  methods: ['GET', 'POST', 'PUT', 'PATCH'],
}));
```

---

## 安全漏洞 #3（中危）：`/api/config` 暴露所有配置键值

`GET /api/config` 返回全部 `BotConfig` 行，包括 `telegramBotToken`、`httpPlatformProxyUrl` 等敏感字段，攻击者可用来盗取 Telegram Bot Token 并冒充 Bot 发消息，或获取代理服务器地址。

**建议修复**

```ts
const SENSITIVE_KEYS = new Set(['telegramBotToken', 'polymarketApiKey']);

router.get('/api/config', async (_req, res) => {
  const rows = await prisma.botConfig.findMany({ orderBy: { key: 'asc' } });
  res.json(rows.map(r =>
    SENSITIVE_KEYS.has(r.key) ? { key: r.key, value: '***' } : r
  ));
});
```

---

## 安全漏洞 #4（低危）：`HTTP_PLATFORM_PROXY_TLS_INSECURE` 允许禁用 TLS

当该环境变量为 `true` 时，CONNECT 隧道后的 HTTPS 连接不验证服务器证书。这意味着如果代理服务器被攻击者控制，所有 Polymarket/SX Bet API 流量（包含签名私钥信息）都可以被中间人拦截。

- 建议：在 `config.ts` 中对此选项添加日志警告，生产部署 CI 检查禁止此选项开启
- 理想状态：代理服务器使用受信任 CA 签发的证书，彻底移除此选项

---

# 三、性能优化方案

## 性能问题 #1（重要）：`listRiskPositionsEnriched` 的 N+1 查询

每次仪表板轮询（5 秒一次）都会触发 `listRiskPositionsEnriched`，对每个持仓串行执行：

- `bestBidCentsForRisk` → 读取内存缓存（快）或发起 CLOB REST 请求（慢）
- `updateHighWaterAndMaybeQueueStop` → 一次 DB read + 可能一次 DB write

10 个持仓 = 10 次串行操作，延迟叠加。当 CLOB REST 需要 fallback 时，每次可能耗时 200–500ms，10 个持仓总共可能堵塞 5 秒，完全堵死后续请求。

**优化方案：并行化 bid 价格读取**

```ts
// ✅ 将串行 for...await 改为 Promise.all
const bidCentsArr = await Promise.all(
  rows.map(p => bestBidCentsForRisk(p.tokenId))
);

for (let i = 0; i < rows.length; i++) {
  const p = rows[i];
  const bidCents = bidCentsArr[i];
  const result = await updateHighWaterAndMaybeQueueStop(p, bidCents);
  // ...
}
```

预期效果：10 个持仓的总延迟从 ~5s 降至最慢一个请求的时间（~500ms）。

---

## 性能问题 #2（重要）：`reconcileOpenRiskPositionsWithClobBalances` 串行 CLOB 调用

每次对账都对每个持仓串行调用 `client.getBalanceAllowance`，25 秒一次的对账可能因串行请求而耗时数秒并堵塞事件循环。

**优化方案：`Promise.allSettled` 并行**

```ts
// ✅ 串行改并行
await Promise.allSettled(
  rows.map(async (row) => {
    try {
      const bal = await client.getBalanceAllowance({ ... });
      // ... update logic
    } catch (err) {
      log.debug({ err, tokenId: row.tokenId }, 'reconcile skipped');
    }
  })
);
```

---

## 性能问题 #3（中等）：`processRiskTasksOnce` 的 `take: 8` 可能积压

每次最多处理 8 个任务，若短时间内大量止损触发（如市场暴跌），任务会积压。每 3 秒才能处理 8 个，可能导致止损执行延迟分钟级别。

**优化方案**

- 将 `take` 提升至 20–30，或按任务类型分组并发处理
- `close_position` 任务优先级高于 `close_all`，可用独立优先队列

```ts
// 短期修复：提升批量上限
take: 20,  // 从 8 → 20
```

---

# 四、项目整体架构优化建议

## 4.1  补全仪表板的移动止损 UI

当前 `RiskControl.tsx` 止损参数只读，应在表格中添加行内编辑，调用上述新增的 PATCH 端点：

- 点击「止损%」列直接编辑 → `PATCH /api/risk/positions/:id  { stopLossPct: 15 }`
- 点击「最高水位」列手动重置高水位 → `PATCH /api/risk/positions/:id  { highWaterCents: 72 }`
- 添加全局止损% 批量修改按钮（对所有 `open` 持仓统一调整）

## 4.2  Telegram 命令补全

当前 Telegram 仅有 `/status` 命令。止损相关高频操作建议补充：

| 命令 | 功能 |
| --- | --- |
| `/positions` | 列出所有持仓及当前止损触发价 |
| `/close <id>` | 手动平掉指定持仓 |
| `/setstop <id> <pct>` | 修改指定持仓的止损比例 |
| `/closeall` | 一键平仓（需二次确认） |

## 4.3  止损执行失败通知

当前 `executePolymarketSell` 失败后只写日志，用户无实时感知。建议：

- `close_position` 任务连续失败 3 次 → 立即推送 Telegram 警报
- 失败原因分类（`no_bid_liquidity`、`maker_not_allowed`、`balance_zero`）方便排查
- 止损成功执行 → Telegram 通知平仓结果（已卖出 X 份 @ Y¢，P&L: $Z）

## 4.4  WebSocket 连接健康监控

`polymarketUserWs` 的 `WS_STALE_MS = 75s`，Centrifugo 连接无自动健康检测端点。建议：

- `GET /api/health` 扩展返回 WS 连接状态（SX Centrifugo、Polymarket 市场 WS、用户 WS）
- 添加 prometheus-style `/metrics` 端点，VPS 部署时接入 Uptime Kuma

## 4.5  数据库优化

SQLite 在高频写入场景（每 3s 任务轮询 + WS 事件触发的 `highWater` 更新）容易产生写锁竞争。建议：

- 为 `RiskTask` 表添加索引：`@@index([status, nextRunAt])`
- 为 `RiskPosition` 表添加索引：`@@index([status, tokenId])`
- 中长期：若持仓数量超过 100，考虑迁移至 PostgreSQL，Prisma 仅需修改 `datasource provider`

---

# 五、修复优先级总览

| # | 问题 | 影响 | 修复成本 | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | `running` 任务卡死（Bug #1） | 移动止损完全失效 | 3 行代码 | 立即修复 🔴 |
| 2 | 缺少 `PATCH /risk/positions/:id` | 无法手动移动止损 | ~40 行 | 立即修复 🔴 |
| 3 | API 无认证（安全） | 任意主机触发交易 | ~30 行 | 今天修复 🟠 |
| 4 | CORS 全开（安全） | CSRF 攻击风险 | 5 行 | 今天修复 🟠 |
| 5 | `/api/config` 暴露敏感键（安全） | Token/配置泄露 | 10 行 | 本周修复 🟡 |
| 6 | N+1 查询 `listPositions` | 仪表板卡顿 5s+ | ~20 行 | 本周修复 🟡 |
| 7 | 串行 CLOB 对账 | 事件循环堵塞 | ~10 行 | 下次迭代 🟢 |
| 8 | TOCTOU 竞态 `ensureCloseTask` | 极少情况双重卖单 | ~15 行 | 下次迭代 🟢 |
| 9 | DB 缺少索引 | 高并发慢查询 | Prisma schema | 下次迭代 🟢 |
| 10 | Telegram 命令不完整 | 操作需开仪表板 | ~80 行 | 下次迭代 🟢 |

---

# 附录：完整修复清单（可直接提交的代码）

## Fix 1 — `apps/bot/src/index.ts`（在 `await prisma.$connect()` 后插入）

```ts
// 修复 Bug #1：重置卡死任务
await prisma.riskTask.updateMany({
  where: { status: 'running' },
  data: { status: 'pending', nextRunAt: new Date(), lastError: 'reset_after_restart' },
});
```

## Fix 2 — `apps/bot/src/routes/risk.ts`（`router` export 之前插入）

```ts
router.patch('/api/risk/positions/:id', async (req, res) => {
  const { id } = req.params;
  const { stopLossPct, highWaterCents } = req.body as Record<string, number>;
  const update: Record<string, number> = {};

  if (stopLossPct != null) {
    if (!Number.isFinite(stopLossPct) || stopLossPct < 1 || stopLossPct > 99)
      return res.status(400).json({ error: 'stopLossPct must be 1–99' });
    update.stopLossPct = stopLossPct;
  }
  if (highWaterCents != null) {
    if (!Number.isFinite(highWaterCents) || highWaterCents <= 0 || highWaterCents > 100)
      return res.status(400).json({ error: 'highWaterCents must be (0, 100]' });
    update.highWaterCents = highWaterCents;
  }
  if (!Object.keys(update).length)
    return res.status(400).json({ error: 'no updatable fields provided' });

  try {
    const pos = await prisma.riskPosition.update({ where: { id }, data: update });
    log.info({ id, update }, 'risk position stop updated manually');
    res.json({ ok: true, position: pos });
  } catch (err) {
    log.error({ err, id }, 'patch risk position failed');
    res.status(500).json({ error: 'internal_server_error' });
  }
});
```

## Fix 3 — `apps/bot/src/app.ts`（替换 cors 配置）

```ts
app.use(cors({
  origin: process.env.CORS_ALLOW_ORIGIN?.split(',') ?? ['http://localhost:5173'],
  methods: ['GET', 'POST', 'PUT', 'PATCH'],
  credentials: false,
}));
```

## Fix 4 — `apps/bot/src/services/riskService.ts`（`listRiskPositionsEnriched` 性能）

```ts
// 将串行循环替换为并行预取
const bidCentsArr = await Promise.all(
  rows.map(p => bestBidCentsForRisk(p.tokenId).catch(() => null))
);

for (let i = 0; i < rows.length; i++) {
  const p = rows[i];
  const bidCents = bidCentsArr[i];
  const { highWater, trailingStopCents, currentCents } =
    await updateHighWaterAndMaybeQueueStop(p, bidCents);
  // ...（其余 out.push 逻辑不变）
}
```

---

*报告完毕 · 如有疑问请联系开发团队*
