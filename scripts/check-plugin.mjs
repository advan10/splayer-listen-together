/**
 * 插件测试台：在没有 SPlayer 的情况下真实加载插件并验证它的行为。
 *
 *   node scripts/check-plugin.mjs
 *
 * 它会做这些事：
 *   1. 校验 JSDoc 头部（@name/@id/@version/@type/@apiLevel/@grant）
 *   2. 校验 register() 的声明（事件名、设置项 schema、菜单项）
 *   3. 房主路径：曲目变化后应当把整条 Track 上报到 /publish
 *   4. 听众路径：轮询到别人的歌之后应当调 MCP 的 play_track
 *   5. 两种控制模式的差别：只有房主可调时听众动手不算数，
 *      大家都可以调时听众一动手就接管
 *   6. 跟随别人产生的本地变化不会当成「本机操作」报回去（没有回声）
 *   7. 重连不会让轮询循环越攒越多（改一次设置多一个循环的老毛病）
 *
 * 沙箱用 node:vm 还原（与 SPlayer 的做法一致：只注入 splayer，没有 require/DOM）。
 */

import vm from "node:vm";
import { readFile } from "node:fs/promises";
import path from "node:path";

const PLUGIN_PATH = path.join(import.meta.dirname, "..", "plugin", "splayer-listen-together.js");
const MCP_PORT = 14559;
const SERVER = "http://127.0.0.1:8788";
const ROOM = "test-room";

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`}`);
};
const ok = (label, condition) => {
  if (!condition) failures += 1;
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
};

const source = await readFile(PLUGIN_PATH, "utf8");

/* ── 1. JSDoc 头部 ───────────────────────────────────────────────────────────── */

console.log("\n[1] 脚本头部（Manifest）");

const manifest = {};
for (const match of source.matchAll(/^\s*\*\s*@(\w+)\s+(.+)$/gm)) {
  if (!(match[1] in manifest)) manifest[match[1]] = match[2].trim();
}
console.log(`  声明到：name=${manifest.name} id=${manifest.id} v${manifest.version} type=${manifest.type} apiLevel=${manifest.apiLevel} grant="${manifest.grant}"`);

check("@name（≤24 字符）", manifest.name && manifest.name.length <= 24, true);
check("@id 是反向域名风格", /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(manifest.id || ""), true);
check("@version 是语义化版本", /^\d+\.\d+\.\d+$/.test(manifest.version || ""), true);
check("@type", manifest.type, "control");
ok("@apiLevel 不超过宿主级别 3", Number(manifest.apiLevel) >= 1 && Number(manifest.apiLevel) <= 3);
ok("@grant 含 network（要联网）", (manifest.grant || "").split(/[,\s]+/).includes("network"));
ok("@grant 含 control（要反向控制播放）", (manifest.grant || "").split(/[,\s]+/).includes("control"));
ok("@grant 含 ui（要加菜单项）", (manifest.grant || "").split(/[,\s]+/).includes("ui"));

/* ── 搭沙箱 ─────────────────────────────────────────────────────────────────── */

const settings = {};
/** 当前 boot 的实例状态；boot() 每次换一套，旧实例写不到这里来 */
let state = null;

const makeState = () => ({
  registered: null,
  handlers: {},
  events: {},
  storage: new Map(),
  requests: [],
  pendingPolls: [],
  version: 1,
  logs: [],
  role: "host",
  settings,
});

const HOST_TRACK = {
  id: "347230",
  source: "netease",
  title: "海阔天空",
  artists: [{ id: "6452", name: "Beyond" }],
  album: { id: "34209", name: "乐与怒" },
  duration: 326000,
  cover: "https://p2.music.126.net/x.jpg",
};

const LOCAL_TRACK = { id: "local-1", source: "local", title: "本地的一首歌", artists: [], duration: 100000 };

const roomSnapshot = (playback = null, driverClientId = null) => ({
  roomId: ROOM,
  name: ROOM,
  version: state.version,
  playback,
  hostClientId: "host-1",
  controlMode: settings.controlMode === "all" ? "all" : "host",
  driverClientId,
  members: [],
  serverTime: Date.now(),
});

/** 让测试能控制 /poll 什么时候返回 */
const deliverPoll = (playback, driverClientId) => {
  state.version += 1;
  const waiter = state.pendingPolls.shift();
  if (!waiter) return false;
  waiter.resolve({
    status: 200,
    headers: {},
    body: {
      ok: true,
      changed: true,
      serverTime: Date.now(),
      room: roomSnapshot(playback, driverClientId),
    },
  });
  return true;
};

/**
 * 把所有挂着的长轮询一次性放掉，模拟它们超时返回。
 *
 * 真机上长轮询 25 秒就会回来，这个 mock 默认让它永远挂着；
 * 想观察「循环有没有复活」就得手动放行。
 */
const releasePolls = () => {
  const parked = state.pendingPolls.splice(0);
  for (const waiter of parked) {
    waiter.resolve({
      status: 200,
      headers: {},
      body: { ok: true, changed: false, serverTime: Date.now(), room: roomSnapshot() },
    });
  }
  return parked.length;
};

const makeSplayer = (state) => ({
  pluginId: "listen-together.splayer",
  apiLevel: 3,
  locale: "zh-CN",
  appVersion: "1.0.0",
  log: {
    debug: (...a) => state.logs.push(["debug", a.join(" ")]),
    info: (...a) => state.logs.push(["info", a.join(" ")]),
    warn: (...a) => state.logs.push(["warn", a.join(" ")]),
    error: (...a) => state.logs.push(["error", a.join(" ")]),
  },
  register: (args) => {
    state.registered = args;
  },
  on: (action, handler) => {
    state.handlers[action] = handler;
  },
  getSetting: (key) => settings[key],
  onSettingChange: (key, handler) => {
    state.handlers[`setting:${key}`] = handler;
  },
  storage: {
    get: async (key) => (state.storage.has(key) ? state.storage.get(key) : null),
    set: async (key, value) => void state.storage.set(key, value),
    remove: async (key) => void state.storage.delete(key),
    keys: async () => [...state.storage.keys()],
  },
  player: {
    on: (kind, handler) => {
      state.events[kind] = handler;
    },
    play: () => state.logs.push(["player", "play"]),
    pause: () => state.logs.push(["player", "pause"]),
    next: () => {},
    prev: () => {},
    seek: (ms) => state.logs.push(["player", `seek ${Math.round(ms)}`]),
    setVolume: () => {},
    getPosition: async () => 0,
  },
  request: async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    state.requests.push({ url, body, headers: opts.headers || {} });

    // ── 我们自己的服务端 ──
    if (url.startsWith(SERVER)) {
      if (url.endsWith("/join")) {
        const isHost = state.role === "host";
        return {
          status: 200,
          headers: {},
          body: {
            ok: true,
            roomId: ROOM,
            clientId: isHost ? "host-1" : "guest-1",
            role: state.role,
            isHost,
            ...(isHost ? { hostToken: "tok-1" } : {}),
            serverTime: Date.now(),
            room: roomSnapshot(null, null),
          },
        };
      }
      if (url.endsWith("/publish")) {
        state.version += 1;
        return {
          status: 200,
          headers: {},
          body: { ok: true, accepted: true, version: state.version, serverTime: Date.now() },
        };
      }
      if (url.endsWith("/mode")) {
        state.version += 1;
        return {
          status: 200,
          headers: {},
          body: { ok: true, accepted: true, mode: body.mode, version: state.version, serverTime: Date.now() },
        };
      }
      if (url.endsWith("/poll")) {
        // 挂住，等测试主动投递
        return new Promise((resolve) => {
          state.pendingPolls.push({ resolve });
        });
      }
    }

    // ── SPlayer 的本机 MCP ──
    if (url.includes(`127.0.0.1:${MCP_PORT}/mcp`)) {
      if (body?.method === "initialize") {
        return {
          status: 200,
          headers: { "mcp-session-id": "session-1" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: body.params.protocolVersion, capabilities: {}, serverInfo: { name: "splayer-next", version: "1.0.0" } },
          }),
        };
      }
      if (body?.method === "notifications/initialized") {
        return { status: 202, headers: {}, body: "" };
      }
      if (body?.method === "tools/call") {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: '{"ok":true}' }], isError: false } }),
        };
      }
    }

    return { status: 404, headers: {}, body: { ok: false, error: "unhandled" } };
  },
});

const sandboxGlobals = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  queueMicrotask,
  Buffer,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Promise,
  Math,
  JSON,
  Date,
};

/** 用给定设置起一个全新的插件实例（旧实例的循环留在它自己的 state 里，互不干扰） */
const boot = async (overrides, role) => {
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, {
    serverUrl: SERVER,
    roomId: ROOM,
    role: "auto",
    serverKey: "",
    controlMode: "host",
    enableMcpControl: false,
    verboseLog: false,
    ...overrides,
  });

  state = makeState();
  state.role = role;

  const context = vm.createContext({ ...sandboxGlobals, splayer: makeSplayer(state) });
  vm.runInContext(source, context, { filename: "splayer-listen-together.js" });
  await settle(400);
  return context;
};

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
await boot({}, "host");

/* ── 2. register 声明 ───────────────────────────────────────────────────────── */

console.log("\n[2] register() 声明");

const reg = state.registered;
ok("调用了 splayer.register", Boolean(reg));
ok("声明了 controls", reg.controls === true);

const ALLOWED_EVENTS = ["trackChange", "lyricChange", "lineChange", "playStateChange"];
ok("events 都在允许清单里", (reg.events || []).every((e) => ALLOWED_EVENTS.includes(e)));
ok("订阅了 trackChange 与 playStateChange", ["trackChange", "playStateChange"].every((e) => reg.events.includes(e)));

const SETTING_TYPES = { switch: "boolean", number: "number", text: "string", select: "string" };
const keys = (reg.settings || []).map((s) => s.key);
ok("设置项 key 不重复", new Set(keys).size === keys.length);
ok("每个设置项都有 key / type / label / default", (reg.settings || []).every((s) => s.key && s.type && s.label && s.default !== undefined));

const badDefaults = (reg.settings || []).filter((s) => typeof s.default !== SETTING_TYPES[s.type]);
ok(`default 类型与 type 匹配（${reg.settings.length} 项）`, badDefaults.length === 0);
if (badDefaults.length) console.log("    不匹配：", badDefaults.map((s) => `${s.key}=${s.type}`).join(", "));

const badOptions = (reg.settings || []).filter((s) => s.type === "select" && (!Array.isArray(s.options) || s.options.length === 0));
ok("select 都带 options", badOptions.length === 0);

const modeOptions = (reg.settings || []).find((s) => s.key === "controlMode");
check("控制模式的选项", (modeOptions?.options || []).map((o) => o.value), ["host", "all"]);
check("控制模式默认值", modeOptions?.default, "host");

const badRanges = (reg.settings || []).filter((s) => s.type === "number" && !(typeof s.min === "number" && typeof s.max === "number" && s.default >= s.min && s.default <= s.max));
ok("number 的 min/max 合理且 default 在范围内", badRanges.length === 0);
if (badRanges.length) console.log("    问题项：", badRanges.map((s) => s.key).join(", "));

ok("菜单项都有 id / label", (reg.menus || []).every((m) => m.id && m.label));
const menuIds = (reg.menus || []).map((m) => m.id);
ok("菜单项 id 不重复", new Set(menuIds).size === menuIds.length);
ok("注册了 menuClick 处理器", typeof state.handlers.menuClick === "function");
ok("有「服务端密钥」这一项", (reg.settings || []).some((s) => s.key === "serverKey" && s.type === "text"));
ok("没设密钥时不带 X-Server-Key 请求头", state.requests.every((r) => r.headers["X-Server-Key"] === undefined));
console.log(`  设置项 ${reg.settings.length} 项，菜单项 ${menuIds.length} 项：${menuIds.join(", ")}`);

/* ── 3. 房主路径 ────────────────────────────────────────────────────────────── */

console.log("\n[3] 房主路径：曲目变化 → 上报 /publish");

// 这一次开着服务端密钥，顺便验证所有请求都带上了它
await boot({ serverKey: "plugin-test-key" }, "host");
ok(
  "设了密钥后所有请求都带上 X-Server-Key",
  state.requests.length > 0 && state.requests.every((r) => r.headers["X-Server-Key"] === "plugin-test-key"),
);
const sharedLink = await state.handlers.menuClick({ menuId: "copy-room" });
check("分享链接不带密钥（看的人自己在网页上填）", sharedLink?.copyText, `${SERVER}/room/${ROOM}`);

await boot({}, "host");
state.requests.length = 0;
state.events.playStateChange({ state: "playing", position: 0 });
state.events.trackChange({ track: HOST_TRACK });
await settle(200);

const publishCalls = state.requests.filter((r) => r.url.endsWith("/publish"));
ok("触发了 /publish", publishCalls.length > 0);

// playStateChange 先到，那次上报还没有曲目（track: null 是「房主没在放东西」的正确表达）；
// 带曲目的那次来自 trackChange
const withTrack = publishCalls.find((r) => r.body?.playback?.track);
ok("曲目变化后有一次带曲目的上报", Boolean(withTrack));

const sentTrack = withTrack?.body?.playback?.track;
check("上报里带了整条 Track（id/source 原样保留）", [sentTrack?.id, sentTrack?.source], ["347230", "netease"]);
check("Track 未被裁剪（title/artists/duration 都在）", [sentTrack?.title, sentTrack?.artists?.[0]?.name, sentTrack?.duration], ["海阔天空", "Beyond", 326000]);
ok("曲目变化时进度从 0 起算", withTrack?.body?.playback.position === 0);
check("带上了 playStateChange 的进度", publishCalls[0]?.body?.playback.position, 0);
ok("带了 clientId 与房主令牌", Boolean(withTrack?.body?.clientId && withTrack?.body?.hostToken));
ok("没有曲目时如实上报 track: null", publishCalls[0]?.body?.playback?.track === null);

/* ── 4. 听众路径：跟随 ──────────────────────────────────────────────────────── */

console.log("\n[4] 听众路径：轮询到别人的歌 → 调本机 MCP 的 play_track");

await boot({ enableMcpControl: true, mcpKey: "0123456789abcdef0123456789abcdef" }, "guest");
ok("听众已加入（不是房主）", state.requests.some((r) => r.url.endsWith("/join") && r.body.role === "auto"));

state.events.trackChange({ track: LOCAL_TRACK });
state.events.playStateChange({ state: "playing", position: 0 });
await settle(150);

// 「只有房主可调」下，听众在本地怎么点都不该影响房间
const guestPublishes = state.requests.filter((r) => r.url.endsWith("/publish"));
check("host 模式下听众动手不会上报", guestPublishes.length, 0);

const delivered = deliverPoll(
  { track: HOST_TRACK, playing: true, position: 5000, seq: 3, clientTime: Date.now(), publishedAt: Date.now() - 500, sourceClientId: "host-1" },
  "host-1",
);
ok("把房主的快照投递给了听众", delivered);
await settle(600);

const mcpCalls = state.requests.filter((r) => r.url.includes(`${MCP_PORT}/mcp`));
const toolCall = mcpCalls.find((r) => r.body?.method === "tools/call");
ok("调用了 MCP", mcpCalls.length > 0);
check("调的是 play_track", toolCall?.body?.params?.name, "play_track");
check("传的是房主的那条 Track", [toolCall?.body?.params?.arguments?.track?.id, toolCall?.body?.params?.arguments?.track?.source], ["347230", "netease"]);
ok("带上了 X-MCP-Key", mcpCalls.every((r) => r.headers["X-MCP-Key"] === settings.mcpKey));

const initCall = mcpCalls.find((r) => r.body?.method === "initialize");
ok("先做了 initialize 握手", Boolean(initCall));
ok("tools/call 带上了会话 ID", toolCall?.headers["mcp-session-id"] === "session-1");

/* ── 5. 大家都可以调 ───────────────────────────────────────────────────────── */

console.log("\n[5] 「大家都可以调」：听众一动手就接管");

await boot({ controlMode: "all" }, "guest");
ok("加入时按设置声明了 all 模式", state.requests.some((r) => r.url.endsWith("/join") && r.body.controlMode === "all"));

state.requests.length = 0;
state.events.trackChange({ track: LOCAL_TRACK });
await settle(200);

const takeover = state.requests.filter((r) => r.url.endsWith("/publish"));
ok("听众动手后上报了（抢到控制权）", takeover.length > 0);
check("上报的是本机这首歌", takeover[0]?.body?.playback?.track?.id, "local-1");

// 反过来：跟随别人时本机也会变化，那种变化不能再报回去，否则两个人会互相抢
console.log("\n[6] 跟随别人造成的变化不会被当成「本机动手」报回去");

await boot({ controlMode: "all", enableMcpControl: true, mcpKey: "0123456789abcdef0123456789abcdef" }, "guest");
state.requests.length = 0;
deliverPoll(
  { track: HOST_TRACK, playing: true, position: 4000, seq: 7, clientTime: Date.now(), publishedAt: Date.now(), sourceClientId: "someone-else" },
  "someone-else",
);
await settle(700);

const echoes = state.requests.filter((r) => r.url.endsWith("/publish"));
check("跟随之后没有把状态报回去（没有回声）", echoes.length, 0);

// 这一条是「控制者会漂移」的根子：跟随别人的时候，播放中会不断收到歌词行进事件，
// 而歌词行进只是时间流逝，不是「我动手了」——如果把它也算成本机操作，
// 听众每隔几秒就会把控制权从别人手里抢过来，控制者就在成员之间来回跳。
console.log("\n[6.1] 歌词行进不能抢走控制权");

state.requests.length = 0;
// 跟随切歌会抑制 5 秒，等它彻底过去，模拟「歌已经正常放着」的那段时间
await settle(5_500);
state.events.lineChange({ index: 3, position: 9_000 });
await settle(300);

check(
  "听众的歌词行进不会上报（控制者没被抢走）",
  state.requests.filter((r) => r.url.endsWith("/publish")).length,
  0,
);

// 反过来：真正动手（换歌）还是要能抢过来
state.requests.length = 0;
state.events.trackChange({ track: LOCAL_TRACK });
await settle(300);
check(
  "但真的换歌仍然能接管",
  state.requests.filter((r) => r.url.endsWith("/publish")).length > 0,
  true,
);

/* ── 6.2 本地暂停 ─────────────────────────────────────────────────────────── */

console.log("\n[6.2] 本地暂停：只停自己，继续播放时追上");

await boot({ localPause: true }, "guest");
state.events.trackChange({ track: HOST_TRACK });
state.events.playStateChange({ state: "playing", position: 60_000 });
await settle(200);

/** 房间里别人在放同一首歌 */
const othersPlaying = (position) => ({
  track: HOST_TRACK,
  playing: true,
  position,
  seq: 20,
  clientTime: Date.now(),
  publishedAt: Date.now(),
  sourceClientId: "someone-else",
});

// 本机按下暂停
state.logs.length = 0;
state.events.playStateChange({ state: "paused", position: 61_000 });
await settle(200);
ok(
  "本机暂停后进入脱离状态",
  state.logs.some((line) => String(line[1]).includes("暂时脱离")),
);

// 别人还在放，但不该把我拉回去
state.logs.length = 0;
state.requests.length = 0;
deliverPoll(othersPlaying(90_000), "someone-else");
await settle(400);
check(
  "脱离期间不会被别人拉回播放",
  state.logs.filter((line) => line[0] === "player" && String(line[1]).startsWith("seek")).length,
  0,
);
check(
  "脱离期间也不上报",
  state.requests.filter((r) => r.url.endsWith("/publish")).length,
  0,
);

// 本机按下继续 → 跳到大家此刻的进度
state.logs.length = 0;
state.events.playStateChange({ state: "playing", position: 61_000 });
await settle(400);
const seekLine = state.logs.find(
  (line) => line[0] === "player" && String(line[1]).startsWith("seek"),
);
ok("继续播放时跳到了大家的进度", Boolean(seekLine));
if (seekLine) {
  const target = Number(String(seekLine[1]).replace("seek ", ""));
  ok(
    `跳转位置约等于对方的进度（${Math.round(target / 1000)}s，对方 90s）`,
    target >= 88_000 && target <= 92_000,
  );
}

/* ── 7. 重连不会让循环越攒越多 ─────────────────────────────────────────────── */

console.log("\n[7] 重连：连改设置不会把轮询循环越攒越多");

await boot({}, "host");
ok("启动后挂上了一个长轮询", state.pendingPolls.length === 1);

state.requests.length = 0;

// 模拟在「昵称」输入框里连敲 8 个字符，每敲一下都会触发一次设置变更
for (let index = 0; index < 8; index += 1) {
  settings.nickname = `昵称${index}`;
  state.handlers["setting:nickname"]();
}
check("去抖期间没有立刻重连", state.requests.filter((r) => r.url.endsWith("/join")).length, 0);

await settle(1_500);
check("连敲 8 次最后只重连一次", state.requests.filter((r) => r.url.endsWith("/join")).length, 1);

// 关键一步：把之前挂着的长轮询全部放掉。
// 修复前，旧循环会在这里「复活」—— 它只认 running，而 running 已经被新的一轮置回 true，
// 于是又多出一个订阅循环，每重连一次就多一个。
const released = releasePolls();
ok(`放掉了 ${released} 个挂起的长轮询`, released >= 2);
await settle(400);

check(
  "旧循环被作废了（没有多出第二个轮询）",
  state.pendingPolls.length,
  1,
);
check(
  "旧循环也没有再抢着 join",
  state.requests.filter((r) => r.url.endsWith("/join")).length,
  1,
);

/* ── 8. 菜单 ───────────────────────────────────────────────────────────────── */

console.log("\n[8] 菜单处理器");

// 固定成「大家都可以调」，好让「切换控制模式」有确定的切法（→ 只有房主可调）
await boot({ controlMode: "all" }, "host");

const statusResult = await state.handlers.menuClick({ menuId: "status", track: HOST_TRACK });
ok("「状态」返回了 toast", typeof statusResult?.toast === "string" && statusResult.toast.length > 0);
console.log(`    → ${statusResult.toast}`);

state.requests.length = 0;
const modeResult = await state.handlers.menuClick({ menuId: "toggle-mode", track: HOST_TRACK });
const modeCall = state.requests.find((r) => r.url.endsWith("/mode"));
check("「切换控制模式」调了 /mode", modeCall?.body?.mode, "host");
ok("「切换控制模式」返回了 toast", typeof modeResult?.toast === "string");
console.log(`    → ${modeResult.toast}`);

const openResult = await state.handlers.menuClick({ menuId: "open-room", track: HOST_TRACK });
check("「打开房间页面」指向房间 URL", openResult?.openUrl, `${SERVER}/room/${ROOM}`);

const copyResult = await state.handlers.menuClick({ menuId: "copy-room", track: HOST_TRACK });
ok("「复制房间链接」返回了文本", typeof copyResult?.copyText === "string");

console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项未通过 ✗`}\n`);
process.exit(failures === 0 ? 0 : 1);
