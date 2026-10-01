# The SPlayer-Next Plugin System: Events and Reverse Control

Second of the plugin research notes: which events a control plugin can subscribe to, and which playback actions it can perform. The first note is [Plugin Types and the Sandbox](plugin-overview.md).

## Control-plugin events

`splayer.player.on(kind, handler)` — only events declared in `register({ events: [...] })` are ever delivered:

| Event | Payload | Fires when |
| --- | --- | --- |
| `trackChange` | `{ track }` | The track changes |
| `lyricChange` | `{ lines }` | The lyrics change as a whole |
| `lineChange` | `{ index, position }` | The **current lyric line** advances |
| `playStateChange` | `{ state, position }` | The play state **flips** |

Based on `electron/main/plugins/playbackBridge.ts`:

- `playStateChange` is only broadcast when `pluginState !== lastPluginState` — it is **not** a progress feed;
- `lineChange` advances via `findIndex(position)` and **never fires for songs without lyrics**.

> ⚠️ Consequently, the plugin has no continuous progress stream. A song without lyrics produces **no events at all** while playing.
> The Listen Together plugin therefore runs its own heartbeat: a timer that calls `player.getPosition()` as a fallback.
> The docs also warn that every `getPosition()` call is a round trip, suitable only for occasional queries.

When a plugin is enabled, the host immediately replays a snapshot of the current state (`primePlugin`), so the plugin does not need to fetch initial values itself.

## Reverse control: only six actions

`PluginPlayerApi` (`shared/types/plugin.ts`) — this is the complete list:

```ts
play() / pause() / next() / prev() / seek(ms) / setVolume(0~1) / getPosition(): Promise<number>
```

`HostCallMethod` likewise only lists `player.play` / `player.pause` / `player.next` /
`player.prev` / `player.seek` / `player.setVolume` / `player.getPosition`.

**There is no `playTrack`.** This is the project's biggest constraint.

The external HTTP API (`/api/*`) and the WebSocket API offer the same
play / pause / stop / next / prev / seek / setVolume set — likewise no way to name a specific track.

The only local entry point that can "play this exact song" is SPlayer's built-in MCP interface — see the next note, [Playing a Track via MCP](plugin-mcp.md).
