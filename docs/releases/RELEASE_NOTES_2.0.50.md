## v2.0.50 — gpt-5.5 上线 + Opus 4.7 max + 5.3-codex 全档位

issue #109 提到的「windsurf 已经支持 5.5 模型了」实测 GetCascadeModelConfigs 确认 cloud 上确实新加了一坨 SKU：

- **gpt-5-5-{none,low,medium,high,xhigh}** + 每个的 `-priority` 加速档（共 10 个）
- **claude-opus-4-7-max** —— 4.7 的最高推理档，比 xhigh 还大一档
- **gpt-5-3-codex-{low,high,xhigh}** + 各自的 `-priority`（之前只暴露了 medium）

之前这些只能靠 `mergeCloudModels` 启动时动态吞进来，问题是：
1. 名字会带原始下划线 / 连字符（`gpt-5-5-medium`），跟 OpenAI 官方习惯的点号（`gpt-5.5-medium`）对不上
2. credit multiplier 跟着 cloud 默认值走，没法手动校准
3. 客户端如果发 `gpt-5.5` 或 `claude-opus-4.7-max` 这类点号别名，根本找不到

现在显式塞进 `MODELS` + 加全套别名解析，pattern 完全对齐 5.2 / 5.4 那一套：

```
'gpt-5.5':                gpt-5-5-medium  (= bare 默认 medium)
'gpt-5.5-none':           gpt-5-5-none           credit 1
'gpt-5.5-low':            gpt-5-5-low            credit 1
'gpt-5.5-medium':         gpt-5-5-medium         credit 2
'gpt-5.5-high':           gpt-5-5-high           credit 4
'gpt-5.5-xhigh':          gpt-5-5-xhigh          credit 8
'gpt-5.5-none-fast':      gpt-5-5-none-priority  credit 2
'gpt-5.5-low-fast':       gpt-5-5-low-priority   credit 2
'gpt-5.5-medium-fast':    gpt-5-5-medium-priority credit 4
'gpt-5.5-high-fast':      gpt-5-5-high-priority  credit 8
'gpt-5.5-xhigh-fast':     gpt-5-5-xhigh-priority credit 16

'claude-opus-4-7-max':    claude-opus-4-7-max    credit 16
'claude-opus-4.7-max':    → claude-opus-4-7-max  (alias)
```

cloud-format 名字（`gpt-5-5-*` / `claude-opus-4-7-max` / `swe-1-6` / `minimax-m2-5` / `kimi-k2-5`）也都加进 `_lookup` 反向解析。所有 `gpt-5.5-*` 和 `claude-opus-4.7-max` 现在能从 OpenAI 协议或 Anthropic 协议直接调，credit 准。

### 一并清理的别名

- `kimi-k2-5` → `kimi-k2.5`
- `minimax-m2-5` → `minimax-m2.5`
- `swe-1-6` / `swe-1-6-fast` → `swe-1.6` / `swe-1.6-fast`

cloud 同时下发两种格式（带点和不带点），之前不带点那套会被当成新模型走 `mergeCloudModels` 创建出第二份重复条目，credit 多一份不准。现在都规范到带点的那一份。

### 数字

- 测试：497 → **500** (+3 / 0 失败)
- suites：105
- 改动：
  - `src/models.js`: +21 catalog entries / +27 alias 解析 / 注释说明 effort ladder + priority lane 含义
  - `test/models-catalog-correctness.test.js`: 3 个新 regression 钉死 5.5 ladder / opus-4.7-max / 5.3-codex 全档位

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完后 `/v1/models` 多 21 个新条目（5.5 系 11 + opus-max 1 + 5.3-codex 7 + 别名补全）。
