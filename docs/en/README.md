# Listen Together · Documentation Index

This directory contains the **English documentation**; the Simplified Chinese version lives in [`docs/zh/`](../zh/README.md). Both versions share identical file names and heading structure.

For installation, configuration, and troubleshooting aimed at end users, see the root-level [README.md](../../README.md) (Chinese version: [README.zh-CN.md](../../README.zh-CN.md)).

## Protocol docs (server ↔ plugin / web client)

| File | Contents |
| --- | --- |
| [protocol-overview.md](protocol-overview.md) | Protocol overview, conventions, authentication (`SERVER_KEY`), and error-message localization |
| [protocol-concepts.md](protocol-concepts.md) | Host and driver roles, control modes, long polling, clock and progress estimation |
| [protocol-endpoints.md](protocol-endpoints.md) | All HTTP endpoints: health check, join, publish, mode, poll, leave, snapshot, room list, SSE |
| [protocol-queue.md](protocol-queue.md) | Shared room queue endpoints: adding, removing, and clearing songs |
| [protocol-types.md](protocol-types.md) | `RoomSnapshot` and related data structures, plus the error-code reference |

## Plugin research (SPlayer-Next capability boundaries)

| File | Contents |
| --- | --- |
| [plugin-overview.md](plugin-overview.md) | Plugin types and the sandbox capability boundary |
| [plugin-events.md](plugin-events.md) | Control-plugin events and reverse-control actions |
| [plugin-mcp.md](plugin-mcp.md) | Playing a specific track via the local MCP server (the only way to switch songs automatically) |
| [plugin-track-and-settings.md](plugin-track-and-settings.md) | Track shape, settings and menus, and other practical findings |

> The authoritative type definitions for the wire format live in [`server/src/types.ts`](../../server/src/types.ts); the plugin carries an equivalent hand-written copy, and the two must be kept in sync.
