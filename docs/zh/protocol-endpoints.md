# 接口参考

除特别注明外，接口均为 `POST`，请求与响应均为 JSON。鉴权规则见[概览与鉴权](protocol-overview.md)；队列接口单独成篇，见[房间共享队列](protocol-queue.md)；数据结构见[数据结构与错误码](protocol-types.md)。

## 接口一览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查（始终开放） |
| POST | `/api/room/:roomId/join` | 加入房间（不存在则创建） |
| POST | `/api/room/:roomId/publish` | 上报播放状态 |
| POST | `/api/room/:roomId/mode` | 切换控制模式 |
| POST | `/api/room/:roomId/poll` | 长轮询拉取快照（兼作心跳） |
| POST | `/api/room/:roomId/leave` | 退出房间 |
| GET | `/api/room/:roomId` | 一次性房间快照（调试用） |
| GET | `/api/rooms` | 列出所有房间 |
| GET | `/api/room/:roomId/events` | 网页端 SSE 流 |

## `GET /api/health`

健康检查，供容器探活使用，始终开放、无需密钥。

```json
{ "ok": true, "version": "0.5.0", "rooms": 3, "uptimeMs": 123456, "serverTime": 1790855694972 }
```

- `version` 取自 `package.json`，与服务端版本一致。
- `rooms` 字段**只在未设置 `SERVER_KEY` 时返回**；设置了密钥之后只返回 `ok` / `version` / `uptimeMs` / `serverTime`（见[概览与鉴权](protocol-overview.md#鉴权服务端密钥)）。

## `POST /api/room/:roomId/join`

加入房间；房间不存在则创建。幂等，重连直接再调一次。

**请求**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clientId` | string? | 上次拿到的客户端 ID，传了就复用（保持成员身份） |
| `name` | string? | 昵称，最长 32 字符 |
| `role` | `"host" \| "guest" \| "auto"` | 默认 `auto` |
| `key` | string? | 房间口令。房间还没设口令时，第一个带口令进来的人就是设定者 |
| `hostToken` | string? | 上次拿到的房主令牌 |
| `controlMode` | `"host" \| "all"`? | 期望的控制模式。**只在房间刚被创建时生效**，之后用 `/mode` 改 |
| `roomName` | string? | 房间展示名（仅首次创建时生效） |

`role` 的语义：

- `auto` —— 房主位空着就当房主，否则当听众；
- `host` —— 一定要当房主，顶掉现任；
- `guest` —— 只当听众，除非令牌证明你本来就是房主。

**响应**

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

`hostToken` **只在本次新当上房主时**才出现，插件应存起来。

**错误**：`403 BAD_ROOM_KEY`（口令不对）、`409 ROOM_FULL`（人满，默认上限 32）。

## `POST /api/room/:roomId/publish`

上报播放状态。**在「只有房主可调」模式下只有房主会被接受**；`all` 模式下谁都会被接受，上报者随即成为控制者。不被接受时返回 `accepted: false` 而不是报错，方便插件区分「没资格」和「网络挂了」。

**请求**

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

`track` 直接放 SPlayer 的 Track 对象，服务端**原样透传**不做裁剪 —— 听众端要把它整条交给 MCP 的 `play_track`，少一个字段都可能播不出来（见[经 MCP 点名播歌](plugin-mcp.md)）。`track: null` 表示房主没在播放。

`seq` 是发布方自增的序号。服务端只与**同一发布方**的上一条快照比较序号：`seq` 不大于它时按迟到快照丢弃，避免进度回跳。

**响应**

```json
{ "ok": true, "accepted": true, "version": 13, "serverTime": 1790855700047 }
```

被拒时：

```json
{ "ok": true, "accepted": false, "reason": "host-only", "version": 13, "serverTime": 1790855700047 }
```

`reason` 取值：

| 值 | 含义 |
| --- | --- |
| `host-only` | 房间是「只有房主可调」模式，而你不是房主 |
| `stale-seq` | 序号不大于同一发布方的上一条，是迟到的重复快照 |

被接受的上报会把 `driverClientId` 设成上报者。

**错误**：`409 NOT_JOINED`（`clientId` 不在房间成员里 —— 先 `/join` 再上报）。

> `types.ts` 里 `PublishResponse.reason` 的类型声明还包含 `"not-joined"`，但实际实现中「未加入房间」以上面的 `409 NOT_JOINED` 错误返回，不会作为 `reason` 出现。

## `POST /api/room/:roomId/mode`

切换房间的控制模式。**只有房主能改**（持有有效房主令牌亦可），其他人返回 `accepted: false`。

**请求**

```json
{ "clientId": "a7b6265283128bf2", "hostToken": "4616eecd…", "mode": "all" }
```

**响应**

```json
{ "ok": true, "accepted": true, "mode": "all", "version": 14, "serverTime": 1790855700047 }
```

被拒时 `accepted: false`，`reason: "host-only"`。

从 `all` 切回 `host` 时，如果当前控制者不是房主，服务端会**收回控制者位**（`driverClientId` 置空）—— 房主下一次心跳自然接管。已播放的内容保留，不清空，免得大家的画面突然变空白。

## `POST /api/room/:roomId/poll`

拉取房间快照；版本没变化就挂起最多 `wait` 毫秒。同时充当心跳 —— 成员超过 `MEMBER_TTL_MS` 不发请求就会被判离线。

**请求**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clientId` | string | 必填 |
| `name` | string? | 顺带更新昵称 |
| `since` | number? | 已知版本号，服务端在当前版本超过它时立刻返回 |
| `wait` | number? | 等待上限，夹取到 `[0, 30000]`，`0` 表示立即返回 |

**响应**

```json
{ "ok": true, "changed": true, "serverTime": 1790855700047, "room": { "...RoomSnapshot" } }
```

`changed: false` 表示等超时了、没有新内容 —— 这是正常情况，不是错误。

> 如果 `clientId` 对应的成员已经因为超时被清掉，服务端会**就地把它当新听众加回来**，而不是报错。插件的长轮询循环因此不需要处理「会话失效」这一种失败。

**错误**：`404 ROOM_NOT_FOUND`（房间被回收了，插件会重新 join）。

## `POST /api/room/:roomId/leave`

退出房间。

```json
{ "clientId": "a7b6265283128bf2" }
```

响应为 `{ "ok": true }`。房主退出会释放房主位。

## `GET /api/room/:roomId`

一次性快照，`{ ok: true, room: RoomSnapshot }`。调试用。

## `GET /api/rooms`

列出这台服务端上的所有房间。每行只带首页展示够用的信息，不含完整 Track：

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

- `nowPlaying` 是当前曲目的摘要（标题、歌手、音源、封面），没人在播时为 `null`；
- `updatedAt` 是最后一次上报的时刻，没人在播时为 `null`。

## `GET /api/room/:roomId/events`（网页端 SSE 流）

网页房间页用的 **SSE** 流，仅给浏览器用，插件不用这个。

- 响应开头先发一行 `retry: 3000`，断线后浏览器会在 3 秒后自动重连；
- 首帧是 `data: {"type":"snapshot","room":{...RoomSnapshot}}`，此后每次变化推一帧 `data: {"type":"update","room":{...}}`；
- 每 20 秒发一次注释行 `: ping` 保活；
- 设置了 `SERVER_KEY` 时必须用 `?key=<密钥>` 携带密钥（`EventSource` 设不了请求头），否则返回 `401 SERVER_KEY_REQUIRED`。
