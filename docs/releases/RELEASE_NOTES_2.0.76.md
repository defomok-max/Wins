## v2.0.76 — NLU 误抠占位符 patch（v2.0.75 实测追加）

v2.0.75 ship 后跑了一波 e2e probe 实测各 issue 场景，发现 GLM-4.7 走 NLU recovery 时偶尔抠出 2 个 tool_calls，第二个是 `shell_exec({"command":"command"})` — 把"command"关键词自身当成 args value 了。

VPS log 里直接看到：

```
[INFO] NLU recovery: extracted 2 tool_call(s) from narrative —
       shell_exec@narrative/0.65, shell_exec@narrative/0.65
[INFO] Chat[non-stream]: NLU recovery — promoted 2 narrative tool_call(s)
```

第一个 `command="echo HELLO_FROM_..."` 是真的，第二个 `command="command"` 是误抠 — Layer 3 narrative 正则吃到了"with command 'command' as the parameter name"这种 GLM 自我解释里的 dialect echo。

修法：Layer 3 抠到 value 后过一道 placeholder 黑名单，命中 `command|argument|param|parameter|input|value|file_path|path|query|string|text|name|arg` 直接丢弃。

### 改动

- `src/handlers/intent-extractor.js` — Layer 3 加 PLACEHOLDER_VALUES 过滤
- `test/intent-extractor.test.js` — +2 case（rejects placeholder values + dedupes echo pattern）

### 数字

- 测试 805 → **807**（+2）
- 全测 0 fail / 0 回归

### 升级

```bash
docker compose pull && docker compose up -d --force-recreate
```

GLM/Kimi/Gemini 这种 narrate 说话体的模型现在不会再抠出 placeholder 误调。

### 这版还做了一件事

跑 e2e probe 验证 #122 / #124 / #116 / #120 / #115 五个 issue 在 v2.0.75 上的修复是不是真生效。结果在各 issue 评论区贴了 — 不靠想，靠真证据。
