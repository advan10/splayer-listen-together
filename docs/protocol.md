# 一起听 · HTTP 协议

服务端与插件之间的全部接口。所有请求和响应都是 JSON。

- 基础路径：`http://<host>:<port>/api`
- 时间单位：**毫秒**
- 时间戳：Unix 毫秒（`Date.now()`）
- 字段命名：小驼峰
- 鉴权：见下

线上格式的权威类型定义在 [`server/src/types.ts`](../server/src/types.ts)；
插件是纯 JS、无法 import，里面有一份等价的手写定义。

---

## 鉴权：服务端密钥

服务端设了 `SERVER_KEY` 环境变量之后，**除 `/api/health` 外的所有接口**
都必须带上这个密钥，否则返回 `401 SERVER_KEY_REQUIRED`。

两种带法：

| 方式 | 场景 |
| --- | --- |
| 请求头 `X-Server-Key: <密钥>` | 插件走这条 |
| 查询参数 `?key=<密钥>` | 浏览器房间页走这条 —— EventSource 设不了请求头 |

比较用恒定时间实现（`timingSafeEqual`），避免从响应耗时反推密钥。

`/api/health` 是例外，始终开放：它是给容器探活用的。
但设了密钥之后它只返回 `version` / `uptimeMs` / `serverTime`，不再返回房间数量。

> 别把这个当成强鉴权：密钥是**共享密钥**，拿到它的任何人都能建房间、进房间。
> 它拦的是「没拿到密钥的陌生人」，不是「拿到密钥的坏人」。
> 另外 `clientId` 与 `hostToken` 都不是凭据签发的 —— 拿到密钥的人可以冒用别人的
> `clientId`。给朋友之间用足够了，别拿它当多租户隔离。

---

## 角色模型

每个客户端连进一个**房间**。房间有两个独立的身份概念，别混在一起：

| 概念 | 含义 |
| --- | --- |
| **房主 host** | 房间的主人。决定房间的控制模式，也是「只有房主可调」模式下唯一能上报的人 |
| **控制者 driver** | 当前唯一有权决定播放状态的人 —— 最后一个被服务端接受的上报者 |

房主身份靠 **房主令牌**维持：第一次当上房主时服务端下发一个随机令牌，
插件把它存进 `splayer.storage`，之后重连、重启应用都带着它，
就能一直保住房主位。令牌服务端只存 SHA-256。

房主位在以下情况会被释放：

- 房主主动退出（`/leave`）；
- 房主超过 `MEMBER_TTL_MS`（默认 60s）没有任何请求；
- 有人用 `role: "host"` 显式加入（顶掉现任）。

控制者位同理：控制者退出或被判定离线时释放。释放之后，
「大家都可以调」模式下任何有歌在手的人都能上报并接手。

---

## 控制模式

房间有一个 `controlMode`，决定**谁能决定听什么**：

| 值 | 含义 |
| --- | --- |
| `host`（默认） | 只有房主的上报会被接受，其他人上报一律回 `accepted: false` |
| `all` | 谁的上报都会被接受，上报者随即成为新的控制者 |

模式在**房间创建时**由第一个加入者的 `controlMode` 决定，之后只能经
[`/mode`](#post-apiroomroomidmode) 修改，且**只有房主能改**。

「大家都可以调」为什么不会互相抢：任何时刻服务端只认一个控制者
（`driverClientId`），上一份快照的来源一旦不是当前控制者就会被覆盖。
客户端侧则要自己抑制回声——跟随别人产生的本地变化不能再报回去，
否则两个人会无限互顶。插件用一段「抑制期」实现这点。

---

## 长轮询

插件沙箱里**没有 WebSocket**，只有 `splayer.request` 的普通 HTTP。
所以实时性靠长轮询：`/poll` 在版本号没变化时挂住不返回，最多等 `wait` 毫秒。

```
听众                                    服务端
  │  POST /poll { since: 12, wait: 25000 }  │
  │ ──────────────────────────────────────► │  挂起…
  │                                         │
  │                         房主 POST /publish（版本 12 → 13）
  │                                         │
  │  ◄────────────────────────────────────── │  立刻返回 { changed: true, room: {...} }
```

- 客户端 `splayer.request` 的 `timeout` **必须大于**请求里的 `wait`，否则会自己先超时。
  插件用的是 `wait: 25000` / `timeout: 28000`。
- 服务端把 `wait` 夹取到 `[0, 30000]`。
- 版本号 `room.version` 在播放状态变化**或成员增减**时都会 +1。

---

## 时钟与进度推算

进度不能靠「房主说到 60000ms 了」直接照搬——这条消息在路上还要走一会儿。
所以每次发布都带上服务端接收时刻 `publishedAt`，接收方按自己的时钟推算：

```
offset   = serverTime - (客户端发送前时刻 + 往返/2)      // 每次请求都更新（低通滤波）
serverNow = Date.now() + offset
target    = playback.position + (playback.playing ? serverNow - playback.publishedAt : 0)
```

`target` 与本地进度的差值超过阈值时才 `seek`，避免频繁跳转。

---

## 接口

### `GET /api/health`

```json
{ "ok": true, "version": "0.1.0", "rooms": 3, "uptimeMs": 123456, "serverTime": 1790855694972 }
```

### `POST /api/room/:roomId/join`

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

### `POST /api/room/:roomId/publish`

上报播放状态。**在「只有房主可调」模式下只有房主会被接受**；
`all` 模式下谁都会被接受，上报者随即成为控制者。
不被接受时返回 `accepted: false` 而不是报错，方便插件区分「没资格」和「网络挂了」。

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

`track` 直接放 SPlayer 的 Track 对象，服务端**原样透传**不做裁剪——
听众端要把它整条交给 MCP 的 `play_track`，少一个字段都可能播不出来。
`track: null` 表示房主没在播放。

`seq` 是发布方自增的序号。服务端丢弃 `seq` 不大于上一条的迟到快照，
避免进度回跳。

**响应**

```json
{ "ok": true, "accepted": true, "version": 13, "serverTime": 1790855700047 }
```

被拒时：

```json
{ "ok": true, "accepted": false, "reason": "host-only", "version": 13, "serverTime": … }
```

`reason` 取值：

| 值 | 含义 |
| --- | --- |
| `host-only` | 房间是「只有房主可调」模式，而你不是房主 |
| `stale-seq` | 序号不大于上一条，是迟到的重复快照 |

被接受的上报会把 `driverClientId` 设成上报者。

### `POST /api/room/:roomId/mode`

切换房间的控制模式。**只有房主能改**，其他人返回 `accepted: false`。

**请求**

```json
{ "clientId": "a7b6265283128bf2", "hostToken": "4616eecd…", "mode": "all" }
```

**响应**

```json
{ "ok": true, "accepted": true, "mode": "all", "version": 14, "serverTime": … }
```

被拒时 `accepted: false`，`reason: "host-only"`。

从 `all` 切回 `host` 时，如果当前控制者不是房主，服务端会**收回控制者位**
（`driverClientId` 置空）——房主下一次心跳自然接管。已播放的内容保留，不清空，
免得大家的画面突然变空白。

### `GET /api/room/:roomId/queue`

取整条队列。队列内容**不进快照**（可能很长），快照里只给 `queueVersion` 和
`queueLength`，客户端发现版本变了再来拉这一条。

```json
{
  "ok": true,
  "queueVersion": 7,
  "queue": [
    {
      "id": "a3f19c",
      "track": { "...SPlayer Track" },
      "addedBy": "a7b6265283128bf2",
      "addedAt": 1790874599000,
      "insertNext": false
    }
  ],
  "serverTime": 1790874599421
}
```

### `POST /api/room/:roomId/queue`

改队列。三种动作共用这一个入口。

| 动作 | 字段 | 权限 |
| --- | --- | --- |
| `add` | `tracks`（最多 50 条）、`position?`（`next` / `end`，默认 `end`） | **谁都可以** —— 队列是张点歌单 |
| `remove` | `entryId` | 需要控制权 |
| `clear` | — | 需要控制权 |

「需要控制权」与 `/publish` 同一套规则：`host` 模式下只有房主（或持有有效房主令牌的人），
`all` 模式下谁都可以。没资格时返回 `403 NOT_ALLOWED`。

```json
{ "clientId": "a7b6265283128bf2", "action": "add", "tracks": [ /* Track */ ] }
```

**响应**每次都把整条队列带回来，省一次往返：

```json
{ "ok": true, "changed": 1, "queueVersion": 8, "queue": [ /* QueueEntry[] */ ], "serverTime": … }
```

`changed` 是这次实际影响了几项。加歌时如果队列里已经有同一首歌（按 `source:id` 判断），
会被跳过，此时 `changed` 为 `0`。

队列长度上限 200，超出从队尾丢（保住在眼前的那些）。

### `POST /api/room/:roomId/poll`

拉取房间快照；版本没变化就挂起最多 `wait` 毫秒。
同时充当心跳——房主超过 `MEMBER_TTL_MS` 不发请求就会被判离线。

**请求**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clientId` | string | 必填 |
| `name` | string? | 顺带更新昵称 |
| `since` | number? | 已知版本号 |
| `wait` | number? | 等待上限，夹取到 `[0, 30000]`，`0` 表示立即返回 |

**响应**

```json
{ "ok": true, "changed": true, "serverTime": 1790855700047, "room": { "...RoomSnapshot" } }
```

`changed: false` 表示等超时了、没有新内容——这是正常情况，不是错误。

> 如果 `clientId` 对应的成员已经因为超时被清掉，服务端会**就地把它当新听众加回来**，
> 而不是报错。插件的长轮询循环因此不需要处理「会话失效」这一种失败。

**错误**：`404 ROOM_NOT_FOUND`（房间被回收了，插件会重新 join）。

### `POST /api/room/:roomId/leave`

```json
{ "clientId": "a7b6265283128bf2" }
```

退出房间。房主退出会释放房主位。

### `GET /api/room/:roomId`

一次性快照，`{ ok: true, room: RoomSnapshot }`。调试用。

### `GET /api/rooms`

列出所有房间：`{ ok: true, rooms: [{ roomId, name, members, host, version }] }`。

### `GET /api/room/:roomId/events`

网页房间页用的 **SSE** 流，每帧是 `data: {"type":"snapshot"|"update","room":{...}}`，
每 20 秒发一次注释行 `: ping` 保活。仅给浏览器用，插件不用这个。

---

## RoomSnapshot

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

`PluginTrack` 见 [`server/src/types.ts`](../server/src/types.ts)——
它是 SPlayer Track 的宽松子集，未列出的字段原样透传。

---

## 错误响应

```json
{ "ok": false, "error": "房间口令不正确", "code": "BAD_ROOM_KEY" }
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` / `BAD_JSON` / `BAD_ROOM_ID` | 参数问题 |
| 401 | `SERVER_KEY_REQUIRED` | 服务端密钥缺失或不正确 |
| 403 | `BAD_ROOM_KEY` | 房间口令不对 |
| 404 | `ROOM_NOT_FOUND` / `NOT_FOUND` | 房间或接口不存在 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不对 |
| 409 | `ROOM_FULL` / `NOT_JOINED` | 人满 / 没加入就发布 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超过 256KB |
| 500 | `INTERNAL` | 服务端内部错误 |
