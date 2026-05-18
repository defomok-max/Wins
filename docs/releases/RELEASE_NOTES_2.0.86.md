## v2.0.86 — #129 wnfilm regression hotfix（auto-fallback 默认改 OFF）

v2.0.85 加的 auto-fallback retry 默认 ON。wnfilm 在 #129 抓到副作用：

> 当某个模型/账号触发 429 或 rate_limit 后，下游 client 后续请求会像新会话一样，模型开始重新问"项目地址、技术栈、SSH 信息"等基础信息。

### 真根因

cascade reuse fingerprint 把 `modelKey` 锁进 hash。v2.0.85 wrapper 改 `body.model` 重发后，inner handler 用**新 model**算 fingerprint → 那条 fallback 完成的 cascade 被存到**新 model fingerprint** 下。

client 下次请求**原 model**：
- fingerprint 算原 modelKey → 找不到（pool 里只在新 model 下有）
- reuse MISS → cascade pool 起新 cascade
- 依赖 cascade reuse 的 client（比如 Claude Code 用 cascade-aware 模式 client 不重发完整 history）→ 模型看到空 history → 失忆

cascade reuse miss 本来不会让模型失忆（proxy 会从 client 提交的 messages 里重新打包 history），但**当 client 也省略 history**就出事了。

### 修

`shouldAutoFallback` gating 默认改 OFF（`WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT !== '1'` 才允许 — 之前是 `!== '0'`）。Operator 知道 client 不依赖 cascade reuse 才显式开。

`fallback_model` + `remediation` 字段（v2.0.84 加的）保留，client 仍能看到建议手动切。

### v2.0.87+ 计划做的真修

cascade pool 加 alias 写入：fallback retry 时把同一 cascade 同时存到原 model fingerprint 和新 model fingerprint 两个 key 下。client 下次拿原 model 请求能命中。这样 auto-fallback 才能真的默认 ON 不破 reuse。

### 改动

- `src/handlers/chat.js` — `shouldAutoFallback` env gate 反向（默认 OFF）
- `test/v2085-auto-fallback.test.js` — 9 个 case 适配新默认

### 数字

- 测试 882（不变 + 调整 1 case 期望）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

启用 auto-fallback：

```bash
WINDSURFAPI_VARIANT_FALLBACK_ON_RATE_LIMIT=1
```

仅当确认 client 每次请求都重发完整 messages（OpenAI 标准）时才开。

### 抱歉

v2.0.85 ship 默认 ON 是仓促，没充分考虑 cascade reuse 的 fingerprint 锁 model 的副作用。wnfilm 抓到很快。这版退回到稳态。
