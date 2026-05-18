## v2.0.72 — NLU 协议转换层：让 GPT/GLM/Kimi 也能在 cascade 后端调工具

#115 #120 根因诊断到位是 cascade upstream 协议层 — `SendUserCascadeMessage` proto 没 OpenAI tools[] 字段，所以 GPT/GLM/Kimi 训练分布里见的 native function-calling 用不上，模型就 narrate 一句"I'll call X with Y"或者 fabricate 一个时间戳交差。前面几版加 anti-fabrication / fabricate detection 都只是诊断帮 operator 看见问题，没真修。

这版改方向：**proxy 端写 NLU intent extractor**，从模型 narrate 文本反向抠出 tool_call 给 client。模型不按 prompt 里写的协议 emit 没关系，只要它"出声讲"了"我打算调 shell_exec command='echo HI'"，proxy 就抠出来组装成 OpenAI `tool_calls` 数组返回。

### 三层 extraction（按 confidence 排序）

**Layer 1 — explicit invocation syntax**（confidence 0.9-0.95）：

```
shell_exec(command="echo HI")
function_call: name=shell_exec args={"command":"echo HI"}
```

**Layer 2 — backtick-quoted name + value**（confidence 0.8）：

```
I'll call `shell_exec` with command `echo HI`
use the `Read` function with file_path `/etc/hosts`
```

**Layer 3 — natural narrative**（confidence 0.65，需要用户 prompt 里有 shell-style 动词）：

```
I should call the shell_exec function with the command "echo HELLO_FROM_PROBE"
Let me run shell_exec with command 'echo HI'
I'll invoke the Read tool to read /etc/hosts
```

每层的 tool name 必须在 caller 声明的 tools[] 里 — 排除模型自己编的工具名。Layer 3 还多一道闸：用户 prompt 里得有 `run|exec|read|cat|ls` 这类动词，避免普通聊天里随口说"call X"被误抠。

### 真实抓取证据

写了 `scripts/probes/v2071-glm-kimi-tool-probe.mjs` 在 v2.0.71 实测，GLM-4.7 emit 的就是 Layer 3 narrative：

```
"I should call the shell_exec function with the command 'echo HELLO_FROM_PROBE'."
```

extractor 抠出 `{"command":"echo HELLO_FROM_PROBE"}` confidence=0.65，返给 client 当真实 tool_call。从此 GLM/GPT/Kimi 在 codex CLI / Claude Code 里也能调工具。

### 集成

`chat.js` 两条 `markers=none` 路径（non-stream + stream）都接：

1. 如果 stream parser 没抠到 tool_call (markers=none)
2. AND caller 声明了 tools[]
3. → 调 `extractIntentFromNarrative(allText, tools, {lastUserText})`
4. 抠到 → 升级成 OpenAI tool_calls 返回 / stream emit
5. 抠不到 → fall through 到 v2.0.71 fabricate detection

NLU recovery 跟 fabricate detection 是**互补**关系：
- narrate "I'll call X" → NLU recovery 抠出 tool_call ✓
- 直接 fabricate "1777751588" → fabricate detection log warn ✗

### 兼容所有模型

- **Claude family** — 走 native bridge（v2.0.66 partition mode），用 cascade trajectory step，本来就 work
- **GPT family** — 走 emulation + gpt_native dialect + NLU recovery，narrate 模式现在有救
- **GLM-4.7 / 4.6 / 5 / 5.1** — 走 glm47 dialect + NLU recovery，narrate 模式有救
- **Kimi-K2 / K2-thinking** — 走 kimi_k2 dialect + NLU recovery
- **Kimi-K2.5 / K2-6** — 走 openai_json_xml + NLU recovery
- **Gemini** — 走 openai_json_xml + NLU recovery
- **DeepSeek / Grok / Qwen** — 同上

```js
// 默认 ON
WINDSURFAPI_NLU_RECOVERY=1

// 关掉
WINDSURFAPI_NLU_RECOVERY=0
```

### 改动

- `src/handlers/intent-extractor.js` — 新模块（约 240 行）：3-layer extractor + tool index + actionable detector
- `src/handlers/chat.js` — non-stream + stream 两路接 NLU recovery，先于 fabricate detection
- `test/intent-extractor.test.js` — 15 个 case：3 个 layer + GLM live reproducer + 健壮性 + dedupe + 多 call + env 开关 + confidence threshold

### 数字

- 测试：777 → **792**（+15 新 case）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

NLU recovery 默认 ON。Operator 可关：

```bash
WINDSURFAPI_NLU_RECOVERY=0
```

### 已知极限

- 模型直接 fabricate 假输出（`PROBE_X_1777751588`）没 narrate 时 NLU 抠不到 — 这种走 fabricate detection log warn
- Layer 3 narrative 0.65 confidence 不是 100% 准 — 极少数情况会把模型"我考虑调 X 但决定不调"误抠成调用。trade-off 选了"宁可多抠也别让 agent 卡死"
- 模型说"call X without args" 没给参数时 — Layer 1+2 抠不到 value 跳过；Layer 3 也跳过 — 这种情况 client 收到 0 tool_calls 仍走原 fallback

### 关 #115 #120

NLU 协议转换层是这两个 issue 真正可工作的修法。issue 留开等用户实测反馈。
