/**
 * 开发脚本共用的小工具。
 */

import path from "node:path";
import { existsSync } from "node:fs";

/** 项目根目录（scripts/ 的上一级） */
export const projectRoot = path.join(import.meta.dirname, "..", "..");

/**
 * 读取项目根的 .env.local（如果有）。
 *
 * 本地开发时服务端往往带着 SERVER_KEY 在跑，测试脚本也得知道这个密钥
 * 才能连上去，不然一跑就是 401。
 * @returns 是否读到了文件
 */
export const loadLocalEnv = () => {
  const file = path.join(projectRoot, ".env.local");
  if (!existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch {
    return false;
  }
};

/** 当前该用的服务端密钥（没设就是空串） */
export const serverKeyFromEnv = () => process.env.SERVER_KEY || "";

/** 当前该连的服务端地址 */
export const serverUrlFromEnv = () =>
  (process.env.SERVER_URL || `http://127.0.0.1:${process.env.PORT || 8788}`).replace(/\/+$/, "");
