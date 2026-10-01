# SPlayer-Next 插件系统：经 MCP 点名播歌

这是插件调研笔记的第三篇。[上一篇](plugin-events.md)的结论是：控制插件 API 没有播放指定曲目的能力 —— MCP 是唯一的口子。

## MCP：唯一能「点名播某首歌」的入口

`electron/main/services/mcp/server.ts` 注册了 `play_track`：

```ts
play_track(trackId?: string, track?: Record<string, any>)
  → 优先用 trackId 查本地曲库；查不到就用传入的 track 对象
  → playerControl.playTrack(track)
```

`playerControl.playTrack` 走 `sendToMain("player:event", { type: "playTrack" })`，
渲染端在 `src/core/player/events.ts` 里接住 → `playNow(track)`
（`src/core/player/index.ts`）→ 插入队列并 `loadTrack`。
**任意一条完整 Track 都能播**，包括不在本地曲库里的在线歌曲。

也就是说：**把房主的整条 Track 原样交给 `play_track`，听众端就能播同一首歌**——
不需要自己搜歌、不需要比对歌名。一起听插件正是这么做的。

## MCP 的接入细节

`electron/main/services/mcp/http.ts` + `endpoint.ts`：

- 地址 `http://127.0.0.1:<port>/mcp`，默认端口 **14559**，**默认关闭**，需在设置里开启；
- 鉴权头 `X-MCP-Key`，值在设置页「配置详情」里可见（16 字节随机数的 hex）；
- `Origin` 头存在时必须是 localhost —— 从 Node 侧发请求不带 `Origin`，没问题；
- 会话说 `Mcp-Session-Id`：先 `initialize` 拿 ID，之后每个请求都带上；
  服务端最多留 8 个会话、空闲 30 分钟回收 —— 所以插件要能在 404 时重开会话；
- `enableJsonResponse: true`，响应是纯 JSON。

## 参数为什么要传整条 Track

`play_track` 用 `trackId` 时会走 `getTrackById()`（查本地曲库），
在线歌曲不在本地库里，查不到就返回 `undefined`。
所以必须走 `track` 参数，且 `track.id` 必须是字符串。

## 插件经 MCP 还能做什么

一起听插件还通过同一个 MCP 连接调用 `add_to_queue`，把房间共享队列里新加的歌推进本机播放列表（见根目录 README 的「房间队列」一节）。要注意 MCP 对队列同样只能「往里加」：读不到本机队列、也删不掉，所以队列同步是**单向的尽量对齐**。

## 如果以后插件 API 支持了点名播歌

那么一起听插件里 `mcp` 那一段（约 120 行）就可以整个删掉，
把 `mcp.playTrack(track)` 换成 `splayer.player.playTrack(track)` 即可，
其余逻辑（房间、时钟、跟随判定）都不用动。

这也是为什么插件里把「播放某首歌」收敛成了一个 `mcp.playTrack(track)` 调用点。
