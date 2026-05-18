## v2.0.78 — 严格 dual-audit 4 HIGH 全修

跑 codex 互审 + claude 自审，挖出 4 条之前 5 个 release 都漏的真问题。

### H-1 #108 zhangzhang-bit · workspace_information XML 块没 strip

zhangzhang-bit 截图证据 — 响应里漏出 cascade 远程沙箱注入的 `<workspace_information>` / `<workspace_layout>` / `<user_information>` 整块，包括 `workspace-devinxse` 路径。`sanitize.js` 之前只 strip 路径字符串，没 strip XML wrapper 整块。

修：`sanitize.js` PATTERNS 加 3 条整块 strip + `PathSanitizeStream` 加 strip-block-tags hold 跨 chunk 拦住流式泄露。

### H-2 NLU Layer 3 抠 "a shell command." 这种 prose value

GLM-4.7 narrate "I should call shell_exec to run a shell command." → Layer 3 `to <verb>` pattern 抓到 `"a shell command."` 当 args value。v2.0.76 加的 PLACEHOLDER 只查单词 `command`，不查多词短语。

修：抽 `looksLikePlaceholderValue` 帮手函数，三层 (Layer 1/2/3) 全过滤。拒绝单词关键词 + article-led prose（`a/an/the/this/your/some/...` 开头的短语）。

### H-3 `normalizeSystemPromptForHash` 的 `Current time:` / `cwd:` 是 no-op bug

v2.0.61 加的代码：

```js
.replace(/^[ \t]*[-•]?\s*(?:Working\s+directory|...|cwd|CWD)\s*[:：][^\n]*/gim,
         '$&'.replace(/[^:：]+$/, ' <cwd>'))
```

第二个 replace 在 parse-time 求值 — `'$&'` 是字面字符串没冒号，整个被 `/[^:：]+$/` 匹配，replace 成 `' <cwd>'`。最终 replacement 是字面 `' <cwd>'`，**整行（含 label）被替换成 ` <cwd>`**。两个不同 label 的 session（`Working directory:` vs `cwd:`）在 normalize 后撞 hash → 潜在跨 session reuse。

修：用真 capture group `($1)` 保留 label。三处都修（cwd / Current time / Session ID）。

### H-4 v2.0.77 NLU 入口扩宽副作用：Layer 3 在 markers=xml_tag 时跑出垃圾

v2.0.77 把 NLU 入口从 `markers === none` 扩宽到 `parser=0 tool_calls`。但 Layer 3 narrative 在 `markers=xml_tag/fenced_json/openai_native/bare_json` 时跑会抓到 prose（模型 emit 的明明是结构化 marker，prose 是描述不是参数）。

修：`extractIntentFromNarrative` 加 `opts.markers` 参数。结构化 marker 出现 + 没 natural_lang marker → 跳过 Layer 3，只跑 Layer 1+2 explicit / backtick 抠。chat.js 两路 (non-stream + stream) 把 markers 传下去。

### 改动

- `src/sanitize.js` — PATTERNS 加 3 条 XML 块 strip + `STRIP_BLOCK_TAGS` 给 stream
- `src/handlers/intent-extractor.js` — `looksLikePlaceholderValue` + 三层都过 + `opts.markers` 分档
- `src/conversation-pool.js` — 3 处 capture-group fix
- `src/handlers/chat.js` — 两路 NLU 调用传 markers
- `test/v2078-audit-fixes.test.js` — 新（18 case）

### 数字

- 测试 807 → **825**（+18）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

### 审计 process

按 `feedback_audit_workflow.md` 四段式 dual-audit 跑 — 这种"改了几版还在出 bug"的状况下用户自己说"严格审计" 触发的。issue 不再靠想，每条 HIGH 都有 file:line 证据 + PoC。
