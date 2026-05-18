## v2.0.82 — #125 真正的兼容/转换层：NLU retry-with-correction

#125 用户问能不能像别的反代项目写一个真正的兼容层让 GLM 工作 — 不是只靠 NLU 兜底。这版加了。

### 之前的问题

GLM-5.1 narrate "让我用 Bash 来列出当前工作目录下的文件" 没说字面 `ls`。NLU 即使中文化也抠不到 args（值不在文本里）。client 收到 0 tool_calls 死循环。

NLU 是 read-only 兜底 — 只能从已有文本抠值不能凭空补。要让 GLM 工作必须有一层真正的"protocol translator"。

### 这版做的：retry-with-correction loop

非流式路径检测到这种情况自动重发一次 cascade：

1. 第一次 cascadeChat → 模型 narrate（含工具名 + 动词，但没字面 args 没协议块）
2. parser 拿 0 tool_calls，NLU 也抠 0
3. `detectToolIntentInNarrative` 检测：narrative 含已声明工具名 + 含动词（中英）+ user prompt 是 actionable → 返回工具名
4. 构造 correction messages：原 history + 模型刚才的 narrate 当 assistant turn + 新 user 消息（中英双语）"你刚才描述了想用 X 但没 emit 协议块，请直接 emit 不要 narrate，给具体 argument 字面值不要占位词"
5. 第二次 cascadeChat（不复用 cascadeId 让模型重新决策）
6. parse 第二次输出 → 拿真 tool_calls → promote 给 client

第二次往往能 emit 协议块 + 给具体值，因为模型看到自己之前的 narrate + correction prompt 就被 nudge 回协议轨道。

### env 默认 OFF（quota 翻倍风险）

每次 retry 多花 1 次 cascade quota。流量大的实例没必要默认开。Operator 显式开：

```bash
WINDSURFAPI_NLU_RETRY=1
```

只在 narrative 含工具意图但抠不到 args 时 retry — 普通 chat / 一次成功的 case 不动。

### 检测逻辑（避免乱 retry）

`detectToolIntentInNarrative` 三条同时满足才 retry：

1. user prompt 是 actionable（含动词或文件/工具关键词，中英）
2. narrative 含动词（call/invoke/run/调用/让我用/...）
3. narrative 含已声明工具名字面（`Bash` / `shell_exec` 等）

不满足任一条 → 不 retry，跟 v2.0.81 行为一致（直接 0 tool_calls 返）。

### 流式路径暂不接

stream 第一次 chunks 已经发到 client 了不能 retry。如果 #125 用户用 stream + 想用 retry，先关 stream（OpenAI client 设 `stream: false`）。后续 release 会在 stream 路径加"延迟 emit + retry on hit" 但要重写部分 stream pipeline。

### 改动

- `src/handlers/intent-extractor.js` — 新加 `detectToolIntentInNarrative` helper
- `src/handlers/chat.js` — non-stream 路径接 retry loop
- `test/v2081-chinese-nlu.test.js` — +5 case for detector

### 数字

- 测试 854 → **859**（+5）
- 全测 0 fail / 0 回归

### 升级 + 启用

```bash
docker compose pull && docker compose up -d --force-recreate
```

`.env` 加：

```bash
WINDSURFAPI_NLU_RETRY=1
```

Force-recreate 后 GLM-5.1 / Kimi-K2 narrate-without-args 这类 case 第二次 pass 该 emit 协议块。

### 跟 #125 用户说

升级到 v2.0.82 + 加 env，撞试一次看 server log `grep "NLU retry"`：

- `NLU retry — promoted N tool_call(s) on second pass` = retry 救回来了
- `NLU retry — second pass also produced 0 tool_calls; giving up` = 模型连两次都没 emit，建议用 Claude

第二种 case 是模型本身限制（GLM 训练分布里就不擅长协议工具调用），proxy 已经做到极限。
