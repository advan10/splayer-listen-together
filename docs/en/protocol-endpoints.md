# Endpoint Reference

Unless noted otherwise, endpoints are `POST` and exchange JSON. See [Overview and Authentication](protocol-overview.md) for the auth rules, [Shared Room Queue](protocol-queue.md) for the queue endpoints, and [Data Structures and Error Codes](protocol-types.md) for payload shapes.

## Endpoint overview

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Health check (always open) |
| POST | `/api/room/:roomId/join` | Join a room (created on first use) |
| POST | `/api/room/:roomId/publish` | Report playback state |
| POST | `/api/room/:roomId/mode` | Switch the control mode |
| POST | `/api/room/:roomId/poll` | Long-poll a room snapshot (doubles as heartbeat) |
| POST | `/api/room/:roomId/leave` | Leave the room |
| GET | `/api/room/:roomId` | One-shot room snapshot (for debugging) |
| GET | `/api/rooms` | List all rooms |
| GET | `/api/room/:roomId/events` | Web SSE stream |

## `GET /api/health`

Health check for container liveness probes; always open, no key required.

```json
{ "ok": true, "version": "0.5.0", "rooms": 3, "uptimeMs": 123456, "serverTime": 1790855694972 }
```

- `version` comes from `package.json` and matches the server version.
- `rooms` is **only returned when `SERVER_KEY` is not set**; with a key configured the response carries only `ok` / `version` / `uptimeMs` / `serverTime` (see [Overview and Authentication](protocol-overview.md#authentication-the-server-key)).

## `POST /api/room/:roomId/join`

Joins a room, creating it if it does not exist. Idempotent — on reconnect simply call it again.

**Request**

| Field | Type | Description |
| --- | --- | --- |
| `clientId` | string? | A previously issued client ID; passing it reuses the existing membership |
| `name` | string? | Nickname, at most 32 characters |
| `role` | `"host" \| "guest" \| "auto"` | Defaults to `auto` |
| `key` | string? | Room key. If the room has no key yet, the first joiner who supplies one sets it |
| `hostToken` | string? | A previously issued host token |
| `controlMode` | `"host" \| "all"`? | Desired control mode. **Only honored while the room is being created**; change it later via `/mode` |
| `roomName` | string? | Display name of the room (applied on first creation only) |

Semantics of `role`:

- `auto` — become host if the seat is vacant, otherwise a listener;
- `host` — insist on becoming host, displacing the incumbent;
- `guest` — listener only, unless a valid token proves you are already the host.

**Response**

```json
{
  "ok": true,
  "roomId": "demo",
  "clientId": "a7b6265283128bf2",
  "role": "host",
  "isHost": true,
  "hostToken": "4616eecdde6ceaa16b8b77011cc3a738",
  "serverTime": 1790855694972,
  "room": { "...RoomSnapshot" }
}
```

`hostToken` appears **only when this request made you the host**; the plugin should persist it.

**Errors**: `403 BAD_ROOM_KEY` (wrong room key), `409 ROOM_FULL` (room is full; 32 members by default).

## `POST /api/room/:roomId/publish`

Reports playback state. **In "host only" mode only the host is accepted**; in `all` mode every report is accepted and the reporter becomes the driver. Rejections return `accepted: false` instead of an error so the plugin can tell "not entitled" apart from "network is down".

**Request**

```json
{
  "clientId": "a7b6265283128bf2",
  "hostToken": "4616eecd…",
  "playback": {
    "track": { "...SPlayer Track" },
    "playing": true,
    "position": 63000,
    "seq": 9,
    "clientTime": 1790855700000
  }
}
```

`track` is the SPlayer Track object passed through as-is — the server **never trims it**, because listeners hand the entire object to the local MCP `play_track` tool, and a missing field can prevent playback (see [Playing a Track via MCP](plugin-mcp.md)). `track: null` means the host is not playing anything.

`seq` is a monotonically increasing sequence number owned by the reporter. The server compares it **only against the previous snapshot from the same reporter**: a `seq` that is not greater is dropped as a late duplicate, preventing progress from jumping backwards.

**Response**

```json
{ "ok": true, "accepted": true, "version": 13, "serverTime": 1790855700047 }
```

When rejected:

```json
{ "ok": true, "accepted": false, "reason": "host-only", "version": 13, "serverTime": 1790855700047 }
```

Values of `reason`:

| Value | Meaning |
| --- | --- |
| `host-only` | The room is in "host only" mode and you are not the host |
| `stale-seq` | The sequence number is not greater than the reporter's previous one — a late duplicate snapshot |

An accepted report sets `driverClientId` to the reporter.

**Errors**: `409 NOT_JOINED` (the `clientId` is not a room member — call `/join` first).

> The `PublishResponse.reason` type in `types.ts` also declares `"not-joined"`, but the actual implementation returns a `409 NOT_JOINED` error for that case; it never appears as a `reason`.

## `POST /api/room/:roomId/mode`

Switches the room's control mode. **Only the host may change it** (a valid host token works too); anyone else gets `accepted: false`.

**Request**

```json
{ "clientId": "a7b6265283128bf2", "hostToken": "4616eecd…", "mode": "all" }
```

**Response**

```json
{ "ok": true, "accepted": true, "mode": "all", "version": 14, "serverTime": 1790855700047 }
```

When rejected: `accepted: false` with `reason: "host-only"`.

When switching back from `all` to `host` while the current driver is not the host, the server **revokes the driver seat** (clears `driverClientId`) — the host's next heartbeat takes over naturally. What is already playing is kept, not cleared, so nobody's view suddenly goes blank.

## `POST /api/room/:roomId/poll`

Fetches the room snapshot; if the version is unchanged, the request is held for up to `wait` milliseconds. This also serves as the heartbeat — a member that sends nothing for `MEMBER_TTL_MS` is considered offline.

**Request**

| Field | Type | Description |
| --- | --- | --- |
| `clientId` | string | Required |
| `name` | string? | Updates the nickname along the way |
| `since` | number? | The caller's known version; the server responds immediately once the current version exceeds it |
| `wait` | number? | Maximum time to wait, clamped to `[0, 30000]`; `0` returns immediately |

**Response**

```json
{ "ok": true, "changed": true, "serverTime": 1790855700047, "room": { "...RoomSnapshot" } }
```

`changed: false` means the wait timed out with nothing new — a normal outcome, not an error.

> If the member behind `clientId` was already pruned for inactivity, the server **re-admits them on the spot as a new listener** instead of failing. The plugin's polling loop therefore never has to handle a "session expired" failure.

**Errors**: `404 ROOM_NOT_FOUND` (the room was reclaimed; the plugin simply joins again).

## `POST /api/room/:roomId/leave`

Leaves the room.

```json
{ "clientId": "a7b6265283128bf2" }
```

The response is `{ "ok": true }`. When the host leaves, the host seat is released.

## `GET /api/room/:roomId`

One-shot snapshot: `{ ok: true, room: RoomSnapshot }`. Intended for debugging.

## `GET /api/rooms`

Lists every room on this server. Each row carries just enough for a list page — never a full Track:

```json
{
  "ok": true,
  "rooms": [
    {
      "roomId": "demo",
      "name": "demo",
      "members": 4,
      "hostClientId": "a7b6265283128bf2",
      "controlMode": "host",
      "playing": true,
      "nowPlaying": { "title": "…", "artists": ["…"], "source": "netease", "cover": "…" },
      "updatedAt": 1790855700047
    }
  ]
}
```

- `nowPlaying` is a summary of the current track (title, artists, source, cover); it is `null` when nobody is playing;
- `updatedAt` is the time of the last report, or `null` when nobody is playing.

## `GET /api/room/:roomId/events` (web SSE stream)

The **SSE** stream used by the web room page. Browsers only — the plugin never uses it.

- The response starts with a `retry: 3000` line, so the browser reconnects after 3 seconds when the stream drops;
- The first frame is `data: {"type":"snapshot","room":{...RoomSnapshot}}`, and every subsequent change pushes `data: {"type":"update","room":{...}}`;
- A comment line `: ping` is sent every 20 seconds to keep the connection alive;
- When `SERVER_KEY` is set, the key must be supplied as `?key=<key>` (`EventSource` cannot set request headers); otherwise the server responds with `401 SERVER_KEY_REQUIRED`.
