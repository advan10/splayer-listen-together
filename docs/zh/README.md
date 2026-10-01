# 一起听 · 文档索引

本目录是项目的**简体中文文档**；英文版在 [`docs/en/`](../en/README.md)，两者文件名与标题结构完全一致。

面向使用者的安装、配置与排错说明见仓库根目录的 [README.zh-CN.md](../../README.zh-CN.md)（英文版 [README.md](../../README.md)）。

## 协议文档（服务端 ↔ 插件 / 网页端）

| 文件 | 内容 |
| --- | --- |
| [protocol-overview.md](protocol-overview.md) | 协议概览、通用约定、鉴权（`SERVER_KEY`）与错误信息本地化 |
| [protocol-concepts.md](protocol-concepts.md) | 房主与控制者、控制模式、长轮询、时钟与进度推算 |
| [protocol-endpoints.md](protocol-endpoints.md) | 全部 HTTP 接口：健康检查、加入、上报、模式切换、长轮询、退出、快照、房间列表、SSE |
| [protocol-queue.md](protocol-queue.md) | 房间共享队列接口：点歌、删歌、清空 |
| [protocol-types.md](protocol-types.md) | `RoomSnapshot` 等数据结构与错误码总表 |

## 插件调研（SPlayer-Next 能力边界）

| 文件 | 内容 |
| --- | --- |
| [plugin-overview.md](plugin-overview.md) | 两类插件与沙箱能力边界 |
| [plugin-events.md](plugin-events.md) | 控制插件的事件与反向控制动作 |
| [plugin-mcp.md](plugin-mcp.md) | 经本机 MCP 点名播歌（自动切歌的唯一入口） |
| [plugin-track-and-settings.md](plugin-track-and-settings.md) | Track 结构、设置项、菜单与其它实用结论 |

> 协议「线上格式」的权威类型定义在 [`server/src/types.ts`](../../server/src/types.ts)；插件侧是等价的手写定义，两边需要同步修改。
