/**
 * 服务端启动器（`npm start` / `npm run dev` 走这里）。
 *
 * 做两件事：
 *
 * 1. 从项目根的 .env.local 读本地配置（SERVER_KEY 等），
 *    省得每次都在命令行里写一长串环境变量。这个文件不进版本库，
 *    模板见 .env.example。
 * 2. 把端口钉死在 8788 —— 插件里的「服务端地址」默认就写的是它。
 *    编辑器/预览工具若随机分配端口，插件还得跟着改设置。
 *
 * 也可以不用它，直接 `SERVER_KEY=xxx node server/src/index.ts`。
 */

import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLocalEnv, projectRoot } from "./lib/env.mjs";

if (loadLocalEnv()) console.log("  已读取 .env.local");

// 没设就用默认端口；外部已经给了 PORT 就尊重它
process.env.PORT ||= "8788";

// Windows 上动态 import 不吃绝对路径，得转成 file:// URL
await import(pathToFileURL(path.join(projectRoot, "server", "src", "index.ts")).href);