# SPlayer-Next 插件系统：能力边界调研

写这个项目之前把 SPlayer-Next 的插件系统、类型定义和实现都过了一遍。
这份笔记记录的是**结论和依据**，尤其是那些「文档没直说、但决定了架构」的地方。
代码仓库：[SPlayer-Dev/SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next)（`dev` 分支）。

---

## 1. 两类插件

| 类型 | `@type` | 能做什么 |
| --- | --- | --- |
| 音源插件 | `source`（默认） | 提供 `musicUrl` 解析、歌词/封面兜底 |
| 控制插件 | `control` | 订阅播放事件、反向控制播放、声明设置项、加歌曲菜单项 |

一个脚本只能是一种类型。**一起听用的是 `control`。**

控制插件需要在头部声明 `@apiLevel 2`；宿主当前 API 级别是 3
（`shared/defaults/plugin-api.ts` 的 `HOST_API_LEVEL = 3`）。声明值高于宿主会被拒绝加载。

---

## 2. 沙箱里有什么（决定了插件怎么写）

宿主在独立子进程里为每个插件建 `node:vm` 上下文，注入一个全局对象 `splayer`。

**能用**：`splayer`、`Buffer`、`URL`/`URLSearchParams`、`TextEncoder`/`TextDecoder`、
`btoa`/`atob`、`Promise`、`queueMicrotask`、定时器、`console`（转发到 `splayer.log`）。

**不能用**：Node 内置模块、`require`/`import`、DOM、Electron API、`fetch`、`WebSocket`。

网络只能走 `splayer.request`，且仅允许 `http://` / `https://`，默认超时 15s、上限 60s。
顶层同步代码有 5 秒执行时限。

> **这直接决定了两件事**：插件不能用 WebSocket（所以服务端必须支持长轮询），
> 插件不能 `npm install` 任何东西（所以插件是单文件、零依赖）。

---

## 3. 控制插件的事件

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
> 一起听插件因此必须有自己心跳：定时调 `player.getPosition()` 兜底。
> 文档也提醒 `getPosition()` 每次都是一次往返，只适合偶发查询。

插件启用时宿主会立刻补发一次当前快照（`primePlugin`），所以不用自己拉初始值。

---

## 4. 反向控制：只有六个动作

`PluginPlayerApi`（`shared/types/plugin.ts`）—— 这就是全部：

```ts
play() / pause() / next() / prev() / seek(ms) / setVolume(0~1) / getPosition(): Promise<number>
```

`HostCallMethod` 里也只列了 `player.play` / `player.pause` / `player.next` /
`player.prev` / `player.seek` / `player.setVolume` / `player.getPosition`。

**没有 `playTrack`。** 这是本项目最大的约束。

外部 HTTP API（`/api/*`）和 WebSocket API 同样只有
play / pause / stop / next / prev / seek / setVolume —— 也没有点名播歌。

---

## 5. 唯一能「点名播某首歌」的入口：MCP

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

### MCP 的接入细节

`electron/main/services/mcp/http.ts` + `endpoint.ts`：

- 地址 `http://127.0.0.1:<port>/mcp`，默认端口 **14559**，**默认关闭**，需在设置里开启；
- 鉴权头 `X-MCP-Key`，值在设置页「配置详情」里可见（16 字节随机数的 hex）；
- `Origin` 头存在时必须是 localhost —— 从 Node 侧发请求不带 `Origin`，没问题；
- 会话说 `Mcp-Session-Id`：先 `initialize` 拿 ID，之后每个请求都带上；
  服务端最多留 8 个会话、空闲 30 分钟回收 —— 所以插件要能在 404 时重开会话；
- `enableJsonResponse: true`，响应是纯 JSON。

### 参数为什么要传整条 Track

`play_track` 用 `trackId` 时会走 `getTrackById()`（查本地曲库），
在线歌曲不在本地库里，查不到就返回 `undefined`。
所以必须走 `track` 参数，且 `track.id` 必须是字符串。

---

## 6. Track 的形状

来自 `shared/types/player.ts` / [类型参考](https://splayer-next.imsyy.top/types)。
在线平台的 `source` 取值是 **`netease` / `qqmusic` / `kugou`**（不是 lx 风格的 `wy`/`tx`/`kg`）。
本地是 `local`，流媒体服务器是 `streaming`。

常用字段：`id`、`source`、`title`、`artists[]`、`album?`、`duration`(ms)、`cover?`、`fee?`、`cloud?`。

> 一起听的服务端**不裁剪** Track，原样透传。裁剪会破坏 `play_track` 或后续版本新增的字段。

---

## 7. 设置项与菜单

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

---

## 8. 其它实用结论

- **权限**：`@grant network`（`splayer.request`）/ `control`（`splayer.player.*`）/ `ui`（菜单）。
  音源插件自动获得 `network`，控制插件必须显式声明。
- **存储**：`splayer.storage` 是每插件隔离的 KV，卸载时清空。适合存房主令牌。
- **错误码**：处理器里 `err.code` 可以带 `PLUGIN_*`；未带则默认 `PLUGIN_HANDLER_ERROR`。
- **崩溃隔离**：host 进程崩溃会按 2s → 8s → 30s 退避重启并重载插件，连续 3 次失败置为 `error`。
  插件里别写死循环——所有插件共享 host 的一条事件循环。
- **调试**：DevTools 里 `await window.api.plugins.list()` 看状态，
  `await window.api.plugins.setSetting(id, key, value)` 实时改设置。日志在 `{userData}/app-data/logs/`。

---

## 9. 如果以后插件 API 支持了点名播歌

那么一起听插件里 `mcp` 那一段（约 120 行）就可以整个删掉，
把 `mcp.playTrack(track)` 换成 `splayer.player.playTrack(track)` 即可，
其余逻辑（房间、时钟、跟随判定）都不用动。

这也是为什么插件里把「播放某首歌」收敛成了一个 `mcp.playTrack(track)` 调用点。
