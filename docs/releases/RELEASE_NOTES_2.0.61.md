## v2.0.61 — issue 一波核查修复（#110/#111/#113/#114）

用户列了一堆 issue 一一核查后修：

### Fix #110 — DASHBOARD_PASSWORD 留空 UX 烂

**症状**：升级到 v2.0.55+ 后 dashboard 一直弹密码框；chat API 也 401。
**根因**：v2.0.55 H1 fix 让公网 bind 不再用 API_KEY 当 dashboard 回退密码（防止 chat caller 提权到 service operator）。但**没设 DASHBOARD_PASSWORD 的人升上来直接 fail-closed**，UI 弹密码框但没人能输对。
**修法**：
- Dashboard `/auth` 已经返 `locked: true` — UI 现在识别这个 state，**显示带配置示范的红色提示框**（"Dashboard locked / 此实例绑定公网但没设 DASHBOARD_PASSWORD" + `.env` + `docker compose up -d --force-recreate` 命令）替代失败的密码框。
- chat API 401 错误信息改清楚：缺 token vs token 错给两条不同 message，明示是配置问题不是客户端问题。
- 没必要回退 v2.0.55 的安全 fix — 这是设计行为，user 配上 DASHBOARD_PASSWORD 就好。

### Fix #111 — sonnet-4.6-thinking + 78 tools 重复输出

**症状**：claude-sonnet-4.6-thinking + 大 system prompt + 78 tools 时模型反复 WebFetch 同样东西，不停。
**根因（实测 log 验证）**：fingerprint 飘 → cascade reuse 100% miss → 每次新 cascade 模型从头开始 → 看起来"重复"。具体两点：
1. **system prompt 含动态字段**（"Today's date is 2026-05-02" / cwd / session UUID / ISO timestamp），同长度但 hash 飘
2. **tools 数组顺序**客户端可能轻微变（Claude Code 70+ tools），stableStringify 不 sort 数组

**修法**（`src/conversation-pool.js`）：
- 新增 `normalizeSystemPromptForHash` — 把 ISO 时间戳 / `Today's date is YYYY-MM-DD` / UUID / `Working directory:` 行 / `Session ID:` 行替换成 `<ts>` `<date>` `<uuid>` `<cwd>` 等占位再 hash。**plain prose 改动仍生效（真改 prompt 还是新 cascade）**，但纯动态片段不再让 hash 飘。
- `toolContextDigest` sort tools by name 后再 hash — 客户端 70+ 工具偶尔 reshuffle 顺序时 fingerprint 仍稳。

效果：Claude Code 长会话第二轮起命中 cascade pool，模型上下文连续，不再"循环"。

### Fix #113 — Anthropic policy / cyber verification 识别不 retry

**症状**：Anthropic 触发 cyber verification challenge / content policy 时被当 transient 5xx，proxy 一路换账号 retry，烧光配额。
**修法**（`src/handlers/chat.js` non-stream + stream 两条路径）：
- 加 patterns 识别 `cyber verification` / `content policy` / `policy violation|blocked|denied` / `safety policy|blocked` / `prompt rejected|blocked by policy` / `usage policy violation`
- 命中 → `err.kind = 'policy_blocked'`，retry loop 立即 break
- 客户端拿 **HTTP 451** + `error.type='policy_blocked'` + 友好中文消息（"切账号也救不回来；改 prompt 或换模型"）

### Fix #114 — 邮箱密码登录 ERR_TOKEN_FETCH_FAILED `invalid token`

**症状**：邮箱密码登录走完 PostAuth (new host) 后 GetOneTimeAuthToken 报 `unauthenticated invalid token`。
**根因**：v2.0.57 dual-path 让 PostAuth 走 `windsurf.com/_backend`（新），OneTimeAuthToken 也优先新 host。但 Windsurf 半迁移期内**新 host 给的 sessionToken 旧 host 拒识** —— 本来该跨 host 一致但实际不是。我们当前 retry 顺序固定（new → legacy），sessionToken 一路 invalid。
**修法**（`src/dashboard/windsurf-login.js`）：
- `oneTimeTokenDualPath` 接受 `preferredHost` 参数 — pin 到 PostAuth 用过的同 host
- preferred host 4xx 直接返（不要再退回另一个 host，避免一个 token 跨 gateway 验两次都 invalid）
- caller 把 `bridgeLabel`（PostAuth 的 host 标签）传下去

### #112 — 后台一键 LS binary 更新（feature request）

**已实现**（v2.0.40）：dashboard `/self-update/check` + `/self-update` 路由，按钮在 dashboard overview / system 区域。回 issue 指向位置 + 用法。

### #115 — codex/gpt-5.4 不调工具

**根因**：跟 #77 opus-4-7 同类问题 — gpt-5.4 在我们的 OpenAI 文本协议 emulation 下倾向于不发 `<tool_call>` 块，而是自然语言拒答（"你给我贴文件吧"）。这不是 v2.0.60 引入的（v2.0.59 之前一样），只是更突出。
**当前状态**：sonnet-4.6 系列在文本协议下顺从，是 codex CLI 的可靠选择。GPT 系列要彻底解需要给它 native function-calling 协议（`/v1/responses` 路径增强），下版做。
**workaround**：codex CLI 配置 `--model claude-sonnet-4-6-thinking` 或 `claude-opus-4-7-medium` 走 Claude Code 路径正常工具调用。

### 数字

- 测试：639 / 639 全绿
- 改动：4 src 文件 + 2 i18n + 1 release notes
