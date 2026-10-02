# Data Structures and Error Codes

## RoomSnapshot

`RoomSnapshot` is the room state returned by `/join` and `/poll`, and is what the web client renders.

```ts
interface RoomSnapshot {
  roomId: string;
  name: string;
  /** Incremented on every playback or membership change */
  version: number;
  playback: Playback | null;
  hostClientId: string | null;
  /** Who decides what to play: "host" is host-only, "all" lets anyone */
  controlMode: "host" | "all";
  /** The one client currently allowed to drive playback; null means anyone may take over ("all" mode only) */
  driverClientId: string | null;
  members: MemberInfo[];
  serverTime: number;
  /** Queue version, incremented whenever the queue changes; clients use it to decide whether to re-fetch the queue */
  queueVersion: number;
  /** Queue length; the contents are fetched separately via /queue */
  queueLength: number;
}

interface Playback {
  track: PluginTrack | null;
  playing: boolean;
  /** Position (ms) at the moment of publishing */
  position: number;
  seq: number;
  clientTime: number;
  /** When the server received the snapshot; the baseline for progress estimation */
  publishedAt: number;
  sourceClientId: string;
}

interface MemberInfo {
  clientId: string;
  name: string;
  role: "host" | "guest";
  joinedAt: number;
  /** Last request time, used to detect offline members */
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
{ "ok": false, "error": "Incorrect room key", "code": "BAD_ROOM_KEY" }
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
