/**
 * 造一间演示房间，用来调网页界面。
 *
 *   node scripts/seed-demo.mjs [房间ID] [--paused] [--mode all|host] [--cover URL]
 *
 * 会加入一个房主和几个听众，然后让房主上报一首歌。
 * 本地服务端带 SERVER_KEY 的话会从 .env.local 读出来自动带上。
 * 纯本地调试用，和插件、协议都无关。
 */

import { loadLocalEnv, serverKeyFromEnv, serverUrlFromEnv } from "./lib/env.mjs";

loadLocalEnv();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const ROOM = args.find((value) => !value.startsWith("--")) || "demo";
const PAUSED = args.includes("--paused");
const MODE = flag("mode", "all");
const COVER = flag("cover", "https://picsum.photos/seed/sunset42/700");
const BASE = serverUrlFromEnv();
const KEY = serverKeyFromEnv();

const headers = { "Content-Type": "application/json", ...(KEY ? { "X-Server-Key": KEY } : {}) };
const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }).then(async (response) => {
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${path} -> ${response.status} ${JSON.stringify(payload)}`);
    return payload;
  });

const NAMES = ["北尘", "小明", "阿澈", "Nagi"];

const main = async () => {
  console.log(`\n目标服务端 ${BASE}，房间 ${ROOM}\n`);

  const host = await post(`/api/room/${ROOM}/join`, { name: NAMES[0], role: "host" });
  console.log(`  ✓ ${NAMES[0]} 成为房主`);

  for (const name of NAMES.slice(1)) {
    await post(`/api/room/${ROOM}/join`, { name, role: "auto" });
    console.log(`  ✓ ${name} 加入`);
  }

  if (MODE !== "host") {
    await post(`/api/room/${ROOM}/mode`, { clientId: host.clientId, hostToken: host.hostToken, mode: MODE });
    console.log(`  ✓ 控制模式 → ${MODE}`);
  }

  await post(`/api/room/${ROOM}/publish`, {
    clientId: host.clientId,
    hostToken: host.hostToken,
    playback: {
      track: {
        id: "1330348068",
        source: "netease",
        title: "我用什么把你留住",
        artists: [{ id: "12085000", name: "朱格乐" }, { id: "1104687", name: "房东的猫" }],
        album: { id: "74535799", name: "我用什么把你留住" },
        duration: 245000,
        cover: COVER,
      },
      playing: !PAUSED,
      position: 63000,
      seq: Date.now(),
      clientTime: Date.now(),
    },
  });
  console.log(`  ✓ 上报曲目（${PAUSED ? "已暂停" : "播放中"}）`);

  console.log(`\n  打开 ${BASE}/room/${ROOM}${KEY ? `?key=${KEY}` : ""}\n`);
};

main().catch((error) => {
  console.error("\n失败：", error.message);
  console.error("（服务端起了吗？默认连 http://127.0.0.1:8788，可用 SERVER_URL / SERVER_KEY 覆盖）\n");
  process.exit(1);
});
