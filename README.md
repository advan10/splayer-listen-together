# Listen Together (一起听)

[![CI](https://github.com/fishpond-studio/splayer-listen-together/actions/workflows/ci.yml/badge.svg)](https://github.com/fishpond-studio/splayer-listen-together/actions/workflows/ci.yml)

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

Listen together on separate computers: a **SPlayer-Next control plugin plus a self-hosted sync server** keep several people on the same song.

- Whoever is playing reports the track, play state, and position to the server; everyone else subscribes and aligns automatically.
- Rooms have **two control modes**: `Host only` (default — whatever the host plays is what everyone hears) and `Everyone controls` (anyone can change the song and the others follow — the last person to act decides).
- **Shared room queue**: anyone can add songs; removing requires control. Everyone has the same answer to "what's next".
- With MCP enabled, track switches and the queue sync to the local player automatically.
- A web dashboard shows at a glance who is listening to what.

Targets **NCM** by default (NetEase Cloud Music; SPlayer's `netease` source).

```
┌────────────────┐  report playback   ┌──────────────┐  long-poll push  ┌──────────────────┐
│    SPlayer     │ ─────────────────► │    Server    │ ───────────────► │     SPlayer      │
│  host plugin   │                    │ (this repo)  │                  │ listener plugin  │
└────────────────┘                    └──────┬───────┘                  └────────┬─────────┘
                                             │ SSE                               │ local MCP
                                             ▼                                   ▼
                                      web room pages                   play_track (auto-switch)
```

## Contents

- [Read this first: why automatic track switching needs MCP](#read-this-first-why-automatic-track-switching-needs-mcp)
- [Quick start](#quick-start)
- [The two control modes](#the-two-control-modes)
- [Room queue](#room-queue)
- [Web dashboard](#web-dashboard)
- [Server configuration](#server-configuration)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Development](#development)
- [License](#license)

## Read this first: why automatic track switching needs MCP

The **SPlayer-Next control-plugin API has no "play this specific track"** — only
`play` / `pause` / `next` / `prev` / `seek` / `setVolume`.
The external HTTP API and the WebSocket API are the same.

The only local entry point that can name a specific song is SPlayer's built-in **MCP interface**,
whose `play_track` tool accepts a complete Track object. So when the plugin needs to switch songs,
it calls `play_track` over `http://127.0.0.1:<MCP port>/mcp`.

What that means in practice:

| What you want | What it takes |
| --- | --- |
| See what the room is playing, the progress bar, the member list | Nothing extra |
| Pause/resume on one side follows on the others | Nothing extra |
| Progress aligns automatically **when everyone is already on the same song** | Nothing extra |
| **Switching songs pulls the others along** | Enable MCP and fill the port and key into the plugin settings |

Without MCP everything else still works; when the song changes you just start it yourself
(the plugin menu has "Sync now" — 一起听：立即同步).

## Quick start

### 1. Start the server

Requires **Node.js ≥ 22.18** (runs TypeScript directly, no build step).

Copy the config template and fill in your key:

```bash
cp .env.example .env.local
```

Then start:

```bash
pnpm start
```

`.env.local` is not committed; `pnpm start` reads it automatically. To skip the template and pass
configuration on the command line instead:

```bash
SERVER_KEY=change-to-your-own-key node server/src/index.ts
```

`SERVER_KEY` is the **server key**: once set, every endpoint requires it, and the plugin must be
configured with the same value. **Without it, anyone who can reach the port can create rooms.**

When you see this, it is up:

```
  一起听服务端 v0.5.0 已启动
  房间列表  http://127.0.0.1:8788/
  房间页面  http://127.0.0.1:8788/room/<房间ID>
  健康检查  http://127.0.0.1:8788/api/health
  服务端密钥 已开启：插件要填对密钥才能连上
```

(Console messages follow the server's `LOCALE`; the output above is the default `zh_cn`.)

To change the port or lock rooms down, edit `.env.local` (see [Server configuration](#server-configuration)).

> **`SERVER_KEY` and `ROOM_KEY` are two different things**: the former decides "who may use this
> server", the latter "who may enter this room". For a private circle, setting `SERVER_KEY` alone is
> enough; use `ROOM_KEY` when different circles share one server and each room needs its own lock.

### 2. Install the plugin

In SPlayer-Next go to **Settings → Plugin management → Local import** and pick
[`plugin/splayer-listen-together.js`](plugin/splayer-listen-together.js).

The plugin enables itself after installation.

### 3. (Listeners) Enable MCP

Only needed for **automatic track switching**:

1. SPlayer-Next → **Settings → AI integration → MCP** → turn the server on and note the port (default `14559`);
2. Open "configuration details" and copy the `X-MCP-Key` value;
3. Back in the plugin settings, turn on "Allow automatic track switching via MCP" and fill in the port and key.

### 4. Configure the plugin

In the plugin card's "Settings":

| Setting | Description |
| --- | --- |
| Enable Listen Together | Master switch for the plugin (on by default) |
| Server address | Root URL of the server. On the same LAN, use `http://<server LAN IP>:8788` |
| Server key | Required when the server sets `SERVER_KEY` — same value; leave empty otherwise |
| Room ID | Everyone with the same ID shares a room; letters/digits/`_`/`-`, 1–64 characters |
| Room key | Optional. Whoever fills it first sets it; everyone else must match |
| Nickname | Shown in the member list; left empty, one is generated |
| Role | `Auto` (default — becomes host if nobody has) / `Host` / `Listener` |
| Control mode | `Host only` (default) / `Everyone controls`, see the next section |
| Follow track switches | Switch songs along with the room (requires MCP) |
| Sync play/pause | Follow the current play state |
| Local pause stays local | Pausing stops only your player; resuming catches up to the room's position |
| Sync playback position | Seeks only when the drift exceeds the threshold |
| Sync room queue | Push new songs from the room queue into the local playlist so "next" matches (requires MCP) |
| Seek alignment threshold | Default 2000 ms. Smaller = tighter sync but more frequent seeking |
| Report interval | Default 5 s; the fallback progress refresh when no lyric events arrive |
| Verbose logging | More detailed debug output in the logs (off by default) |

### 5. Start listening together

The host just plays music as usual. Everyone else fills in the same "Room ID" and the same key,
and they are in.

The plugin menu (song context menu / the plugin submenu under the bottom bar's "More") offers:

- **一起听：状态** ("Listen Together: status") — my role, the room's mode, member count, queue length, what is playing, and whether I am in control
- **一起听：立即同步** ("Sync now") — report my current state once / catch up immediately
- **一起听：把这首歌加入房间队列** ("Add this song to the room queue") — add the right-clicked song to the shared queue (anyone may)
- **一起听：切换控制模式** ("Switch control mode") — toggle between "Host only" and "Everyone controls" (host only)
- **一起听：我当房主** ("Make me host") — displace the current host
- **一起听：打开房间页面** / **一起听：复制房间链接** ("Open room page" / "Copy room link")

## The two control modes

A room has a "control mode" that decides **who gets to choose what to play**. It is a room property,
fixed by the first joiner's setting at creation time; afterwards the host can switch it any time.

| Mode | Behavior |
| --- | --- |
| **Host only** (default) | Only the host can change the song, pause, or seek. Nothing a listener does locally affects the room — they are here to follow along. |
| **Everyone controls** | Anyone can change the song, pause, or seek, and the others follow automatically. |

"Everyone controls" does not mean everyone plays their own thing — that would have people fighting
over the progress bar and nobody hearing a full song. The rule here is **the last person to act is
in control**:

- Switching a song locally counts as "I'm playing this", and everyone else follows;
- After someone else acts, you automatically yield control, follow quietly, and stop reporting your own state;
- Whoever is in control is marked in the room page (the "in control" badge in the member list).

It is a relay, not a grab for the microphone: at any moment there is exactly one authoritative
playback state, and everyone hears the same one.

Rooms start in "Host only". To switch:

1. Set "Control mode" to "Everyone controls" in the plugin settings (host only, effective immediately);
2. Or use the menu **一起听：切换控制模式** at any time — the host toggles it in one click; listeners get a "only the host can change the control mode" notice.

> A non-host who wants control back should first take the host seat with **一起听：我当房主**, then switch the mode.

## Room queue

The queue lives **on the server** so that everyone's "next" is the same one. With separate local
queues, the end of a song sends each player to a different next track and everything falls apart.

- **Anyone can add songs**: right-click a song → 一起听：把这首歌加入房间队列.
  It is a request list; the host can remove entries that look wrong.
- **Removing/clearing requires control**: in `Host only` mode only the host; in `Everyone controls` mode anyone.
- The web room page shows the queue, with order, covers, and who requested each song.

For the queue to actually affect local playback, enable "Sync room queue" in the plugin settings
and have MCP on — the plugin pushes the queue into the local playlist via MCP's `add_to_queue`.

> **An honest caveat**: SPlayer's control-plugin API has no queue interface, and MCP can only *add*
> — it cannot read or remove from the local queue. So this is **one-way best-effort alignment**,
> not two-way sync — a song removed on the server keeps playing locally until it finishes on its own.
> Songs already queued are not pushed twice (SPlayer deduplicates by track ID itself).

## Web dashboard

Two pages:

| URL | Contents |
| --- | --- |
| `http://<server>:8788/` | **Room list** — which rooms exist on this server and what each is playing |
| `http://<server>:8788/room/<room ID>` | **Room detail** — current track, cover, progress bar, members, who is in control, room queue |

The room detail page uses SSE and reconnects by itself; the room list refreshes every 5 seconds with
currently-playing rooms first. The top bar can switch the page language (Chinese/English).

The footer shows the **server version** (e.g. `一起听服务端 v0.5.0`). It comes from `/api/health`,
which needs no key — so the version is visible even before the key gate is passed (the gate shows it
too), making it easy to confirm a server update took effect. The plugin's own version lives on its
card in SPlayer and follows a separate numbering scheme.

The room page has a **←** button at the top left to go back to the room list.

### How the server key works

**Links never contain the key.** If the server sets `SERVER_KEY`, the page first shows an input box;
enter the key once and the browser remembers it, so the same browser opens the page directly afterwards.

That keeps shared URLs clean (`http://<server>:8788/room/xxx`) — everyone knows their own key. If a
link happens to carry `?key=xxx`, the page uses it and then strips it from the address bar, but there
is no need to share links that way.

> The web client is a **dashboard** only: no sound comes out of the browser. The music plays in each
> person's SPlayer.

## Server configuration

Everything is configured through environment variables, all with defaults.

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8788` | Listen port |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` for localhost-only access |
| `SERVER_KEY` | empty | **Server key**. When set, every endpoint requires it; without it anyone can create rooms |
| `ROOM_KEY` | empty | Global room key required by every room (an independent gate from `SERVER_KEY`) |
| `MEMBER_TTL_MS` | `60000` | How long without a heartbeat before a member counts as offline; lets others take over when the host drops |
| `ROOM_TTL_MS` | `43200000` | How long an empty room is kept (12 hours) |
| `LOCALE` | `zh_cn` | Server message language (API errors, console output): `zh_cn` / `en_us` |

With `SERVER_KEY` set, `/api/health` stays open (container health checks need it) but only reports
the version and uptime — no room count.

### Docker

```bash
docker compose up -d
```

Or:

```bash
docker build -t listen-together .
docker run -d -p 8788:8788 -e ROOM_KEY=my-secret listen-together
```

## Troubleshooting

**The plugin says "ready" but the room page stays empty**

Check the plugin logs (the app's main log is in `{userData}/app-data/logs/`). The usual cause is a
wrong server address; enabling "Verbose logging" surfaces the actual error. The
一起听：状态 menu item tells you the reason directly.

**Status shows "server key incorrect" (服务端密钥不正确)**

The server runs with `SERVER_KEY` but the plugin's "Server key" is missing or wrong. Fill in the same
value; the plugin reconnects automatically after saving — no reinstall needed.

**Listeners never switch songs**

1. Make sure SPlayer's MCP server is on (Settings → AI integration → MCP);
2. Make sure the plugin's "Allow automatic track switching via MCP" is on, with the right port and key;
3. A wrong key shows up as `MCP key incorrect` (MCP 密钥不正确) in the plugin status.

**Listeners lag behind the host / the progress keeps jumping**

A smaller "seek alignment threshold" syncs tighter but seeks more often; a larger one does the
opposite. Long-poll propagation is usually under a second, and with network jitter the typical
overall drift is around one second.

**Cannot connect over the LAN**

The server binds to `0.0.0.0` by default; make sure the firewall allows the port, and in the plugin
use the LAN IP rather than `127.0.0.1`.

## Project layout

```
plugin/
  splayer-listen-together.js   Client plugin (single file, import directly into SPlayer)

server/src/
  index.ts        HTTP entry, static files, SSE
  routes.ts       /api/* routing
  rooms.ts        Room state machine (host election, control modes, long polling, member timeouts)
  types.ts        Protocol types (authoritative wire-format definitions)
  config.ts       Environment-variable configuration
  i18n.ts         Server messages (API errors, console output; zh/en)
  util.ts         JSON / CORS / constant-time comparison helpers
  web/
    index.html    Web client (markup only)
    style.css     Styles
    app.js        Page logic

scripts/
  start.mjs          Server launcher (pnpm start uses it; reads .env.local)
  check-plugin.mjs   Plugin test rig (loads the plugin for real inside a fake splayer environment)
  simulate.mjs       End-to-end drill (incl. timeout release and server-key gate scenarios)
  seed-demo.mjs      Seeds a demo room for UI work
  lib/env.mjs        Helpers shared by the dev scripts

docs/
  zh/   Simplified Chinese docs (index: docs/zh/README.md)
  en/   English docs (index: docs/en/README.md)

LICENSE / CHANGELOG.md / README.md
```

## Development

Code under `server/src/` runs directly via Node's native type stripping — **no build step and zero
runtime dependencies**. The three web files are served as-is; edit and refresh the browser.

```bash
pnpm start                           # start the server (reads .env.local)
pnpm run dev                         # restart automatically on changes
pnpm install && pnpm run typecheck    # type checking
pnpm test                            # run both suites below (starts a server itself if none is running)
pnpm run demo                        # seed a demo room and open the UI in a browser
```

The two test suites:

| Script | What it does |
| --- | --- |
| [`scripts/check-plugin.mjs`](scripts/check-plugin.mjs) | Builds a fake `splayer` environment with `node:vm` and really loads the plugin: validates the script header, the `register()` declarations (event names, settings schema, menu items), and exercises "host reports", "listener auto-switches via MCP", and "the difference between the two control modes" |
| [`scripts/simulate.mjs`](scripts/simulate.mjs) | Plays a host plus a listener as two fake clients and runs the full server flow (host election, long polling, progress estimation, track switching, out-of-order dropping, control modes, host handover), then spins up a throwaway server to verify timeout release and the key gate |

After changing the server run `pnpm run test:server`; after changing the plugin run
`pnpm run test:plugin`.

Neither suite depends on external services: the server drill starts its own server on port 8788
(reusing one that is already running), and read-only steps spin up a temporary instance. So a single
`pnpm run test:server` is enough for CI — no background process needed.

CI is configured in [`.github/workflows/ci.yml`](.github/workflows/ci.yml): pushes to main and all
PRs run type checking plus both test suites.

`pnpm run demo` seeds room `demo` with one host and three listeners for tuning the web UI against
real data; add `--paused` for the paused state and `--mode host` for "Host only".

## License

AGPL-3.0-only, see [LICENSE](LICENSE) (matching SPlayer-Next).

Author **Re-BeiChen**. See [CHANGELOG.md](CHANGELOG.md) for the release history.
