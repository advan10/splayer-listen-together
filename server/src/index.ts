import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, VERSION } from "./config.ts";
import { handleApi, handlePreflight } from "./routes.ts";
import { roomStore } from "./rooms.ts";
import { isValidRoomId, extractServerKey, safeEqual, sendJson, sendText } from "./util.ts";

const WEB_DIR = path.join(import.meta.dirname, "web");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** 只允许访问 web 目录下的白名单文件，避免路径穿越 */
const serveStatic = async (res: ServerResponse, name: string): Promise<void> => {
  const safe = path.basename(name);
  const filePath = path.join(WEB_DIR, safe);
  try {
    const body = await readFile(filePath);
    const type = CONTENT_TYPES[path.extname(safe)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": String(body.length),
      // 自建工具，更新服务端之后刷新就该看到新界面。
      // 用 no-store 而不是 no-cache：这几个文件加起来才几十 KB，
      // 但缺了 ETag 时 no-cache 仍可能被浏览器的启发式缓存绕过去，很坑。
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    sendText(res, 404, "Not Found");
  }
};

/**
 * 网页端的实时通道：Server-Sent Events。
 *
 * 插件用不了 WebSocket（沙箱只给 splayer.request），但浏览器可以；
 * 网页看房间用 SSE 比轮询省事，也不用引依赖。
 */
const handleSse = (req: IncomingMessage, res: ServerResponse, roomId: string): void => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const send = (data: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 先订阅再发首帧：subscribe 会确保房间存在，
  // 直接 get() 的话，房间还没人进过时首帧是 null，页面就整块渲染不出来
  const unsubscribe = roomStore.subscribe(roomId, (room) => send({ type: "update", room }));
  send({ type: "snapshot", room: roomStore.get(roomId) });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": ping\n\n");
  }, 20_000);
  heartbeat.unref?.();

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
};

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (handlePreflight(req, res)) return;

      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const sse = /^\/api\/room\/([^/]+)\/events$/.exec(url.pathname);

      // SSE 要在通用 /api 路由之前拦下来，否则会被当成未知接口
      if (sse && req.method === "GET") {
        // 房间页是浏览器开的，EventSource 设不了请求头，所以这条用 ?key=
        if (config.serverKey && !safeEqual(extractServerKey(req, url), config.serverKey)) {
          sendJson(res, 401, { ok: false, error: "服务端密钥缺失或不正确", code: "SERVER_KEY_REQUIRED" });
          return;
        }
        const roomId = decodeURIComponent(sse[1] as string);
        if (!isValidRoomId(roomId)) {
          sendJson(res, 400, { ok: false, error: "房间 ID 非法", code: "BAD_ROOM_ID" });
          return;
        }
        handleSse(req, res, roomId);
        return;
      }

      if (await handleApi(req, res, url)) return;

      if (req.method !== "GET") {
        sendText(res, 405, "Method Not Allowed");
        return;
      }

      // 只把 `/` 和 `/room/<房间ID>` 当作房间页。
      // 不能用 startsWith("/room/")，否则 /room/style.css 也会被喂成 HTML
      if (url.pathname === "/" || /^\/room\/[^/]+\/?$/.test(url.pathname)) {
        await serveStatic(res, "index.html");
        return;
      }

      await serveStatic(res, url.pathname.slice(1));
    } catch (error) {
      console.error("[server] 请求处理失败:", error);
      if (!res.writableEnded) sendText(res, 500, "Internal Server Error");
    }
  })();
});

// 长轮询会挂住连接，别让 Node 的默认超时把它掐了
server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;

const sweeper = setInterval(() => roomStore.sweep(), 15_000);
sweeper.unref?.();

server.listen(config.port, config.host, () => {
  const shown = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  console.log(`\n  一起听服务端 v${VERSION} 已启动`);
  console.log(`  房间列表  http://${shown}:${config.port}/`);
  console.log(`  房间页面  http://${shown}:${config.port}/room/<房间ID>`);
  console.log(`  健康检查  http://${shown}:${config.port}/api/health`);
  console.log(
    config.serverKey
      ? "  服务端密钥 已开启：插件要填对密钥才能连上"
      : "  服务端密钥 未设置 —— 任何人都能创建房间，建议设一个 SERVER_KEY",
  );
  if (config.roomKey) console.log("  房间口令  已由 ROOM_KEY 环境变量设置");
  console.log("");
});

const shutdown = (signal: string): void => {
  console.log(`\n收到 ${signal}，正在关闭…`);
  clearInterval(sweeper);
  server.close(() => process.exit(0));
  // 兜底：长轮询连接可能还挂着，10 秒没关干净就强退
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
