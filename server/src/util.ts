import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const now = (): number => Date.now();

export const randomHex = (bytes = 16): string => randomBytes(bytes).toString("hex");

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * 恒定时间比较，避免用比较耗时反推密钥。
 *
 * 长度不等时直接返回 false —— 这会泄露「长度对不对」，
 * 但换来的是不会因 timingSafeEqual 长度不一致抛异常，这个取舍是常规做法。
 */
export const safeEqual = (a: string, b: string): boolean => {
  if (a.length === 0 || b.length === 0) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/**
 * 取出请求携带的服务端密钥。
 *
 * 优先请求头（插件走这条），其次 `?key=` 查询参数 ——
 * 浏览器的 EventSource 设不了请求头，房间页只能靠查询参数。
 */
export const extractServerKey = (req: IncomingMessage, url: URL): string => {
  const headerValue = req.headers["x-server-key"];
  if (typeof headerValue === "string" && headerValue) return headerValue;
  if (Array.isArray(headerValue) && headerValue[0]) return headerValue[0];
  return url.searchParams.get("key") ?? "";
};

/** 读取并解析 JSON 请求体；超过 limit 字节直接拒绝 */
export const readJson = async (req: IncomingMessage, limit = 256 * 1024): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid json");
  }
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Client, X-Mcp-Key, X-Server-Key",
  "Access-Control-Max-Age": "86400",
};

export const sendJson = (
  res: ServerResponse,
  status: number,
  data: unknown,
): void => {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    ...CORS_HEADERS,
  });
  res.end(body);
};

export const sendText = (
  res: ServerResponse,
  status: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void => {
  const body = Buffer.from(text, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": String(body.length),
    ...CORS_HEADERS,
  });
  res.end(body);
};

export const sendEmpty = (res: ServerResponse, status = 204): void => {
  res.writeHead(status, CORS_HEADERS);
  res.end();
};

/** 房间 ID 白名单：URL 安全，便于直接当路径段用 */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidRoomId = (value: unknown): value is string =>
  typeof value === "string" && ROOM_ID_PATTERN.test(value);

/** 把任意输入收敛成安全的展示名 */
export const sanitizeName = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? fallback : trimmed.slice(0, 32);
};
