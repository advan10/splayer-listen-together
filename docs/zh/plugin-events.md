# SPlayer-Next 插件系统：事件与反向控制

这是插件调研笔记的第二篇：控制插件能订阅哪些事件、能反向做哪些控制。第一篇见[插件类型与沙箱](plugin-overview.md)。

## 控制插件的事件

`splayer.player.on(kind, handler)`，只有 `register({ events: [...] })` 里声明过的才会下发：

| 事件 | 载荷 | 触发时机 |
| --- | --- | --- |
| `trackChange` | `{ track }` | 曲目切换 |
| `lyricChange` | `{ lines }` | 歌词整体变化 |
| `lineChange` | `{ index, position }` | **当前歌词行**变了 |
| `playStateChange` | `{ state, position }` | 播放态**翻转**时 |

依据 `electron/main/plugins/playbackBridge.ts`：

- `playStateChange` 只在 `pluginState !== lastPluginState` 时广播 —— **不是**进度推送；
- `lineChange` 靠 `findIndex(position)` 推进，**歌词为空时一次都不会发**。

> ⚠️ 所以插件拿不到连续的进度流。没歌词的歌在播放期间**完全没有事件**。
> 一起听插件因此必须有自己的心跳：定时调 `player.getPosition()` 兜底。
> 文档也提醒 `getPosition()` 每次都是一次往返，只适合偶发查询。

插件启用时宿主会立刻补发一次当前快照（`primePlugin`），所以不用自己拉初始值。

## 反向控制：只有六个动作

`PluginPlayerApi`（`shared/types/plugin.ts`）—— 这就是全部：

```ts
play() / pause() / next() / prev() / seek(ms) / setVolume(0~1) / getPosition(): Promise<number>
```

`HostCallMethod` 里也只列了 `player.play` / `player.pause` / `player.next` /
`player.prev` / `player.seek` / `player.setVolume` / `player.getPosition`。

**没有 `playTrack`。** 这是本项目最大的约束。

外部 HTTP API（`/api/*`）和 WebSocket API 同样只有
play / pause / stop / next / prev / seek / setVolume —— 也没有点名播歌。

唯一能「点名播某首歌」的本地入口是 SPlayer 内置的 MCP 接口，见下一篇[经 MCP 点名播歌](plugin-mcp.md)。
