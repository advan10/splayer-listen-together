# Data Structures and Error Codes

## RoomSnapshot

`RoomSnapshot` is the room state returned by `/join` and `/poll`, and is what the web client renders.

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

> Note that switching the control mode and queue changes also increment `version` (so that long-poll waiters wake up); fine-grained queue changes are tracked separately via `queueVersion`.

## PluginTrack

`PluginTrack` is defined in [`server/src/types.ts`](../../server/src/types.ts) — a **loose subset** of the SPlayer Track. Only the listed fields are guaranteed; anything else passes through untouched (so the host app can add fields without the server caring).

**Do not trim the Track**: listeners hand the whole object to the local MCP `play_track` tool, and trimming can break `play_track` or drop fields added in later versions (see [Playing a Track via MCP](plugin-mcp.md)).

## Error responses

Common shape:

```json
{ "ok": false, "error": "房间口令不正确", "code": "BAD_ROOM_KEY" }
```

The `error` text follows the server's `LOCALE` (see [Overview and Authentication](protocol-overview.md#error-message-localization)); **clients should rely on `code`**.

| HTTP | code | Meaning |
| --- | --- | --- |
| 400 | `BAD_REQUEST` / `BAD_JSON` / `BAD_ROOM_ID` | Bad input (missing fields / body is not valid JSON / invalid room ID) |
| 401 | `SERVER_KEY_REQUIRED` | Server key missing or incorrect |
| 403 | `BAD_ROOM_KEY` | Wrong room key |
| 403 | `NOT_ALLOWED` | Queue remove/clear without control |
| 404 | `ROOM_NOT_FOUND` / `NOT_FOUND` | Room or endpoint does not exist |
| 405 | `METHOD_NOT_ALLOWED` | Wrong HTTP method |
| 409 | `ROOM_FULL` / `NOT_JOINED` | Room full (32 by default) / operation without having joined |
| 413 | `PAYLOAD_TOO_LARGE` | Request body exceeds 256 KB |
| 500 | `INTERNAL` | Internal server error |
