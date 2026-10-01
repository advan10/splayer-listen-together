# Core Concepts: Roles, Control Modes, and Sync Mechanics

## Rooms and members

Every client joins a **room**. Room state lives entirely in server memory: listen-together is a real-time "who is listening to what right now" service, so a process restart disperses all rooms; empty rooms are reclaimed after sitting idle longer than `ROOM_TTL_MS` (12 hours by default). A room holds at most 32 members.

A room carries two independent notions of identity — do not conflate them:

| Concept | Meaning |
| --- | --- |
| **Host** | The room's owner. Decides the room's control mode, and is the only one allowed to report in "host only" mode |
| **Driver** | The one client currently entitled to decide the playback state — the last reporter the server accepted |

### The host token

Host identity is maintained through a **host token** (`hostToken`): the first time a client becomes host, the server issues a random token. The plugin stores it in `splayer.storage` and presents it on every reconnect and app restart, which lets it keep the host seat. The server only stores the SHA-256 of the token.

The host seat is released when:

- the host leaves explicitly (`/leave`);
- the host sends no request for longer than `MEMBER_TTL_MS` (60 seconds by default);
- someone joins explicitly with `role: "host"` (displacing the incumbent).

The driver seat works the same way: it is released when the driver leaves or is judged offline. Once released, in "everyone controls" mode any joined member may report and take over.

## Control modes

A room has a `controlMode` that decides **who gets to choose what to play**:

| Value | Meaning |
| --- | --- |
| `host` (default) | Only the host's reports are accepted; everyone else gets `accepted: false` |
| `all` | Everyone's reports are accepted; the reporter immediately becomes the new driver |

The mode is fixed **at room creation** from the first joiner's `controlMode`, and afterwards can only be changed via `/mode`, which **only the host may call** (see the [Endpoint Reference](protocol-endpoints.md#post-apiroomroomidmode)).

Why "everyone controls" doesn't devolve into a tug-of-war: at any moment the server recognizes exactly one driver (`driverClientId`), and an incoming snapshot whose source is not the current driver simply overwrites the seat. On the client side, echo suppression is the plugin's own responsibility — local changes that merely *follow* someone else must not be reported back, or two clients will fight forever. The plugin implements this with a suppression window.

## Long polling

The plugin sandbox has **no WebSocket** — only plain HTTP via `splayer.request` (see [Plugin Types and the Sandbox](plugin-overview.md) for why). Real-time behavior therefore relies on long polling: `/poll` holds the request open without responding while the version number is unchanged, for at most `wait` milliseconds.

```
Listener                                 Server
  │  POST /poll { since: 12, wait: 25000 }  │
  │ ──────────────────────────────────────► │  holds the request…
  │                                         │
  │                    host POSTs /publish (version 12 → 13)
  │                                         │
  │  ◄────────────────────────────────────── │  returns at once { changed: true, room: {...} }
```

- The client's `splayer.request` `timeout` **must be greater than** the `wait` in the request body, or the client will time out first. The plugin uses `wait: 25000` / `timeout: 28000`.
- The server clamps `wait` to `[0, 30000]`.
- `room.version` increments on any change to playback state, membership, control mode, or the queue — so `/poll` waiters are woken promptly by any of them.

## Clock and progress estimation

Progress cannot be applied verbatim from "the host says we're at 60000 ms" — the message still spends time in transit. Every publish therefore carries `publishedAt`, the moment the server received it, and receivers project progress on their own clocks:

```
offset    = serverTime - (time the client sent the request + RTT/2)   // updated on every request (low-pass filter)
serverNow = Date.now() + offset
target    = playback.position + (playback.playing ? serverNow - playback.publishedAt : 0)
```

`seek` only happens when the gap between `target` and the local position exceeds a threshold (the plugin's "seek alignment threshold" setting, 2000 ms by default), which avoids constant jumping.
