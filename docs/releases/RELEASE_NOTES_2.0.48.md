## v2.0.48 — 一键更新踩了三连坑

VPS 反代上点「检查更新」→「一键更新并重启」，dashboard 上面跳出来一段离谱的红字：

```
✗ Failed to execute 'querySelector' on 'Document': '[data-i18n=
"error.docker API POST /containers/create -> 404: {"message":
"No such image: docker:24-cli"} "]' is not a valid selector.
```

这一行错误把三个独立的 bug 串在一起爆出来。挨个拆。

### Bug 1 / 后端没拉部署器 sidecar 镜像

`runDockerSelfUpdate` 流程是

```
detectDockerSelfUpdate    // 找出当前容器 + project + workdir + 自身 image
dockerPull(ctx.image)     // 拉新版 windsurf-api
POST /containers/create   // 用 docker:24-cli 起一个 sidecar 跑 compose up -d
POST /containers/.../start
```

老逻辑只 `dockerPull(ctx.image)` 把 windsurf-api 镜像更新了，从来没拉过 `docker:24-cli` 这个 sidecar 镜像。第一次在新主机上点这个按钮，本地没缓存 → `POST /containers/create` 直接 404 `No such image: docker:24-cli`。

修：在创建 sidecar 之前补一刀 `dockerPull(DEPLOYER_IMAGE)`。`docker:24-cli` 大概 30 MB，每个主机一次性成本，之后都走本地 cache。同时新增一个独立的 `deployer-pull-failed` reason 码，跟 `pull-failed`（应用镜像拉取失败）区分开。

### Bug 2 / 前端 detail 和 reason 顺序写反

`applyUpdate()` 老逻辑：

```js
throw new Error(this.translateError(r.detail || r.reason, 'error.updateFailed'));
```

`r.detail` 是上游 docker API 抛回来的原始报错（`docker API POST /containers/create -> 404: {"message":"..."}` 这种长串）。`r.reason` 是后端定义的稳定短码（`deployer-create-failed` 之类）。`||` 表达式让长且不稳定的 detail 优先于短而稳定的 reason，结果整段离谱字符串被 `translateError` 当 errorCode 拼成 `error.<那一长串>` 喂进 i18n 解析器。

修：

```diff
- throw new Error(this.translateError(r.detail || r.reason, 'error.updateFailed'));
+ const localized = this.translateError(r.reason, 'error.updateFailed');
+ const msg = r.detail ? `${localized} — ${r.detail}` : localized;
+ throw new Error(msg);
```

短码做本地化文案，长 detail 仅作为 debug 后缀拼到末尾。本地化文案的 i18n key 本身永远是干净 ASCII，绝对不会进 querySelector 出意外。

### Bug 3 / I18n.t 的 zh-CN fallback 直接吃任何字符串

```js
if (code === 'zh-CN') {
  const el = document.querySelector(`[data-i18n="${key}"]`);
  if (el?.dataset.i18nOrig) return el.dataset.i18nOrig;
}
```

这段是用来在 zh-CN 模式下从 HTML 里读 fallback 文案的。但 `key` 没做任何 escape：只要 key 里出现 `"` `{` `}` `[` `]` `:` `\` 这种 CSS selector 元字符，整个 querySelector 就会抛 `SyntaxError`，再向上冒变成 dashboard 上那条红字。

Bug 1 + Bug 2 单独都不会让用户看到这条骇人的 querySelector 错误——是 Bug 3 把后端 error 字面变成了一个无效 CSS selector，把整段堆栈直接扔到 UI 上。

修两层防御：

```js
if (code === 'zh-CN' && /^[A-Za-z0-9_.-]+$/.test(key)) {
  try {
    const el = document.querySelector(`[data-i18n="${CSS.escape(key)}"]`);
    if (el?.dataset.i18nOrig) return el.dataset.i18nOrig;
  } catch { /* selector still rejected — give up and return the key */ }
}
```

第一层：charset 检查，只有正经的 dotted i18n key（字母数字下划线点连字符）才走 querySelector 路径。
第二层：`CSS.escape()` + `try/catch` 兜底——万一未来还有别的代码路径塞了奇怪的 key 进来，也只会优雅降级到 key 本身，不会再冒堆栈。

### i18n key 补齐

zh-CN.json 和 en.json 都补了五条新 key，对应五个 reason 码：

```json
"pull-failed":            "拉取镜像失败",
"deployer-pull-failed":   "拉取部署器镜像 docker:24-cli 失败",
"deployer-create-failed": "创建部署器容器失败",
"deployer-create-no-id":  "创建部署器容器后没收到 ID",
"deployer-start-failed":  "启动部署器容器失败",
```

下次再有 sidecar 任何一步失败，dashboard 上看到的就是「拉取部署器镜像 docker:24-cli 失败 — \<原始 docker daemon 错误\>」这种结构清晰的提示。

### 数字

- 测试：v2.0.47 是 490 → v2.0.48 是 **494** (+4 / 0 失败)
- suites：101 → **104** (+3)
- 改动：
  - `src/dashboard/docker-self-update.js`: 加 `dockerPull(DEPLOYER_IMAGE)` 步骤
  - `src/dashboard/index.html`: `I18n.t` zh-CN fallback 加 charset + CSS.escape + try/catch；`applyUpdate` docker-mode 错误分支用 reason 而不是 detail
  - `src/dashboard/i18n/{zh-CN,en}.json`: 补五个 reason key
  - `test/docker-self-update.test.js`: 加 4 个 regression 钉死调用顺序 / reason 优先 / querySelector 安全

### 升级路径

```bash
docker compose pull && docker compose up -d
```

升完之后再点「一键更新并重启」，第一次会比之前慢个十几秒（第一次拉 `docker:24-cli`），然后 sidecar 启动 → 8 秒后 compose recreate → 你的容器接管新版本。再次点击就走 cache 不会等。
