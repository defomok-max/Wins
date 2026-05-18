## v2.0.87 — #129 真修：cascade pool alias + auto-fallback 默认 ON

v2.0.85 默认 ON auto-fallback，v2.0.86 紧急回退默认 OFF（#129 wnfilm 报 cascade reuse miss → 模型失忆）。这版做 v2.0.86 release notes 承诺的真修，把默认 ON 安全开回来。

### 真根因

cascade pool 的 fingerprint 函数把 modelKey 锁进 hash。auto-fallback wrapper 改 `body.model = max → xhigh` 后，inner handler 算的是 xhigh 的 fingerprint，所以 cascade 只在 xhigh 下登记。client 下次请求 max → 算 max fingerprint → 找不到 → 起新 cascade → 模型失忆。

### 修

**A. `conversation-pool.js checkin` 接受 fingerprint 列表。** 单个 string 仍然支持（向后兼容），新增 `string[]` 同时索引到所有 fingerprint key 下，每个 slot 一个独立 entry 实例（不串味）。

**B. `chat.js _handleChatCompletionsInner` 接 `context.__aliasModelKey`。** 不为空时 checkin 一并算 alias 的 `fingerprintAfter`，跟主 fingerprint 一起作为 list 传给 checkin。

**C. outer wrapper fallback 时设 `__aliasModelKey: originalModel`。** 走完 fallback 这条 cascade 在 pool 里同时挂在 `claude-opus-4-7-max` 和 `claude-opus-4-7-xhigh` 两个 fingerprint 下。

**D. `shouldAutoFallback` 默认改回 ON。** v2.0.86 临时 OFF 是为防 #129，现在 alias 修了可以安全默认。env `WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=0` 仍可关。

### 跨 turn reuse 实测路径

```
turn 1: client → max → 池里 max 限流 → wrapper fallback → xhigh 跑
        ↓ inner checkin([fp_xhigh, fp_max], cascade_id_A)
        ↓ pool: fp_xhigh → cascade_A, fp_max → cascade_A
turn 2: client → max → checkout(fp_max) → 命中 cascade_A → 模型继续 history
```

后续 turn 跟从来没 fallback 过一样体验。

### 改动

- `src/conversation-pool.js` — `checkin` 接受 `string | string[]`
- `src/handlers/chat.js` — outer wrapper 设 `__aliasModelKey` / inner 透传到 poolCtx / 算双 fingerprint / `shouldAutoFallback` 默认 ON
- `test/v2087-pool-alias-checkin.test.js` — 新（7 case：向后兼容 + alias 写 + checkout 独立 + realistic auto-fallback 场景）
- `test/v2085-auto-fallback.test.js` — 9 case 适配新默认（ON）

### 数字

- 测试 882 → **889**（+7）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

env 关闭 auto-fallback：

```bash
WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=0
```

### 行为变化

撞 `claude-opus-4-7-max` 全池 rate-limit 时 client 拿 200 响应（内部用 xhigh），且**后续 turn 不会失忆** — cascade 在 max + xhigh 两个 fingerprint 下都能找到。response body 仍带 `served_model: "claude-opus-4-7-xhigh"` + `fallback_reason: "rate_limit_auto_fallback"` 让 client 知情但不强制要求处理。
