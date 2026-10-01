# The SPlayer-Next Plugin System: Track Shape, Settings, and Practical Findings

Final note of the series. The earlier ones are [Plugin Types and the Sandbox](plugin-overview.md), [Events and Reverse Control](plugin-events.md), and [Playing a Track via MCP](plugin-mcp.md).

## Shape of a Track

From `shared/types/player.ts` / the [type reference](https://splayer-next.imsyy.top/types).
For online platforms the `source` values are **`netease` / `qqmusic` / `kugou`** (not the lx-style `wy`/`tx`/`kg`).
Local files use `local`, and streaming servers use `streaming`.

Commonly used fields: `id`, `source`, `title`, `artists[]`, `album?`, `duration` (ms), `cover?`, `fee?`, `cloud?`.

> The Listen Together server **does not trim** the Track and passes it through verbatim. Trimming would break `play_track` or fields added in later versions.

## Settings and menus

`register({ settings })` supports four control types: `switch` / `number` / `text` / `select`.
The host coerces and clamps values by `type`, so the plugin always reads normalized values.
Changes are delivered in real time through `splayer.onSettingChange(key, handler)`.

`register({ menus })` adds entries to the song context menu and requires `@grant ui`.
Clicks arrive via `splayer.on("menuClick", ({ menuId, track }) => …)`.
The handler can affect the UI **only** through its return value — any combination of:

```ts
{ toast?: string, openUrl?: string, copyText?: string }
```

> ⚠️ This is the **only** channel a control plugin has for showing something to the user proactively.
> There is no DOM in the sandbox, no custom panels, and no "fire a toast whenever I want" API.
> That is why Listen Together exposes status queries as menu items instead of proactive notifications.

## Other practical findings

- **Grants**: `@grant network` (`splayer.request`) / `control` (`splayer.player.*`) / `ui` (menus).
  Source plugins get `network` automatically; control plugins must declare it explicitly.
- **Storage**: `splayer.storage` is a per-plugin isolated KV store, cleared on uninstall. A good home for the host token.
- **Error codes**: handlers may set `err.code` to a `PLUGIN_*` value; if unset, it defaults to `PLUGIN_HANDLER_ERROR`.
- **Crash isolation**: when the host process crashes it restarts with backoff (2 s → 8 s → 30 s) and reloads plugins; three consecutive failures mark it `error`.
  Never write infinite loops in a plugin — all plugins share the host's single event loop.
- **Debugging**: in DevTools, `await window.api.plugins.list()` shows plugin state and
  `await window.api.plugins.setSetting(id, key, value)` changes settings live. Logs are in `{userData}/app-data/logs/`.
