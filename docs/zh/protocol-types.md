# 数据结构与错误码

## RoomSnapshot

`RoomSnapshot` 是 `/join`、`/poll` 的返回值里的房间快照，也是网页端看到的东西。

```ts
interface RoomSnapshot {
  roomId: string;
  name: string;
  /** 播放状态或成员变化都会 +1 */
  version: number;
  playback: Playback | null;
  hostClientId: string | null;
  /** 谁能决定听什么：host 只有房主 / all 谁都可以 */
  controlMode: "host" | "all";
  /** 当前唯一有权决定播放状态的人；空着表示谁都能接手（仅 all 模式） */
  driverClientId: string | null;
  members: MemberInfo[];
  serverTime: number;
  /** 队列版本，队列一变就 +1；客户端据此决定要不要重新拉队列 */
  queueVersion: number;
  /** 队列长度；内容走 /queue 单独拉 */
  queueLength: number;
}

interface Playback {
  track: PluginTrack | null;
  playing: boolean;
  /** 发布那一刻的进度（毫秒） */
  position: number;
  seq: number;
  clientTime: number;
  /** 服务端收到该快照的时刻，进度推算的基准 */
  publishedAt: number;
  sourceClientId: string;
}

interface MemberInfo {
  clientId: string;
  name: string;
  role: "host" | "guest";
  joinedAt: number;
  /** 最近一次请求时刻，用来判定离线 */
  lastSeen: number;
}
```

> 注意：控制模式切换与队列变化同样会使 `version` +1（以便唤醒长轮询）；队列自身的精细变化另用 `queueVersion` 追踪。

## PluginTrack

`PluginTrack` 的定义见 [`server/src/types.ts`](../../server/src/types.ts) —— 它是 SPlayer Track 的**宽松子集**，只保证列出的字段，未列出的字段原样透传（这样宿主新增字段时服务端不用改）。

**不要裁剪 Track**：听众端要把整条 track 交给本机 MCP 的 `play_track`，裁剪会破坏 `play_track` 或后续版本新增的字段（见[经 MCP 点名播歌](plugin-mcp.md)）。

## 错误响应

统一格式：

```json
{ "ok": false, "error": "房间口令不正确", "code": "BAD_ROOM_KEY" }
```

`error` 文案随服务端 `LOCALE` 变化（见[概览与鉴权](protocol-overview.md#错误信息本地化)），**客户端应以 `code` 为准**。

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` / `BAD_JSON` / `BAD_ROOM_ID` | 参数问题（缺字段 / 请求体不是合法 JSON / 房间 ID 不合法） |
| 401 | `SERVER_KEY_REQUIRED` | 服务端密钥缺失或不正确 |
| 403 | `BAD_ROOM_KEY` | 房间口令不对 |
| 403 | `NOT_ALLOWED` | 无控制权却修改队列（remove / clear） |
| 404 | `ROOM_NOT_FOUND` / `NOT_FOUND` | 房间或接口不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不对 |
| 409 | `ROOM_FULL` / `NOT_JOINED` | 人满（默认上限 32）/ 未加入就操作 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 256KB |
| 500 | `INTERNAL` | 服务端内部错误 |
