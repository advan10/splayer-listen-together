/**
 * 服务端配置：全部走环境变量，带可用默认值。
 *
 *   PORT          监听端口，默认 8788
 *   HOST          监听地址，默认 0.0.0.0（容器/局域网用；只想本机访问就填 127.0.0.1）
 *   SERVER_KEY    服务端密钥。设了之后所有接口都要带对才能访问 ——
 *                 这是「谁能用这台服务端」的门，不设就是谁都能建房间
 *   ROOM_KEY      全局房间口令。是「谁能进哪个房间」的门，可以和 SERVER_KEY 无关地单独用
 *   MEMBER_TTL_MS 成员多久没心跳算离线，默认 60s
 *   ROOM_TTL_MS   空房间保留多久，默认 12h
 */

import { readFileSync } from "node:fs";
import path from "node:path";

/** 从 package.json 单点读取，避免版本号散在多处、改一处忘一处 */
const readVersion = (): string => {
  try {
    const file = path.join(import.meta.dirname, "..", "..", "package.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
};

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 8788),
  host: process.env.HOST?.trim() || "0.0.0.0",
  roomKey: process.env.ROOM_KEY?.trim() || "",
  serverKey: process.env.SERVER_KEY?.trim() || "",
  memberTtlMs: num(process.env.MEMBER_TTL_MS, 60_000),
  roomTtlMs: num(process.env.ROOM_TTL_MS, 12 * 60 * 60 * 1000),
  /** 长轮询服务端等待上限，留出余量让客户端的 request timeout 先不触发 */
  maxPollWaitMs: 30_000,
  /** 房间内成员数上限，防滥用 */
  maxMembers: 32,
  /** 共享队列长度上限；超出后从队尾丢（保近的） */
  maxQueue: 200,
  /** 一次最多加几首（和 SPlayer MCP 的 add_to_queue 上限对齐） */
  maxQueueAdd: 50,
} as const;

/** 服务端版本，取 package.json；插件有自己的独立版本号（写在脚本头部） */
export const VERSION = readVersion();
