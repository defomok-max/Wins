## v2.0.62 — gpt_native dialect 让 Codex CLI 跑 GPT 模型时真能调工具（#115 根因修）

#115 根因：Cascade 上游 proto 里没有 native function-calling field，所以我们一直用文本协议 emulation — 把 tools 注成 system prompt，让模型 emit `<tool_call>{...}</tool_call>` 文本块。**Claude 系列顺从这个文本协议**，**GPT 系列不顺从** —— 训练让它期望 native function-calling JSON，碰到我们的 XML 包装就推开说"你给我贴文件吧"。

v2.0.61 我先说"下版做"，这版做掉。

### 设计：构造伪装协议

Cascade 没有 native tool field，但我们可以**让模型按它最熟悉的格式自然 emit**，proxy 端用 parser 抠出来翻成结构化 tool_calls：

```
GPT 看到的 (gpt_native dialect)：
  Output ONE valid JSON object:
  {"function_call":{"name":"<name>","arguments":{...}}}
  No markdown fence. No prose. The functions ARE available.
  DO NOT respond "please paste the file" — call the function.

GPT emit (符合训练直觉)：
  {"function_call":{"name":"Read","arguments":{"file":"a.md"}}}

Proxy parse (走原有 salvage / 新 stream parser 分支)：
  → tool_calls: [{id, type:'function', function:{name:'Read', arguments:'{"file":"a.md"}'}}]

客户端 (Codex CLI) 看到 (经 chatToResponse 翻译)：
  output: [{type:'function_call', call_id, name:'Read', arguments:'{"file":"a.md"}', status:'completed'}]
```

GPT 既没"违反 native function-calling 训练"也没"emit XML markup 拒绝"，自然 emit 它最熟悉的 JSON shape，proxy 端识别。

### 改动

**`src/handlers/tool-emulation.js`**：
- 新 dialect `gpt_native`（4 dialect 之一，glm47 / kimi_k2 / openai_json_xml / **gpt_native**）
- `getToolProtocolHeader('gpt_native')` 返强 anti-refusal preamble — 6 条 rules，明确"DO NOT respond '我不能读文件'/'请贴文件'/'我没有直接权限'，那些短语 forbidden"
- `pickToolDialect(modelKey, provider, route)` 加第三参数 `route`：仅 `route='responses'` + GPT 家族 (`gpt-*` / `o3-*` / `o4-*` 或 provider='openai') → `gpt_native`，其他场景保持 `openai_json_xml` 不变（防 chat completions 客户端意外行为变化）
- env `WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT=1` 全路由强开
- `formatAssistantToolCallForDialect` 加 gpt_native 分支（history 序列化用 `{"function_call":{name, arguments}}` 而不是 `<tool_call>{...}</tool_call>`，让模型看到自己上一轮的 emit shape 跟 prompt 要求的一致）
- `parseNonOpenAIDialectBuffer` 加 gpt_native 分支：复用现有 salvage parser（已支持 `function_call` / `tool_calls` / `function` / bare `{name,arguments}` 4 种 shape）
- `ToolCallStreamParser` feed/flush 给 gpt_native 加 8 个 sentinels（`{"function_call"`, `{"tool_calls"`, `{"name"` 等含空格变体）流式 holdback

**route 参数贯穿**：
- `applyToolPreambleBudget` + 4 个 tier builders (`buildToolPreambleForProto` / `buildSchemaCompactToolPreambleForProto` / `buildSkinnyToolPreambleForProto` / `buildCompactToolPreambleForProto`) 都加 `route` 参数
- `normalizeMessagesForCascade(messages, tools, options)` `options.route` 字段
- `ToolCallStreamParser({modelKey, provider, route})` 构造时带 route
- `parseToolCallsFromText(text, {modelKey, provider, route})` 同上
- `chat.js handleChatCompletions` 读 `body.__route`（已经被 responses.js line 858/863 设过）传到 builders / parsers / `streamResponse(deps.route)`

**fallback 安全**：non-stream 错误路径仍走 salvage parser，即使流路径 holdback 漏一些边界 case，flush 时 salvage 也兜得住。Claude / Gemini / GLM / Kimi 全保持原 dialect 不变。

### 数字

- 测试：639 → **654**（+15 新 case 覆盖：dialect 选择 5 case / preamble 内容 4 case / history 序列化 1 case / parser stream+flush+多 call+plain prose+部分 JSON 5 case）
- 全测 0 fail
- 改动：1 src 文件大改 (tool-emulation.js) + chat.js route 串 + 1 测试文件

### 升级

```bash
docker compose pull && docker compose up -d
```

### 实测 (Codex CLI 用法)

```bash
codex --model gpt-5.5-medium  # 或 gpt-5.4-medium / o3-mini 等
# 之前: 模型说 "请你给我贴文件吧"，emulateTools=true 但 0 tool_calls 出来
# 现在: 模型 emit {"function_call":{"name":"Read","arguments":{...}}}，被 parser 抠出来变 function_call output item
```

如果还炸，env 加 `WINDSURFAPI_FORCE_GPT_NATIVE_DIALECT=1` 让所有路径都走 gpt_native，看 server log 里 `Probe[xxx]: ... markers=...` 行确认模型实际 emit 了什么 shape。

### 关 #115

`/v1/responses` 路径的 GPT 系列 native function-calling 翻译层这版就位。Claude / Gemini 路径不动。
