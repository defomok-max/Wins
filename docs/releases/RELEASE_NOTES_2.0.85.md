## v2.0.85 — #126/#128 自动 model fallback + #127 LS orphan cleanup

### #126 KLFDan + #128 wnfilm — 撞 rate limit 自动重试 fallback model

v2.0.84 给了 `fallback_model` + `remediation` 字段但只是 hint，client 还要自己改 model。这版让 proxy 默认自动重试一次。

`handleChatCompletions` 加 outer wrapper：

1. 第一次 inner handler 跑完返 429 + `error.fallback_model`
2. wrapper 检测：non-stream + 不是已经 fallback + env 不是显式 OFF + error 含 fallback_model
3. 改 `body.model = fallback_model` 重发 inner handler 一次
4. 成功响应里 `body.model` 还原原始名（client 期望对应原 model id），加 `served_model` + `fallback_reason: "rate_limit_auto_fallback"` 旁侧字段

ladder：`max → xhigh → high → medium → low`，连串撞限流时 wrapper 只重试一档（不会 max → xhigh → high 三连重试，避免 quota 雪崩）。如果 xhigh 也限流，错误响应再带 `fallback_model: high` 让 client 决定要不要继续。

env 关：`WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=0`。

stream 路径不接（chunks 已可能开始 emit）—— stream client 看到 429 + fallback_model 自己决定 client-side retry。

### #127 123cek — dashboard 一键更新残留 orphan LS

dashboard `/self-update` 走 `process.exit(0)` 让 PM2 拉起新进程，但 SIGTERM hook 来不及跑或被 SIGKILL 跳过 → 旧 `language_server_linux_x64 --server_port=42105` 留着占端口 + 占内存，下次 self-update 又一个，累积。

两层修：

1. **self-update 退出前 stop**：`/self-update` setTimeout callback 改 async，先 `await import('../langserver.js').then(m => m.stopLanguageServer())` 优雅 SIGTERM 当前 LS pool 再 exit
2. **startup cleanup 兜底**：`src/index.js` 启动早期调 `cleanupOrphanLanguageServers()`：`ps -e -o pid=,args=` scan 找 argv 含 `_binaryPath` 或 `DEFAULT_BINARY` 的 PID 不在自己 `_pool` 里的 → SIGTERM。覆盖 SIGKILL / 上一波 self-update 还没修就遗留的 orphan

env 关 `WINDSURFAPI_SKIP_LS_CLEANUP=1`（同机器跑多 WindsurfAPI 实例避免互相 kill）。Windows 跳过（LS binary Linux only）。

### 改动

- `src/handlers/chat.js` — 抽 `_handleChatCompletionsInner` + 新 `handleChatCompletions` outer wrapper + 抽 `shouldAutoFallback` decision helper
- `src/langserver.js` — 新 `cleanupOrphanLanguageServers()` ps scan + kill
- `src/index.js` — startup cleanup
- `src/dashboard/api.js` — self-update setTimeout async + stopLanguageServer 在 exit 之前
- `test/v2085-auto-fallback.test.js` — 新（11 case，gating + cleanup sanity）

### 数字

- 测试 871 → **882**（+11）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

PM2 部署的可以从 dashboard 触发一键更新（v2.0.85 起会自动清 orphan）；或手动 `bash update.sh`。

### 行为变化（重要）

之前撞 `claude-opus-4-7-max` 全池限流时 client 拿 429。现在 client **拿 200 响应**，但内部用了 `claude-opus-4-7-xhigh` —— 响应 body 里 `model` 字段还是原始的 `claude-opus-4-7-max`，但加了 `served_model` 和 `fallback_reason` 字段。如果 client 严格要求 max effort 不能降级 → `WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=0` 关掉。
