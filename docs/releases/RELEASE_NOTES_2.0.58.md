## v2.0.58 — Drought 模式硬限制 premium 模型

承接 v2.0.57：drought 状态当时只 expose 给 dashboard / health 看，没主动拦截。这一版把它升级成**硬限制** —— 池子 weekly 配额全 < 5% 时，premium 模型请求直接 503，留下的免费层模型（`gemini-2.5-flash` + 动态发现的）保持可用。

### 触发条件（三个全部满足才拦截）

1. **drought = true**：所有 active 账号 `weeklyPercent < 5`
2. **restrict 开启**：env `DROUGHT_RESTRICT_PREMIUM=0` 显式关 OR Dashboard 实验性面板"drought 时屏蔽 premium"为 false → 不拦
3. **请求模型不在免费层**：`getTierModels('free')` 返的集合（`gemini-2.5-flash` 等）放行；其他全 503

### 拒绝响应形态

```json
HTTP 503
Retry-After: 1800
{
  "error": {
    "message": "账号池处于配额低水位（drought mode）：所有账号本周配额都低于 5%，已暂时屏蔽 premium 模型 claude-sonnet-4.6 ...",
    "type": "drought_mode",
    "drought": {
      "lowestWeeklyPercent": 2,
      "lowestDailyPercent": 0,
      "threshold": 5,
      "activeAccounts": 3,
      "allowedModels": ["gemini-2.5-flash", ...]
    }
  }
}
```

`type='drought_mode'` 让客户端能区分这种情况和真正的 rate-limit / 上游 transient 错误。`error.drought.allowedModels` 给客户端友好降级方向。

### 改动

- **`src/auth.js`** 新增 `isModelBlockedByDrought / isDroughtRestrictEnabled / setDroughtRestrictResolver`，`getDroughtSummary` 多返 `restrictEnabled` 和 `freeTierModels`
- **`src/handlers/chat.js`** `handleChatCompletions` 入口在 deprecated check 之后、model-access check 之前加 drought gate
- **`src/runtime-config.js`** `experimental.droughtRestrictPremium=true` 默认开启，wire 到 setDroughtRestrictResolver
- **Dashboard UI** 双皮在实验性面板加 toggle（cascadeReuse 同区域），i18n zh/en `section.droughtRestrict.*` 4 keys
- 优先级：env > runtime-config > 默认（true）

### 不影响的场景

- 单账号 weekly% 低但其他账号健康 → 不算 drought，照常路由
- 免费层模型（`gemini-2.5-flash` + 动态发现）→ drought 时也直通
- 已 deprecated 的模型 → 仍走原 410 路径不变
- model-access blocklist → 仍优先于 drought 检查

### 数字

- 测试：629 → **639**（+10）
- 全测 0 fail
- 改动：3 src 文件 + 2 dashboard UI + 2 i18n + 1 测试

### 升级

```bash
docker compose pull && docker compose up -d
```

部署后看 drought 真态：

```bash
curl -s http://$HOST:3888/dashboard/api/drought -H "X-Dashboard-Password: $PW"
# 期望: {"drought":false,"threshold":5,"activeAccounts":3,...,"restrictEnabled":true,"freeTierModels":["gemini-2.5-flash"]}
```

要在 drought 时强制下发 premium（吃完最后配额），开 dashboard → 实验性 → 关掉"启用 drought-mode premium 屏蔽"。或者：

```bash
# 容器全局关掉
docker compose exec windsurf-api sh -c 'export DROUGHT_RESTRICT_PREMIUM=0'  # 不持久
# 或者写到 .env 然后 docker compose up -d --force-recreate
echo 'DROUGHT_RESTRICT_PREMIUM=0' >> .env
docker compose up -d --force-recreate
```
