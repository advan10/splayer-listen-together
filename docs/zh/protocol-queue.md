# 房间共享队列接口

队列放在**服务端**，这样大家的「下一首」才是同一份。队列内容**不进房间快照**（可能很长）：快照里只带 `queueVersion` 和 `queueLength`，客户端发现版本变了再来拉这一条。

队列项的结构是 `QueueEntry`（定义见 [`server/src/types.ts`](../../server/src/types.ts)）：

```json
{
  "id": "a3f19c",
  "track": { "...SPlayer Track" },
  "addedBy": "a7b6265283128bf2",
  "addedAt": 1790874599000,
  "insertNext": false
}
```

`track` 是整条 SPlayer Track 原样保存；`insertNext` 表示入队时是否要求「紧接着放」。

## `GET /api/room/:roomId/queue`

取整条队列。

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

**错误**：`404 ROOM_NOT_FOUND`（房间不存在）。

## `POST /api/room/:roomId/queue`

改队列。三种动作共用这一个入口：

| 动作 | 字段 | 权限 |
| --- | --- | --- |
| `add` | `tracks`（一次最多 50 条）、`position?`（`next` / `end`，默认 `end`） | **谁都可以** —— 队列是张点歌单 |
| `remove` | `entryId` | 需要控制权 |
| `clear` | — | 需要控制权 |

### 控制权判定

「需要控制权」与 `/publish`、`/mode` 是同一套规则，判据有三个，满足其一即可：

- `controlMode` 是 `all`；
- 或者是房主本人；
- **或者 body 里带了有效的 `hostToken`** —— 服务端重启过、或者房主位被别人顶掉之后，靠它把自己的房主身份认回来（令牌是首次当上房主时下发的，插件存在本地）。

判定不通过返回 `403 NOT_ALLOWED`。

`hostToken` 三个动作都接受，且**都是可选的**：`add` 本来就不看权限，带不带都行。

三种动作都要求 `clientId` 已经是房间成员，否则返回 `409 NOT_JOINED`。

### 请求示例

普通加歌：

```json
{ "clientId": "a7b6265283128bf2", "action": "add", "tracks": [ /* Track */ ] }
```

带令牌删队列（房主用这个）：

```json
{
  "clientId": "a7b6265283128bf2",
  "hostToken": "4616eecd…",
  "action": "remove",
  "entryId": "a3f19c"
}
```

### 响应

每次都把整条队列带回来，省一次往返：

```json
{ "ok": true, "changed": 1, "queueVersion": 8, "queue": [ /* QueueEntry[] */ ], "serverTime": 1790874599421 }
```

`changed` 是这次实际影响了几项。加歌时按 `source:id` 判断「同一首歌」：队列里已有的、以及**同一次请求里重复出现的**都会被跳过；一条都没加上时 `changed` 为 `0`。

队列长度上限 200，超出从队尾丢（保住在眼前的那些）。

**错误**：`400 BAD_REQUEST`（`tracks` 为空、`entryId` 缺失、`action` 不是 add/remove/clear）、`403 NOT_ALLOWED`（无控制权却 remove/clear）、`404 ROOM_NOT_FOUND`、`409 NOT_JOINED`。
