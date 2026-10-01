# Shared Room Queue Endpoints

The queue lives **on the server** so that everyone agrees on "what's next". Queue contents are **not part of the room snapshot** (they can be long): the snapshot only carries `queueVersion` and `queueLength`, and clients fetch the full list from this endpoint when the version changes.

A queue item is a `QueueEntry` (defined in [`server/src/types.ts`](../../server/src/types.ts)):

```json
{
  "id": "a3f19c",
  "track": { "...SPlayer Track" },
  "addedBy": "a7b6265283128bf2",
  "addedAt": 1790874599000,
  "insertNext": false
}
```

`track` is the complete SPlayer Track kept verbatim; `insertNext` records whether the item was requested to play "right after the current track".

## `GET /api/room/:roomId/queue`

Fetches the entire queue.

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

**Errors**: `404 ROOM_NOT_FOUND` (no such room).

## `POST /api/room/:roomId/queue`

Modifies the queue. Three actions share this one endpoint:

| Action | Fields | Permission |
| --- | --- | --- |
| `add` | `tracks` (at most 50 per request), `position?` (`next` / `end`, default `end`) | **Anyone** — the queue is a request list |
| `remove` | `entryId` | Requires control |
| `clear` | — | Requires control |

### Control check

"Requires control" follows the same rules as `/publish` and `/mode`. Any one of the following qualifies:

- `controlMode` is `all`;
- the caller is the host;
- **the request body carries a valid `hostToken`** — after a server restart, or after the host seat was taken over, this is how the host re-establishes their identity (the token was issued when they first became host and is stored locally by the plugin).

If the check fails, the server returns `403 NOT_ALLOWED`.

`hostToken` is accepted on all three actions and is **always optional**: `add` never checks permissions in the first place.

All three actions require `clientId` to be a room member; otherwise the server returns `409 NOT_JOINED`.

### Request examples

Adding songs:

```json
{ "clientId": "a7b6265283128bf2", "action": "add", "tracks": [ /* Track */ ] }
```

Removing with a token (what the host uses):

```json
{
  "clientId": "a7b6265283128bf2",
  "hostToken": "4616eecd…",
  "action": "remove",
  "entryId": "a3f19c"
}
```

### Response

Every response carries the entire queue back, saving a round trip:

```json
{ "ok": true, "changed": 1, "queueVersion": 8, "queue": [ /* QueueEntry[] */ ], "serverTime": 1790874599421 }
```

`changed` is the number of entries actually affected. On `add`, "same song" is determined by `source:id`: songs already in the queue — **and duplicates within the same request** — are skipped. If nothing was added, `changed` is `0`.

The queue holds at most 200 entries; once exceeded, entries are dropped from the tail (the ones coming up soonest are kept).

**Errors**: `400 BAD_REQUEST` (empty `tracks`, missing `entryId`, or an `action` other than add/remove/clear), `403 NOT_ALLOWED` (remove/clear without control), `404 ROOM_NOT_FOUND`, `409 NOT_JOINED`.
