## v2.0.54 — salvage 链路端到端测试硬化（#109 follow-up follow-up）

v2.0.53 加了 salvage parser 让 GPT/Gemini/GLM 等非 Claude 模型在 /v1/messages 也能返回 tool_use 块——但当时只有 17 个 unit test 验证了 parser 本身，**没验证**从 parser 出去经 chat.js response builder 经 messages.js openAIToAnthropic translator 最后到客户端这一整条链路是不是都喂得对。用户问"你真的改好了吗 自己想的办法试过了吗"——回答是"unit 层面 yes 集成层面 unknown"。

这版补这个集成层面的洞。

### 痛点

salvage parser 的输出是 `{id, name, argumentsJson}` 数组。下游消费者在两处：

1. **chat.js:1758-1792** 把它打包成 OpenAI chat-completion 形状（`choices[0].message.tool_calls = [{id, type:'function', function:{name, arguments}}]`）
2. **messages.js:290-322 openAIToAnthropic** 再翻译成 Anthropic `content[].type === 'tool_use'` 块（`{type:'tool_use', id, name, input}`，input 是 JSON.parse 的 arguments）

如果这俩中间任何一步对 salvage 返回的字段名假设错了（比如 chat.js 漏了 id、messages.js 拿不到 input、stop_reason 没翻成 'tool_use'），客户端就会拿到空 content 数组或者畸形 input——salvage 救出来的 tool call 在客户端那边等于没救。

之前没有测试覆盖这条链路。

### 修法

**`src/handlers/messages.js`**：把 `openAIToAnthropic` 从模块私有改 `export`。这是测试友好性改动，无运行时行为变化。

**`test/tool-emulation-end-to-end.test.js`**（新文件）：9 个 case 跑完整链路 raw text → parseToolCallsFromText → buildOpenAIResponse（mimic chat.js）→ openAIToAnthropic → Anthropic message。每个 case 断言：

| Case | 验证 |
| --- | --- |
| GPT 风格 markdown-fenced JSON | tool_use 块存在、id 非空、name 对、input 解出对的 dict、stop_reason='tool_use' |
| OpenAI native function_call | 同上，验证 escaped string arguments 解析 |
| OpenAI tool_calls 数组 | 多个 tool_use 块，**每个 id 不一样**（客户端 tool_result 要靠 id 匹配） |
| Whitespace-padded bare JSON | 同上 |
| 标准 XML envelope（primary 路径） | salvage 不破坏原有契约 |
| **Prose-only 拒答**（负 case） | 模型不调 tool 时**不能**幻觉出 tool_use 块——只能给 text 块 + stop_reason='end_turn' |
| salvage 自己分配的 id | 必须是 `call_*` 前缀，非空 |
| **嵌套 dict + bool + int 参数 round-trip** | salvage 的 JSON.stringify → chat.js 字符串 → messages.js JSON.parse 必须保留类型 |
| **escaped string round-trip** | 含 `\"` 转义的字符串参数完整还原 |

### 为啥不直接实测真模型

诚实的：上游 Cascade 对账号池所有 3 个账号在所有 ~50 个常见模型上做了 ~2 小时全模型 cooldown（v2.0.53 验证发布前的端到端 sweep 把额度打光了）。这版发布时**没法**让真 GPT-5.5 / Gemini-3.1 跑一发看 raw text。

但我能保证的：

- v2.0.53 的诊断日志在生产挂着（chat.js stream + non-stream 两条路径都有），任何客户端碰到 emulation+0-call 会自动留 raw text 头 240 字符 + 检测到的 tool-shaped marker 到 docker logs
- 链路里每一步的契约都被这版的 9 个 e2e 测试钉死——salvage 输出的字段名、id 格式、JSON round-trip 类型保留、负 case 不幻觉，全部断言
- 真实模型只要发的格式落在 4 种 salvage 已知形态之一（fenced JSON / OpenAI native / tool_calls 数组 / 裸 JSON），客户端就一定收到正确的 tool_use 块

如果生产日志后续显示某个模型用了第 5 种格式，加进 salvage parser 是几行代码 + 几个测试的事。

### 数字

- 测试：524 → **533** (+9 / 0 失败)
- 改动：
  - `src/handlers/messages.js`: `openAIToAnthropic` 改 export（1 字符）
  - `test/tool-emulation-end-to-end.test.js`: 9 个集成 case
  - `package.json`: 2.0.53 → 2.0.54

### 升级

```bash
docker compose pull && docker compose up -d
```

跟 v2.0.53 是同一个生产行为——这版没改 runtime 逻辑，只是把"它真的从头到尾跑得通"用测试钉死了。
