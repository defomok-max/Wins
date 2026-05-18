## v2.0.79 — audit MED + LOW 收尾

v2.0.78 把审计的 4 条 HIGH 全修了。这版把剩下的 3 MED + 2 LOW 一并清掉，不再留尾。

### M-1 #118 / #119 sticky 检测漏 bright-data / oxylabs

老 regex `/(?:[_-](?:sid|session|sessid|sticky|sess)|[+]ws_)/i` 只识别 username 里带显式 session token 的代理。但 bright-data 和 oxylabs 的某些 plan 不在 username 里塞 session 标记，username 形如：

```
brd-customer-hl_abc123-zone-residential
customer-myuser-cc-US-country-US
```

这种 username 在老 regex 下不被识别为 sticky → 多个账号共享同一个 LS 实例 + 同一个 Windsurf sessionId → 上游按 fingerprint 限流 30 分钟。这正是 wnfilm / 0a00 在 #118 报的 "30 分钟限流"。

修法：regex 加 `^brd-customer-` / `customer-...-cc-` / `customer-...-zone-` / `-zone-` / `-cc-XX` 等已知服务模式。bare static-IP username 仍然不分桶（避免内存爆）。

### M-2 toolActive 180s 副作用

v2.0.74 加的"工具调用执行中 180s ceiling"在第一个 tool call emit 后就一直保持 180s 不变。但是常见工具（`view_file` / `Glob`）200ms 就完成了 — 后面 trajectory 静默纯属 planner 卡住。这种 case 浪费 180s 账号 quota 才能 detect 卡死。

修法：`pickWarmStallCeiling` 加 `msSinceGrowth` + `hasActiveStep` 两个参数：

- LS trajectory 里有 `status === 1` (ACTIVE) 的 step → 工具确实在跑，180s 全用
- toolCallCount > 0 但 msSinceGrowth > 60s 且没 ACTIVE step → tool 已完成 + planner 卡 → 退回到 thinking 档（120s）或 text 档（45s）

env `CASCADE_TOOL_ACTIVE_GRACE_MS` 默认 60s 可调。

### M-3 #114 OneTimeToken cross-host 边界

v2.0.75 加了"PostAuth=A → OTT=A 401 → 重做 PostAuth=B → OTT=B" 的 cross-host retry。但 `oneTimeTokenDualPath` 内部"preferred host 4xx 直接返回"逻辑覆盖了所有 4xx — 包括 invalid_token，这种情况其实应该 fall through 试 non-preferred。

修法：preferred host 返回 401 invalid_token 时不 short-circuit，继续试 non-preferred。其他 4xx（400 bad request / 403 forbidden / 410 gone）仍然立刻返。这样：

- 真的 token 坏 / 真的 forbidden → 一次 4xx 直接报错，不浪费时间
- 上游 cross-host symmetry 临时炸 → 自动 fall through 第二个 host

### L-2 workspaceId 8 字符碰撞

`workspacePath` 老用 `apiKey.slice(0,8).replace(/[^a-z0-9]/gi, 'x')` — 8 字符 + 把符号替换成 `x`，理论碰撞空间小。两个 API key 前 8 字符都是符号会撞同一个 workspace 目录 → `package.json` 互相读到 → `ensureWorkspaceDir` skip 重建。

修法：用 `sha256(apiKey).slice(0, 16)` 拿 16 hex 字符（64 bits），碰撞概率近乎不可能。

### L-3 NLU prose 拒绝多加测试

v2.0.78 加的 `looksLikePlaceholderValue` 主要看了"command/argument"等单词 + "a/the/your"开头的短语。这版补真实模型输出里见过的更多 case：

- "your input" / "this command" / "that argument" / "these parameters"
- "the specified file" / "an argument" / "some path"
- Layer 3 "to <verb>" pattern 抓的"to read the file"

测试加了 14 条 case 锁住这些拒绝。

### 改动

- `src/langserver.js` — STICKY_USER_RE widening
- `src/client.js` — pickWarmStallCeiling 加 msSinceGrowth + hasActiveStep；workspaceId 用 sha256
- `src/dashboard/windsurf-login.js` — oneTimeTokenDualPath invalid_token fall-through
- `test/v2079-audit-followup.test.js` — 新（14 case）

### 数字

- 测试 825 → **839**（+14）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

env 选项（默认值都够用）：

- `CASCADE_TOOL_ACTIVE_GRACE_MS=60000` — toolActive 档生效窗口
- 其他 warm-stall env 不变
