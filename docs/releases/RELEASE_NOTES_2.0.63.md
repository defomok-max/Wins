## v2.0.63 — v2.0.62 hotfix (`body is not defined` 修)

v2.0.62 的 gpt_native dialect 改动里，nonStreamResponse 内部的 `parseToolCallsFromText` 引用了 `body.__route` —— 但 `body` 不在 nonStreamResponse 的作用域里。生产 smoke test 第一秒就炸 `Chat error: body is not defined`。

修法：

- `nonStreamResponse` 加 `route = 'chat'` 位置参数（v2.0.55 加 `tools` 的同款做法）
- `handleChatCompletions` caller 在 body 还可见的作用域里传 `body.__route || 'chat'`
- nonStreamResponse 内部用本地 `route` 变量
- `stream-cache-policy.test.js` 静态正则放宽允许 `body.__route || 'chat'` 这种表达式作为位置参数（仍卡住 cachePolicy 必须传）

测试：654/654 全绿。逻辑跟 v2.0.62 一致 — gpt_native dialect 完整 wire 通。

升级：

```bash
docker compose pull && docker compose up -d
```
