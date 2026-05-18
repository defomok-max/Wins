## v2.0.53 — 非 Claude 模型在 /v1/messages 也能返回 tool_use 块（#109 follow-up）

issue #109 用户问"那些高端模型（gpt-5.5 / opus-4.7 / gemini-3.1）通过 sub2api 调用 tool 都修好了没"。Anthropic 系列的 tool_use 一直能用；OpenAI / Gemini / GLM 等非 Claude 系列在 /v1/messages 上经常返回纯文本不发 tool_use 块——之前 v2.0.52 PR 评论里说这是"协议固有限制"。其实不完全是。

### 现状梳理（codex-subagent 协助审）

架构本身没问题：
- `messages.js` 把 Anthropic `tools[]` 翻译成 OpenAI 格式 forwards 给 `chat.js`
- `chat.js` 见到 `tools` 就开 `emulateTools = true`（**没有** Claude-only gate）
- `tool-emulation.js` 注入 prompt 让模型用 `<tool_call>{...}</tool_call>` 格式发 call
- 模型回的文本被 parser 抽出 tool_calls
- `messages.js` 再把 tool_calls 翻译成 Anthropic 的 tool_use 块

那为什么之前 GPT/Gemini 不出 tool_use？两个根因：

1. **模型不严格遵守 `<tool_call>` 格式**：GPT-5.x / Gemini 经常用更"自然"的格式比如 markdown-fenced JSON：
   ```
   I'll use the echo tool.
   ```json
   {"name": "echo_text", "arguments": {"text": "HELLO"}}
   ```
   ```
   或者 OpenAI 自己的 native function_call 格式：`{"function_call": {"name": "x", "arguments": "..."}}`

2. **parser 只认严格格式**：原 `ToolCallStreamParser` 找的是 substring `<tool_call>` 或 `{"name"`（没空格）—— 上面这些变体都不匹配，结果 tool 调用被当成普通文本扔回客户端。

### 修法

加 **salvage pass**：当 primary parser 找不到任何 tool call 时，对全文做一遍二次扫描，识别这些常见变体：

| 格式 | 例子 |
| --- | --- |
| Markdown-fenced JSON | `` ```json\n{"name":...,"arguments":{...}}\n``` `` |
| OpenAI legacy function_call | `{"function_call":{"name":"x","arguments":"..."}}` |
| OpenAI tool_calls 数组 | `{"tool_calls":[{"function":{"name":"x","arguments":"..."}},...]}` |
| Whitespace-padded bare | `{ "name": "x", "arguments": { ... } }` |

关键设计点：
- **守卫**：salvage 只在 primary 返回 0 calls 时跑——绝不覆盖已 parse 成功的结果
- **只在非流路径跑**：`parseToolCallsFromText` 这个一次性入口；流式 parser 不动（streaming 改起来风险大且回报小）
- **arguments 必须存在**：`{"function":{"name":"x"}}` 没 arguments 不算 tool call（避免误识别 metadata 字段）—— codex 审计揪出来的 false positive

### 顺便加的诊断日志

`chat.js` 里 nonStream + stream 两条路径都加了：当 `emulateTools=true` 但抽出 0 个 tool_calls 时，log 里会标出 raw text 头 240 字符 + 检测到的 tool-shaped marker（xml_tag / fenced_json / openai_native / bare_json / natural_lang）。下次再有"模型不调 tool"的 issue 直接看 log 就知道 model 用了哪种格式 / 或者根本没尝试调。

### 数字

- 测试：519 → **524** (+5 / 0 失败)
  - 12 个 salvage 主路径 case
  - 5 个 codex 审计补的 false-positive guard case
- 改动：
  - `src/handlers/tool-emulation.js`: +salvage 函数 +helper +parser 入口接 salvage
  - `src/handlers/chat.js`: 两条路径加 emulation 诊断日志（无功能改变）
  - `test/tool-emulation-salvage.test.js`: 17 个 case 覆盖正确识别 + false-positive guard

### 升级

```bash
docker compose pull && docker compose up -d
```

升完后 sub2api 经过 WindsurfAPI 调 GPT/Gemini/GLM 时，模型只要发了任何一种主流 tool-call 格式都能转成 Anthropic `tool_use` 块返回客户端。

### 仍然解决不了的（诚实声明）

如果模型**根本没尝试调 tool**（看了 prompt 直接答文本），那是 model behavior 问题——salvage 救不了。建议这种情况：
1. 客户端发 `tool_choice={"type":"any"}`（强制至少调一个）
2. 走 `/v1/chat/completions` (OpenAI 协议) 而不是 `/v1/messages`——那条路 cascade 知道得调 emulation
3. 或者用 Claude 系列 反正它们最听话
