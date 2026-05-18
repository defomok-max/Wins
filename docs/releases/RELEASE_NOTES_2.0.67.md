## v2.0.67 — Quiet-window 自动 docker self-update（#112）

#112 wnfilm 选了"等用户请求少的时候再拉" 那种自动更新。这版做了。

### 行为

代理后台跑一个看门狗，每分钟 tick 一次。看最近 `windowMinutes`（默认 5 分钟）滑动窗口里观察到的 chat 请求数 — 如果不超过 `thresholdRequests`（默认 5 个）就算"lull"，触发已有的 docker self-update 流程（`runDockerSelfUpdate`：拉最新 image + spawn deployer sidecar 8 秒后重建容器）。

四道门保护误触发：

- `experimental.autoUpdateQuietWindow` 默认 **OFF** — 操作员从 dashboard 实验性面板手动开
- 冷启动 grace 10 分钟 — 容器刚起来环 buffer 是空的，不会被零流量误判成 lull
- 冷却期默认 24 小时 — 一次更新成功后 24h 内不会再拉，避免连续 ship 时反复抖
- 失败的更新**不**进入冷却 — 拉镜像失败、socket 没挂、compose 标签缺失等情况下下次 tick 还能再试

### 使用方式

需要 `/var/run/docker.sock` 挂进容器（`docker-compose.yml` 默认就有），且容器是用 `docker compose up` 起来的（compose labels 提供项目目录给 deployer sidecar）。这俩条件 `detectDockerSelfUpdate` 检测到位才工作。

dashboard `/dashboard/api/auto-update/quiet-window` 三个端点：

- `GET` 拿当前状态（enabled / 当前 ring 大小 / 最近一次 update 结果 / 当前 decision）
- `PUT {enabled: true|false}` 翻转开关（持久化到 runtime-config）
- `POST /run` 立刻 force 一次 tick — 调试时绕过 1min 周期，但仍然走完整 4 道门

实验性面板里的 toggle 后续 dashboard UI 接一下 — 这版只布服务端逻辑。

### 改动

**新模块 `src/dashboard/quiet-window-updater.js`**（约 230 行）：
- ring buffer 存最近请求时间戳，自动 prune + 容量限制（busy host 不会无限增长）
- `evaluateTick(now?)` 纯函数返回 `{run, reason, ...}` — 5 种 reason: `disabled` / `cold-start` / `cooldown` / `busy` / `eligible`，方便单元测试穷举
- `startQuietWindowAutoUpdate()` 用 `setInterval` 每分钟 tick，timer `unref()` 不阻断进程退出
- 测试 seam：`_injectForTest({now, runUpdate, startedAt})` 注入假时钟 + 假 update runner 不依赖 docker

**`src/runtime-config.js`**：加 `experimental.autoUpdateQuietWindow`（boolean）+ `autoUpdateQuietWindow.{windowMinutes, thresholdRequests, cooldownHours, coldStartGraceMs}`（数值 tunables）默认值。

**`src/index.js`**：boot 时调 `startQuietWindowAutoUpdate()`，shutdown 时 `stopQuietWindowAutoUpdate()`。

**`src/handlers/chat.js`**：`handleChatCompletions` 入口加一行 `markQuietWindowRequest()` — `/v1/chat/completions`、`/v1/messages`（→ chat.js）、`/v1/responses`（→ chat.js）三个端点都自动覆盖。

**`src/dashboard/api.js`**：3 个新路由（GET/PUT/POST 上述）。

### 数字

- 测试：702 → **719**（+17 新 case：isQuiet 5 个 / evaluateTick 决策树 6 个 / ring 容量 1 个 / start/stop idempotent 2 个 / getStatus 2 个 / setEnabled 持久化 1 个）
- 全测 0 fail
- 改动：1 新 src 文件 + 4 src 文件改 + 1 新 test 文件

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

启用：dashboard 实验性面板里翻 `autoUpdateQuietWindow` 开关，或者:

```bash
curl -X PUT http://your-host:3888/dashboard/api/auto-update/quiet-window \
  -H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

### 关 #112

wnfilm 选的"第 2 种 quiet-window 检测"这版做掉。不强迫凌晨固定时间，按真实流量空档自动更新；冷启动+冷却+失败不冷却三道保护避免误触发。
