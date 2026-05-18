## v2.0.77 — NLU recovery 入口扩宽（v2.0.76 实测发现的真问题）

v2.0.76 跑实测 probe 时 GLM-4.7 反而退步了 — `NO tool_calls`。看 server log：

```
Chat[non-stream]: emulateTools=true but parser found 0 tool_calls
   (model=glm-4.7 provider=zhipu); markers=bare_json; head=""
Chat[non-stream]: thinking-only response from non-reasoning model glm-4.7;
   promoting 362c thinking → content
```

GLM-4.7 这次 thinking 里嵌了 `{"name":"shell_exec","arguments":{"command":"echo HELLO_FROM_..."}}` 这种 bare-JSON 形态 → marker 检测到 `bare_json` → markers != none → **NLU 不触发**。但 parser 又抠不到（JSON 嵌在散文里没法 promote）。结果 0 tool_calls 直接返。

v2.0.72 加 NLU 时设的限定条件 `markers.length === 0` 太严了 — 模型 emit 的格式介于"完全 narrate"和"标准 markup"之间时落空。

### 修

NLU recovery 入口条件改成"parser 抠到 0 个 tool_calls + 调用方声明了 tools[] + emulation 路径" — 不再看 markers 状态。non-stream + stream 两条路都改。

```js
// 老
if (markers.length === 0 && tools.length > 0) { ... NLU ... }

// 新
if (tools.length > 0) { ... NLU ... }
```

NLU 跑出 0 个时 fall-through 到 fabricate detection，跟之前一样。NLU 跑出 ≥1 个就 promote — markers 是诊断信号，不该当 gate。

### 顺手收 v2.0.76 的 placeholder filter

v2.0.76 加的"PLACEHOLDER_VALUES"过滤还在 — GLM-4.7 narrate "with command 'command'" 那种 echo 不会变成误抠 `shell_exec({"command":"command"})`。

### 改动

- `src/handlers/chat.js` — non-stream + stream 两路 NLU 入口去掉 `markers.length === 0` 条件
- 没动测试（既有 17 个 NLU case 全 cover）

### 数字

- 测试 807 / 0 fail
- 全测 0 回归

### 实测验证

部署后会再跑一波 e2e probe，把 GLM-4.7 / Kimi-K2.5 / Claude Code / GPT-5.5 / 长 system reuse 全过一遍，结果贴各 issue 评论区。

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```
