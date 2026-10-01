# Protocol Overview and Authentication

Every interface between the Listen Together server and the plugin is HTTP + JSON. The web client reuses the read-only parts and additionally consumes an SSE stream for live updates (see [Endpoint Reference](protocol-endpoints.md#get-apiroomroomidevents-web-sse-stream)).

## Conventions

- Base path: `http://<host>:<port>/api`, default port `8788`
- Requests and responses are JSON
- Time unit: **milliseconds**
- Timestamps: Unix milliseconds (`Date.now()`)
- Field naming: lowerCamelCase

The authoritative type definitions for the wire format live in [`server/src/types.ts`](../../server/src/types.ts). The plugin is a single-file, plain-JS script and cannot `import` them, so it carries an equivalent hand-written copy; the two must be updated together.

## Authentication: the server key

When the server has the `SERVER_KEY` environment variable set, **every endpoint except `/api/health`** requires that key; otherwise the server responds with `401 SERVER_KEY_REQUIRED`.

There are two ways to present it:

| Method | Used by |
| --- | --- |
| Request header `X-Server-Key: <key>` | The plugin |
| Query parameter `?key=<key>` | Browsers — `EventSource` cannot set request headers |

The comparison uses a constant-time implementation (`timingSafeEqual`) so that response timing cannot be used to guess the key.

`/api/health` is the exception and always stays open because container health checks depend on it. With a key configured, however, it only returns `version` / `uptimeMs` / `serverTime` and omits the room count.

> **Do not treat this as strong authentication.** The key is a *shared* secret: anyone who obtains it can create and join rooms.
> It keeps out strangers who lack the key; it does nothing against someone who has it.
> Also note that neither `clientId` nor `hostToken` is a signed credential — anyone with the key can impersonate another client's `clientId`.
> This is fine for a circle of friends; do not use it as multi-tenant isolation.

## Error-message localization

The server's API error messages and console output follow the `LOCALE` environment variable: `zh_cn` (default) or `en_us` (case- and hyphen-insensitive, so `en-US` also works). The locale is fixed once at process startup; there is no per-request negotiation.

Clients should therefore treat the `code` field of an error response as the contract; the `error` text is for humans only. The full error-code table is in [Data Structures and Error Codes](protocol-types.md#error-responses).
