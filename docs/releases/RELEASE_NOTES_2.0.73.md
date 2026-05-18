## v2.0.73 — v2.0.72 NLU recovery 实测发现路径漏 thinking 通道，hotfix

v2.0.72 部署后跑 GLM/Kimi probe，发现 NLU 抠取路径**没真触发** — 结果跟前一版一样模型 narrate 不调工具。

诊断：cascade `CortexStepPlannerResponse` 有 `response` (1) 和 `thinking` (3) 两个文本字段。GLM-4.7 / GLM-5.1 这类非 thinking 系模型在 cascade 后端有时把整段 narrate 输出**塞到 thinking 字段而不是 response**。chat.js 的 markers 检测 + NLU recovery 当时只看 `allText`（response 拼接），thinking 走另外的 `allThinking`，路径完全漏掉。

证据 — server log:
```
[INFO] Chat[non-stream]: thinking-only response from non-reasoning model glm-4.7;
        promoting 375c thinking → content
```

这条 promote 是个 v2.0.69 加的 fallback：模型给 thinking 但没 text 时把 thinking 当 content 返。但 promote 在 markers 检测**之后**跑，markers 当时 allText 是空 → 整个检测块跳过 → NLU 永远没机会运行。

### 修

`narrativeSource = (allText && allText.trim()) ? allText : allThinking` — markers 检测和 NLU recovery 都用这个合并源。non-stream + stream 两路都改。

NLU 抠到 tool_call 时同时清空 `allText` 和 `allThinking`（之前漏了 allThinking 清空）。

### 改动

- `src/handlers/chat.js` — non-stream + stream 两路 markers/NLU/fabricate 三段都用 `narrativeSource`，allThinking 也清空

### 数字

- 测试：792（不变）— 已有 case 覆盖了 narrate 路径，hotfix 是 wire-up 问题
- 全测 0 fail

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```
