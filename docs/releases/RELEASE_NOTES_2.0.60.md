## v2.0.60 — Dashboard 体验大改：日志导出 + 柱状图 crosshair + 上游端点透明 + GOD/MR/LR 稀有度

用户反馈一波到底：

1. 从本地 Windsurf 导入按了之后报 `ERR_LOCAL_IMPORT_NOT_AVAILABLE_PUBLIC_BIND` —— 是正常安全设计，但 UI 不该让你点完才报错
2. RegisterUser / GetPlanStatus 这俩端点你做完了吗
3. 想要 dashboard UI 全面升级（下拉 / hover 跟随 / 日志导出）
4. 贡献者卡片 R / SR / SSR / UR 上面再加更高的稀有度

### Fix 1 — 日志导出（issue 上交时方便附数据）

**新后端**：`GET /dashboard/api/logs/export?type=all|api|system&format=jsonl|txt&level=...`

- `type=api` 过滤出 Probe/Chat/Cascade/ToolGuard/ToolParser 等请求路径日志
- `type=system` 过滤出系统级（账号池、LS 生命周期、cron、auth pool）
- `type=all` 全要
- `format=jsonl` 机器可读、`format=txt` 人眼读
- 自动加 `Content-Disposition` 让浏览器直接下载

**Dashboard UI**：日志面板加一行下拉 + 按钮，三选一 type × 两选一 format × 日志级别（继承上面已有的过滤）。fetch + blob 下载（不能用 `<a download>` 因为要带 `X-Dashboard-Password` header）。

### Fix 2 — 柱状图 hover crosshair（鼠标到哪线就到哪）

**`_paintChart`** 接收 `_chartCursorIdx`，重画时画一根 dash vertical line + 当前 bucket 顶部高亮 ring。`_bindChartHover` mouse move / leave 修改 cursor index 触发重画。 

- 空 bucket（drought 时 0 数据）也画个小 marker，光标到了让你知道"这小时确实没流量"
- 索引不变时跳过重画（不会浪费）
- 动画进行中（progress < 1）不画 crosshair 避免跟入场动画打架

### Fix 3 — local-windsurf 按钮 public bind 时友好

**新后端**：`GET /dashboard/api/accounts/import-local-availability` cheap probe，返 `{available, reason, hint}`。

**Dashboard UI**：进入登录取号面板自动 preflight，public bind 时按钮 disabled + 下面一行灰色提示 "此实例绑定在公网/0.0.0.0 上 — '本地' Windsurf 是远端服务器上的，不是你电脑里的"。不再让你点完才报 403。

ERR 本身是正常安全设计 — server 跑在远程，"本地"不是你的本地。本地部署（`HOST=127.0.0.1`）才能用这个功能。

### Fix 4 — Upstream endpoints 透明（确认 RegisterUser / GetPlanStatus 真的迁了）

**新后端**：`GET /dashboard/api/upstream-endpoints` 列出所有上游端点的 primary + fallback + 协议 + 迁移版本：

- **RegisterUser** primary `register.windsurf.com/.../SeatManagementService/RegisterUser` (Connect-RPC, 新, v2.0.57 迁) / fallback `api.codeium.com/register_user/` (REST, 旧)
- **WindsurfPostAuth** primary `windsurf.com/_backend/...` (新, v2.0.57) / fallback `server.self-serve.windsurf.com/...` (旧)
- **GetOneTimeAuthToken** 同上
- **CheckUserLoginMethod** primary `windsurf.com/_backend/...` (新, v2.0.39)
- **GetUserStatus** `server.codeium.com/.../GetUserStatus` — 内置 daily/weekly% 解析，**等价覆盖 wam-bundle 的 GetPlanStatus**（同 service 不同 RPC，字段被 GetUserStatus.planStatus 嵌套覆盖）
- **GetCascadeModelConfigs** 模型 catalog
- **Firebase Auth** identitytoolkit.googleapis.com 直连 + securetoken.googleapis.com refresh

后续 dashboard 实验性面板可以 surface 这个数据；当前 endpoint 已可 curl。

### Fix 5 — Contributors 卡片新稀有度（GOD / MR / LR）

之前只到 UR（S+），baily-zhang 4 PR 全 S+ / aict666 4 PR 全 S+ 都挤一个 UR badge 看不出差异。新加：

| 稀有度 | 触发 | 视觉 |
| --- | --- | --- |
| **GOD** | 项目作者（dwgx 自己加一卡） | 5 色彩虹动画渐变（金/粉/紫/蓝/绿）+ 4s pulse + 字加白光 |
| **MR** Mythic Rare | 多次 S+ 累积突破单 PR 上限（aict666 4×S+） | 青→紫→粉斜渐变 + 紫光晕 |
| **LR** Legendary Rare | 单 PR S++（baily-zhang #61 Opus 多模态救星） | 紫→靛→青 prism 渐变 |
| UR | S+ | 原黄红紫保持 |
| SSR / SR / R | S/A+ / A/B+ / B 及以下 | 原色 + 新加 R level 灰底 |

`weightRank` 表加 `GOD=100 / MR=12 / LR=10 / S++=10` 让 sort 顺序正确。

### 数字

- 测试：639 / 639 全绿（纯 dashboard 改动 + 后端 3 个新 GET API）
- 改动：4 src 文件 + 2 i18n + 1 contributors.json + 1 release notes

### 升级

```bash
docker compose pull && docker compose up -d
```

部署后：
- 进 dashboard 统计分析 → 鼠标在柱状图上滑，crosshair 跟到哪
- 运行日志面板下方有"全部日志/API 请求/系统运行 × JSONL/纯文本"选择 + 下载按钮
- 登录取号面板的"从本地 Windsurf 导入"现在公网 bind 直接 disabled + 提示
- 致谢页面的卡片：dwgx 是 GOD，aict666 是 MR，baily-zhang 是 LR
- 想看上游端点状态：`curl -H 'X-Dashboard-Password: $PW' $HOST:3888/dashboard/api/upstream-endpoints`
