# The SPlayer-Next Plugin System: Playing a Track via MCP

Third of the plugin research notes. The [previous note](plugin-events.md) concluded that the control-plugin API has no way to play a specific track — MCP is the one loophole.

## MCP: the only way to "play that exact song"

`electron/main/services/mcp/server.ts` registers `play_track`:

```ts
play_track(trackId?: string, track?: Record<string, any>)
  → 优先用 trackId 查本地曲库；查不到就用传入的 track 对象
  → playerControl.playTrack(track)
```

`playerControl.playTrack` goes through `sendToMain("player:event", { type: "playTrack" })`;
the renderer picks it up in `src/core/player/events.ts` → `playNow(track)`
(`src/core/player/index.ts`) → inserts it into the queue and calls `loadTrack`.
**Any complete Track can be played**, including online songs that are not in the local library.

In other words: **handing the host's entire Track to `play_track` makes the listener play the same song** —
no searching, no title matching. That is exactly what the Listen Together plugin does.

## MCP connection details

`electron/main/services/mcp/http.ts` + `endpoint.ts`:

- Address `http://127.0.0.1:<port>/mcp`; default port **14559**; **disabled by default**, must be enabled in settings;
- Auth header `X-MCP-Key`; the value is visible on the settings page under "configuration details" (a hex-encoded 16-byte random value);
- When an `Origin` header is present it must be localhost — requests sent from Node carry no `Origin`, so this is fine;
- Sessions are addressed via `Mcp-Session-Id`: call `initialize` first to obtain an ID, then send it with every request;
  the server keeps at most 8 sessions and reclaims idle ones after 30 minutes — so the plugin must be able to reopen a session on 404;
- `enableJsonResponse: true`, so responses are plain JSON.

## Why the whole Track is passed as a parameter

When `play_track` is given a `trackId`, it looks the song up via `getTrackById()` (the local library).
Online songs are not in the local library, so the lookup returns `undefined`.
The `track` parameter is therefore required, and `track.id` must be a string.

## What else the plugin does over MCP

The Listen Together plugin also uses the same MCP connection to call `add_to_queue`, pushing newly added songs from the shared room queue into the local playlist (see "Room queue" in the root README). Note that MCP can only *add* to the queue: it can neither read nor remove entries from the local playlist, so queue sync is **one-way best-effort alignment**.

## If the plugin API ever supports playing a named track

The entire `mcp` section of the Listen Together plugin (roughly 120 lines) could then be deleted:
replace `mcp.playTrack(track)` with `splayer.player.playTrack(track)` and keep
the rest (rooms, clock, follow logic) untouched.

This is also why the plugin funnels "play this song" into a single `mcp.playTrack(track)` call site.
