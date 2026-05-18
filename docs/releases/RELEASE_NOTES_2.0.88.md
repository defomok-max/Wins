## v2.0.88 — 严格 dual-audit v2.0.85-87 设计漏 4 HIGH + 3 polish

一周内连续 ship v2.0.74 → v2.0.87 14 个版本。这版做严格审计，把 v2.0.85-87 仓促设计的副作用全找出来修。codex 互审 + claude 自审找到 4 HIGH。

### H-1 — alias fingerprint 用 raw `body.model` 不是 merged routing key（v2.0.87 fix 实际无效 for `reasoning_effort` 客户端）

v2.0.87 outer wrapper 把 `body.model` 作为 `__aliasModelKey` 传给 inner。但 inner 算 fingerprint 用 `routingModelKey = resolveModel(mergeReasoningEffortIntoModel(body.model, body))` 是 merged 后的（codex CLI 这种 client 发 `model: claude-opus-4-7` + `reasoning_effort: max` → routing key 是 `claude-opus-4-7-max`）。

raw `body.model = "claude-opus-4-7"` 跟 merged routing key `"claude-opus-4-7-max"` 算 fingerprint 完全不一样 → alias 写到 client 下次请求**永远查询不到**的 slot → v2.0.86 #129 失忆 regression 实际还在 for codex 类客户端。

**修**：outer wrapper 算 `originalRoutingKey = resolveModel(mergeReasoningEffortIntoModel(body.model, body))`，作为 `__aliasModelKey` 传。下次 client 同样 body 进来 inner 算 fingerprint 跟 alias 算的对得上。

### H-2 — `invalidateFor` 只删一个 slot 留 sibling 指 dead cascadeId

dual-write 把同 cascadeId 写到多 slot。当 `invalidateFor({ lsPort })` 触发（LS 重启），原代码单遍 scan 只删匹配 lsPort 的 slot，sibling alias slot 还活着指着 dead cascadeId。next turn 命中 alias slot → cascade `not found` → silent 一次失败 + 全 history replay。

**修**：两遍 scan。第一遍 collect 所有要删 slot 的 cascadeId。第二遍删任何 slot 的 cascadeId 在 set 里的（即使它自己 lsPort/apiKey 不匹配）。

### H-3 — fallback 成功 cacheSet 写到 fallback model key，下次原 model 请求 cache miss 又走 fallback 烧 quota

cache key 含 model 名。fallback 走 inner 用 `body.model = fallbackModel`，cacheSet 写 fallback key。client 下次同 prompt 同 original model → 算 original ckey → miss → 又撞 rate_limit → 又 fallback → quota 烧光。本来 cache 该兜，rate-limit 窗口 2 小时全部白烧。

**修**：outer wrapper 算 `originalCkey = cacheKey(body, callerKey)` 在 fallback 前，作为 `__originalCkey` 传 inner。inner cacheSet 时如果 aliasCkey 存在且不同就也写 — 下次原 model 请求 cache hit。

### H-4 — `stopLanguageServer` SIGTERM 后立刻 `process.exit` race，子进程没真退就被孤立

`/self-update` callback 里 `m.stopLanguageServer()` 同步发 SIGTERM 立刻返，`process.exit(0)` 紧跟。SIGTERM 信号 dispatch 是异步的，loaded VPS 上几十-几百 ms 才到子进程。父进程退了子进程被 reparent 到 PID 1 → orphan 占端口。startup `cleanupOrphanLanguageServers` 兜底但仍有 port conflict 窗口。

**修**：新加 `stopLanguageServerAndWait({ perProcessTimeoutMs })` 等每个 child `exit` event（SIGTERM 1.5s 内不退就 SIGKILL）才返。`/self-update` 改 `await` 这个版本。

### M-1 — `stats.stores` 按 fingerprint 计数，dashboard 数字双倍

dual-write 加 `stats.stores += N` 让"store" 计数 inflate。dashboard 看 store 数估池子负载就错。**修**：`stats.stores++` 一次 per 逻辑 checkin，加新 `aliasWrites` 单独计 sibling slot 数。

### M-5 — `served_model` / `fallback_reason` 加在 body 顶层 strict pydantic v2 client 拒

OpenAI ChatCompletion 顶级字段是 spec 的，pydantic `extra='forbid'` 客户端会报 ValidationError。**修**：移到 `usage.cascade_breakdown` 下（已经是 accepted 非标 sibling）。

### L-1 — `cleanupOrphanLanguageServers` argv substring 匹配

`argv.includes(_binaryPath)` 会匹配 grep / 监控 agent 等不相关进程。**修**：anchor 到 `argv0`（`argv.split(/\s+/)[0]`）严格相等才 kill。

### 没修留 v2.0.89+

- **M-2** stream 路径 429 没加 fallback_model（stream 改动复杂）
- **M-3** dual-slot checkout 一个不清 sibling（影响低）
- **M-4** NLU retry × auto-fallback 互动文档化
- **L-2** BusyBox `ps` 不支持 `-o pid=,args=` fallback
- **L-3** `recordRequest` 用 originalModel 不用 fallbackModel（dashboard per-model stats 会混）

### 改动

- `src/handlers/chat.js` — outer wrapper 算 originalRoutingKey + originalCkey 透传 / inner cacheSet 写 alias / served_model 移 usage.cascade_breakdown
- `src/conversation-pool.js` — invalidateFor 两遍 scan 跨 sibling / stats.stores 改一次 per checkin / 加 aliasWrites
- `src/langserver.js` — 新 stopLanguageServerAndWait async 等 exit / cleanup argv0 严格匹配
- `src/dashboard/api.js` — self-update 改用 stopLanguageServerAndWait
- `test/v2088-audit-fixes.test.js` — 新（9 case：H-1 merged-key alias hit / H-2 sibling cascade / M-1 stats / H-4 async）

### 数字

- 测试 889 → **898**（+9）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 这一波诚实承认

v2.0.85 仓促 ship 默认 ON → v2.0.86 hotfix OFF → v2.0.87 真修 alias 默认 ON → v2.0.88 审计发现 alias 自身**也写错了 key**（H-1）+ 三个其他设计漏（H-2/3/4）。每次"真修"都还有下一层。这次 codex 互审挖到行号级精确诊断，不是糊弄。
