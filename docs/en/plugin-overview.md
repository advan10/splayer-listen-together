# The SPlayer-Next Plugin System: Plugin Types and the Sandbox

Before building this project, we went through the SPlayer-Next plugin system, its type definitions, and its implementation. This set of notes records the **conclusions and the evidence**, with emphasis on the things the docs don't state outright but that shaped the architecture.

Repository: [SPlayer-Dev/SPlayer-Next](https://github.com/SPlayer-Dev/SPlayer-Next) (`dev` branch). All claims below refer to that repository and are independent of this project's code.

> This is the first of four notes: [Plugin Types and the Sandbox](plugin-overview.md), [Events and Reverse Control](plugin-events.md), [Playing a Track via MCP](plugin-mcp.md), and [Track, Settings, and Practical Findings](plugin-track-and-settings.md).

## Two kinds of plugins

| Type | `@type` | What it can do |
| --- | --- | --- |
| Source plugin | `source` (default) | Provides `musicUrl` resolution, lyrics/cover fallbacks |
| Control plugin | `control` | Subscribes to playback events, controls playback, declares settings, adds song-context menu items |

A single script can only be one kind. **Listen Together uses `control`.**

A control plugin must declare `@apiLevel 2` in its header; the host currently runs API level 3 (`HOST_API_LEVEL = 3` in `shared/defaults/plugin-api.ts`). A declared level above the host's is rejected at load time.

## What the sandbox provides (this dictates how the plugin is written)

The host builds a `node:vm` context per plugin in a separate child process and injects a single global object, `splayer`.

**Available**: `splayer`, `Buffer`, `URL`/`URLSearchParams`, `TextEncoder`/`TextDecoder`, `btoa`/`atob`, `Promise`, `queueMicrotask`, timers, `console` (forwarded to `splayer.log`).

**Not available**: Node built-in modules, `require`/`import`, DOM, Electron APIs, `fetch`, `WebSocket`.

Networking goes exclusively through `splayer.request`, restricted to `http://` / `https://`, with a default timeout of 15 s and a hard cap of 60 s. Top-level synchronous code must finish within 5 seconds.

> **This dictates two architectural decisions**: the plugin cannot use WebSockets (hence the server supports [long polling](protocol-concepts.md#long-polling)), and the plugin cannot `npm install` anything (hence it is a single file with zero dependencies).
