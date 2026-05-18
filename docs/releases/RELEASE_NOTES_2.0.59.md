## v2.0.59 — Dashboard 统计图视觉修复（不再"6 pts 大跳"）

用户反馈 24h 范围下 dashboard 只显示 6 个数据点，红绿大块跳跃看着很丑。问题双重：

1. **后端 `hourlyBuckets` 只记录有流量的小时**，前端 `_filterBuckets(24)` 拿到的是稀疏数组（24h 内只跑了 6 小时 → 6 个 bucket）
2. **柱状图配色**（indigo/emerald/rose）饱和度太高，看着像告警

### 修法

**`_padTimeline(present, startMs, endMs)`** 新 helper：把后端给的稀疏 buckets 补齐成连续小时序列，缺失的 hour 用 `{requests:0, errors:0, success:0}` 占位。`_filterBuckets` 在 6h / 24h / 7d / 30d / custom 五种 range 模式下都过这一道。

**0 数据 bucket 的视觉处理**：`drawBars` 和 `drawStacked` 之前 `if (v === 0) return` 直接跳过 — 现在改成画 1px 高的 baseline tick，让节奏感不断。空小时也"看得见"。

**配色更柔和**：
- requests: indigo `#818cf8` → 暖琥珀 `#e0b482`
- success: emerald `#34d399` → 茶薄荷 `#7cc8a6`
- errors: rose `#fb7185` → 灰珊瑚 `#e08a8a`

`_pieColors` 同步换成对应的暖色 palette（米色/雾蓝/浅紫/淡粉等 8 色）。

### 数字

- 测试：639 → 639（纯视觉改动，无逻辑变化）
- diff: 1 文件（src/dashboard/index.html），约 70 行

### 升级

```bash
docker compose pull && docker compose up -d
```

不需要 force-recreate（无 env 变化）。打开 dashboard → 统计分析，24h 现在应该显示 24 个连续 bucket，节奏均匀，颜色不刺眼。
