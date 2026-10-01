# SPlayer-Next 插件系统：Track 结构、设置项与实用结论

这是插件调研笔记的最后一篇。前三篇见[插件类型与沙箱](plugin-overview.md)、[事件与反向控制](plugin-events.md)、[经 MCP 点名播歌](plugin-mcp.md)。

## Track 的形状

来自 `shared/types/player.ts` / [类型参考](https://splayer-next.imsyy.top/types)。
在线平台的 `source` 取值是 **`netease` / `qqmusic` / `kugou`**（不是 lx 风格的 `wy`/`tx`/`kg`）。
本地是 `local`，流媒体服务器是 `streaming`。

常用字段：`id`、`source`、`title`、`artists[]`、`album?`、`duration`(ms)、`cover?`、`fee?`、`cloud?`。

> 一起听的服务端**不裁剪** Track，原样透传。裁剪会破坏 `play_track` 或后续版本新增的字段。

## 设置项与菜单

`register({ settings })` 支持四种控件：`switch` / `number` / `text` / `select`。
宿主会按 `type` 强转与夹取，插件读到的一定是规范化后的值。
改动通过 `splayer.onSettingChange(key, handler)` 实时送达。

`register({ menus })` 可以往歌曲菜单加项，需要 `@grant ui`。
点击经 `splayer.on("menuClick", ({ menuId, track }) => …)` 回调，
处理器**只能**通过返回值影响界面，三选一（可组合）：

```ts
{ toast?: string, openUrl?: string, copyText?: string }
```

> ⚠️ 这是控制插件**唯一**能主动给用户看东西的通道。
> 沙箱里没有 DOM，不能弹自定义面板，也没有「主动弹 toast」的 API。
> 所以一起听把状态查询做成了菜单项，而不是指望主动提示。

## 其它实用结论

- **权限**：`@grant network`（`splayer.request`）/ `control`（`splayer.player.*`）/ `ui`（菜单）。
  音源插件自动获得 `network`，控制插件必须显式声明。
- **存储**：`splayer.storage` 是每插件隔离的 KV，卸载时清空。适合存房主令牌。
- **错误码**：处理器里 `err.code` 可以带 `PLUGIN_*`；未带则默认 `PLUGIN_HANDLER_ERROR`。
- **崩溃隔离**：host 进程崩溃会按 2s → 8s → 30s 退避重启并重载插件，连续 3 次失败置为 `error`。
  插件里别写死循环 —— 所有插件共享 host 的一条事件循环。
- **调试**：DevTools 里 `await window.api.plugins.list()` 看状态，
  `await window.api.plugins.setSetting(id, key, value)` 实时改设置。日志在 `{userData}/app-data/logs/`。
