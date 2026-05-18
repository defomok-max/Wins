## v2.0.89 — v2.0.88 修法二审 latent guard

ship v2.0.88 后跑 codex 二审专门看 4 HIGH 修法本身有没有引入新 regression / 漏。结果 H-2 / H-3 / H-4 修法本身都准确，**H-1 留了一个 latent correctness hole**。

### H-1.5 — 跨 provider fallback 会让 toolPreamble dialect 不一致 → cascade alias miss

`fingerprintAfter(turnComplete, aliasModelKey, callerKey, fpOpts)` 用的 `fpOpts.toolPreamble` 是 inner（fallback model）算的。toolPreamble 含 dialect-specific 字节（claude `<tool_call>` XML / gpt `bare-JSON` / kimi vLLM section）。

下次 client 用原 model 请求时 `fingerprintBefore` 用原 model 重算 `fpOpts`。同 provider effort ladder 内（claude-opus-4-7-max → -xhigh 都 anthropic dialect）byte-for-byte 一样，没事。

但 **如果 `pickRateLimitFallback` 跨 provider 返回**（claude → gpt 之类）：alias 写 fpOpts 含 gpt dialect 的 toolPreamble；下次 fpBefore 重算用 claude dialect → 不同 hash → fingerprint mismatch → cascade reuse miss → 模型失忆 — v2.0.86 #129 regression 又活了。

今天 `pickRateLimitFallback` 实现都同 provider 内 ladder 走（effort suffix + 1m context），**不触发**这条。但 catalog 任何扩展（新加 cross-vendor fallback hint）都会 silent 破坏。

### 修

`pickRateLimitFallback` 加 `_isSameProviderFallback` 硬 guard：返候选必须 `MODELS[candidate].provider === MODELS[modelKey].provider`，否则 return null。

未来想做 cross-provider fallback 必须走另一个 API + 同时显式重算 alias fpOpts 的 toolPreamble。这条 guard 把今天的不变量锁住。

### 改动

- `src/models.js` — `pickRateLimitFallback` 加 same-provider hard guard
- `test/v2089-pickfallback-provider-guard.test.js` — 新（6 case 含 anthropic effort ladder / openai codex sub-ladder / context drop / -thinking skip）

### 数字

- 测试 898 → **904**（+6）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 这一波节奏（最后一次审计）

v2.0.88 codex 互审找到 4 HIGH 全修。v2.0.88 二审 codex 验证修法准确性，确认 H-2/3/4 准，H-1 留一个 latent guard 这版补。

**审计链路**：v2.0.85 仓促 → v2.0.86 hotfix → v2.0.87 真修 → v2.0.88 找 4 HIGH 修 → v2.0.89 验证修法 + latent guard。每层都比上一层更稳，5 版才把 #129 这条线设计真锁死。
