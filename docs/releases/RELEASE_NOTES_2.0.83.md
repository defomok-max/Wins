## v2.0.83 — v2.0.82 实测发现 retry detector 太严

部署 v2.0.82 + 加 `WINDSURFAPI_NLU_RETRY=1` 跑 #125 reproducer。VPS log:

```
Chat[non-stream]: emulateTools=true but parser found 0 tool_calls (model=glm-5.1 provider=zhipu); markers=none; head=""
Chat[non-stream]: thinking-only response from non-reasoning model glm-5.1; promoting 406c thinking → content
```

retry 没 trigger — 看 model 实际 thinking 内容是 "Let me list the files in the workspace." 没说 "Bash" 字面。v2.0.82 的 `detectToolIntentInNarrative` 要求 narrative 含已声明工具名字面才 trigger，miss 了。

### 修

`detectToolIntentInNarrative` 加 Pass 2 fallback：narrative 没含工具名但含 action verb（list / show / read / 列出 / 读取 / 看一下 等）+ user prompt 是 actionable → 返回**第一个**已声明工具名让 retry 用它。correction prompt 里会显式告诉模型用哪个工具 emit。

```js
// Pass 1: tool name in narrative (most precise)
for (const fn of names) { if (RegExp(fn).test(text)) return fn; }
// Pass 2: action verb fallback
if (actionVerbPattern.test(text)) return [...names][0];
```

3 个安全门保留：
- 必须 `userPromptLooksActionable(lastUserText)` — 普通聊天不会 trigger
- 必须含 verb（`call|invoke|让我|我会|need to|should` 等）— "天气怎么样" 不会 trigger  
- 必须含 action keyword — "你叫什么名字" 不会 trigger

### 改动

- `src/handlers/intent-extractor.js` — Pass 2 action-verb fallback
- `test/v2081-chinese-nlu.test.js` — +1 case GLM-5.1 reproducer

### 数字

- 测试 859 → **860**（+1）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
# .env 加 WINDSURFAPI_NLU_RETRY=1 启用 retry-with-correction
```

GLM-5.1 中文 narrate 不含工具名的 case 现在也能 trigger retry。
