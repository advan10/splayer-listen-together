# SPlayer-Next 插件系统：插件类型与沙箱

写这个项目之前把 SPlayer-Next 的插件系统、类型定义和实现都过了一遍。这组笔记记录的是**结论和依据**，尤其是那些「文档没直说、但决定了架构」的地方。

代码仓库：[SPlayer-Dev/SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next)（`dev` 分支）。以下论断均针对该仓库，不随本仓库的代码变化。

> 本组笔记共四篇：[插件类型与沙箱](plugin-overview.md)、[事件与反向控制](plugin-events.md)、[经 MCP 点名播歌](plugin-mcp.md)、[Track 与设置项](plugin-track-and-settings.md)。

## 两类插件

| 类型 | `@type` | 能做什么 |
| --- | --- | --- |
| 音源插件 | `source`（默认） | 提供 `musicUrl` 解析、歌词/封面兜底 |
| 控制插件 | `control` | 订阅播放事件、反向控制播放、声明设置项、加歌曲菜单项 |

一个脚本只能是一种类型。**一起听用的是 `control`。**

控制插件需要在头部声明 `@apiLevel 2`；宿主当前 API 级别是 3（`shared/defaults/plugin-api.ts` 的 `HOST_API_LEVEL = 3`）。声明值高于宿主会被拒绝加载。

## 沙箱里有什么（决定了插件怎么写）

宿主在独立子进程里为每个插件建 `node:vm` 上下文，注入一个全局对象 `splayer`。

**能用**：`splayer`、`Buffer`、`URL`/`URLSearchParams`、`TextEncoder`/`TextDecoder`、`btoa`/`atob`、`Promise`、`queueMicrotask`、定时器、`console`（转发到 `splayer.log`）。

**不能用**：Node 内置模块、`require`/`import`、DOM、Electron API、`fetch`、`WebSocket`。

网络只能走 `splayer.request`，且仅允许 `http://` / `https://`，默认超时 15s、上限 60s。顶层同步代码有 5 秒执行时限。

> **这直接决定了两件事**：插件不能用 WebSocket（所以服务端必须支持[长轮询](protocol-concepts.md#长轮询)），插件不能 `npm install` 任何东西（所以插件是单文件、零依赖）。
