/**
 * 端到端演练：用两个假客户端跑一遍「一起听」的完整流程。
 *
 * 它扮演的是插件那一侧（同样的 HTTP 调用顺序、同样的长轮询），
 * 用来在没有 SPlayer 的情况下验证服务端行为：
 *
 *   node scripts/simulate.mjs [服务端地址] [房间ID]
 *
 * 本地服务端带 SERVER_KEY 的话，会从 .env.local 里读出来自动带上，
 * 也可以用 SERVER_KEY=xxx 覆盖。
 *
 * 预期结果：房主换歌 / 暂停 / 拖进度后，听众端都在 1 秒内收到对应目标状态。
 */

import { loadLocalEnv, serverKeyFromEnv, serverUrlFromEnv } from "./lib/env.mjs";

loadLocalEnv();

const BASE = (process.argv[2] || serverUrlFromEnv()).replace(/\/+$/, "");
const KEY = serverKeyFromEnv();
// 默认每轮换一个房间，避免上一轮的成员还在 TTL 内影响断言
const ROOM = process.argv[3] || `sim-${Date.now().toString(36)}`;

/** 带上密钥的请求头 */
const authHeaders = () => (KEY ? { "X-Server-Key": KEY } : {});

const call = async (path, body, timeout = 30_000) => {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
};

/** 发一个 GET（health 之外都要带密钥） */
const getJson = (path) =>
  fetch(`${BASE}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(5_000) }).then(
    (response) => response.json(),
  );

const track = (id, title, duration = 240_000) => ({
  id,
  source: "netease",
  title,
  artists: [{ id: "6452", name: "测试歌手" }],
  album: { id: "1", name: "测试专辑" },
  duration,
  cover: "https://p1.music.126.net/example.jpg",
});

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok ? "" : `（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`}`);
};

/** 断言一个布尔条件（有些事只关心真伪，不关心具体值） */
const ok = (label, condition) => {
  if (!condition) failures += 1;
  console.log(`  ${condition ? "✓" : "✗"} ${label}`);
};

const client = (name) => {
  const state = { clientId: null, hostToken: null, isHost: false, version: 0, room: null };
  return {
    name,
    state,
    async join(role) {
      const result = await call(`/api/room/${ROOM}/join`, {
        clientId: state.clientId,
        name,
        role,
        hostToken: state.hostToken,
      });
      if (result.status !== 200) throw new Error(`join 失败：${JSON.stringify(result.body)}`);
      state.clientId = result.body.clientId;
      state.isHost = result.body.isHost;
      if (result.body.hostToken) state.hostToken = result.body.hostToken;
      state.version = result.body.room.version;
      state.room = result.body.room;
      return result.body;
    },
    publish(playback, seqOverride) {
      state.seq = (state.seq || 0) + 1;
      const seq = typeof seqOverride === "number" ? seqOverride : state.seq;
      if (seq > state.seq) state.seq = seq;
      return call(`/api/room/${ROOM}/publish`, {
        clientId: state.clientId,
        hostToken: state.hostToken,
        playback: { ...playback, seq, clientTime: Date.now() },
      });
    },
    async poll(wait = 3_000) {
      const result = await call(`/api/room/${ROOM}/poll`, {
        clientId: state.clientId,
        name,
        since: state.version,
        wait,
      });
      if (result.status !== 200) throw new Error(`poll 失败：${JSON.stringify(result.body)}`);
      state.version = result.body.room.version;
      state.room = result.body.room;
      return result.body;
    },
    setMode(mode) {
      return call(`/api/room/${ROOM}/mode`, {
        clientId: state.clientId,
        hostToken: state.hostToken,
        mode,
      });
    },
  };
};

/** 按服务端快照推算「此刻应有的进度」 */
const expectedPosition = (playback, serverTime) => {
  const offset = serverTime - Date.now();
  const elapsed = playback.playing ? Math.max(0, Date.now() + offset - playback.publishedAt) : 0;
  return Math.round(playback.position + elapsed);
};

const main = async () => {
  console.log(`\n服务端 ${BASE}，房间 ${ROOM}\n`);

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  console.log(`健康检查：v${health.version}，存活 ${Math.round(health.uptimeMs / 1000)}s\n`);

  // ── 1. 房主上位 ────────────────────────────────────────────────────────────
  console.log("[1] 房主加入（role=host）");
  const host = client("房主");
  const hostJoin = await host.join("host");
  check("房主拿到了房主位", hostJoin.isHost, true);
  check("服务端下发了房主令牌", typeof hostJoin.hostToken, "string");

  // ── 2. 听众加入 ────────────────────────────────────────────────────────────
  console.log("\n[2] 听众加入（role=auto，房主在位 → 只能是听众）");
  const guest = client("听众");
  const guestJoin = await guest.join("auto");
  check("听众没拿到房主位", guestJoin.isHost, false);
  check("房间里有 2 个人", guestJoin.room.members.length, 2);

  // ── 3. 房主上报，听众长轮询收到 ───────────────────────────────────────────
  console.log("\n[3] 房主开始播放《歌 A》，听众长轮询应立刻被唤醒");
  const pollPromise = guest.poll(5_000);
  await new Promise((resolve) => setTimeout(resolve, 150)); // 确保听众先挂上长轮询
  const startedAt = Date.now();
  await host.publish({ track: track("1001", "歌 A"), playing: true, position: 0 });
  const received = await pollPromise;
  const latency = Date.now() - startedAt;
  check("听众收到的是「有新内容」", received.changed, true);
  check("曲目对上了", received.room.playback.track.title, "歌 A");
  check("播放态对上了", received.room.playback.playing, true);
  console.log(`  · 传播延迟 ${latency}ms`);
  if (latency > 2_000) { failures += 1; console.log("  ✗ 延迟超过 2 秒"); }

  // ── 4. 进度推算 ────────────────────────────────────────────────────────────
  console.log("\n[4] 让房主播放 1.5 秒，听众推算的进度应该也前进了约 1.5 秒");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const afterPoll = await guest.poll(500);
  const estimated = expectedPosition(afterPoll.room.playback, afterPoll.serverTime);
  console.log(`  · 房主上报 0ms，听众推算到 ${estimated}ms`);
  if (estimated < 1_200 || estimated > 2_400) { failures += 1; console.log("  ✗ 推算偏差过大"); }
  else console.log("  ✓ 推算在合理范围内");

  // ── 5. 暂停 ────────────────────────────────────────────────────────────────
  console.log("\n[5] 房主暂停，听众应看到 playing=false");
  await host.publish({ track: track("1001", "歌 A"), playing: false, position: 1_800 });
  const paused = await guest.poll(3_000);
  check("播放态变为暂停", paused.room.playback.playing, false);
  check("停在 1800ms", paused.room.playback.position, 1_800);

  // ── 6. 换歌 ────────────────────────────────────────────────────────────────
  console.log("\n[6] 房主换到《歌 B》");
  await host.publish({ track: track("1002", "歌 B", 180_000), playing: true, position: 0 });
  const switched = await guest.poll(3_000);
  check("听众看到了新曲目", switched.room.playback.track.title, "歌 B");
  check("整条 Track 都传过来了（source/id 可用于 play_track）",
    [switched.room.playback.track.source, switched.room.playback.track.id], ["netease", "1002"]);

  // ── 7. 乱序快照被丢弃 ──────────────────────────────────────────────────────
  console.log("\n[7] 房主补发一个序号更小的过期快照，服务端应当拒绝");
  const stale = await host.publish({ track: track("9999", "旧快照"), playing: false, position: 0 }, 1);
  check("过期快照未被接受", stale.body.accepted, false);
  check("拒绝原因是序号过期", stale.body.reason, "stale-seq");
  const afterStale = await guest.poll(300);
  check("听众看到的仍是《歌 B》", afterStale.room.playback.track.title, "歌 B");

  // ── 8. 听众不能上报 ────────────────────────────────────────────────────────
  console.log("\n[8] 听众尝试上报，服务端应当拒绝（只有房主有话语权）");
  const rejected = await guest.publish({ track: track("1003", "听众的歌"), playing: true, position: 0 });
  check("听众的上报未被接受", rejected.body.accepted, false);
  check("拒绝原因是身份不对", rejected.body.reason, "host-only");

  // ── 9. 控制模式：默认「只有房主可调」 ──────────────────────────────────────
  console.log("\n[9] 控制模式：房间默认是「只有房主可调」，且只有房主能改");
  const fresh = await guest.poll(300);
  check("默认模式", fresh.room.controlMode, "host");
  // 房主前面已经上报过，所以控制者位是他的；听众即使上报被拒也不会抢到
  check("控制者是房主（听众被拒后没抢到）", fresh.room.driverClientId, host.state.clientId);

  const guestMode = await guest.setMode("all");
  check("听众改模式被拒绝", guestMode.body.accepted, false);
  check("拒绝原因是身份不对", guestMode.body.reason, "host-only");

  const hostMode = await host.setMode("all");
  check("房主改模式成功", hostMode.body.accepted, true);
  check("模式已变成 all", hostMode.body.mode, "all");

  // ── 10. 「大家都可以调」 ───────────────────────────────────────────────────
  console.log("\n[10] 大家都可以调：听众一动手就接管，房主也能继续调");
  const guestTake = await guest.publish({ track: track("2001", "听众点的歌"), playing: true, position: 0 });
  check("听众的上报被接受了", guestTake.body.accepted, true);

  const afterTake = await host.poll(300);
  check("控制者换成了听众", afterTake.room.driverClientId, guest.state.clientId);
  check("听众看到的曲目来自听众", afterTake.room.playback.track.title, "听众点的歌");
  check("房主身份没有被顶掉（只是控制权换了人）", afterTake.room.hostClientId, host.state.clientId);

  const hostBack = await host.publish({ track: track("2002", "房主又换了一首"), playing: true, position: 0 });
  check("房主也能调（all 模式下谁都可以）", hostBack.body.accepted, true);
  const afterBack = await guest.poll(300);
  check("控制者又回到房主", afterBack.room.driverClientId, host.state.clientId);

  // 切回「只有房主可调」，并检查控制者位是否被收回
  await guest.publish({ track: track("2003", "听众最后一首"), playing: true, position: 0 });
  const backToHostMode = await host.setMode("host");
  check("切回 host 模式", backToHostMode.body.mode, "host");
  const afterSwitch = await guest.poll(300);
  check("切回后听众不再占据控制者位", afterSwitch.room.driverClientId, null);

  const blocked = await guest.publish({ track: track("2004", "听众还想调"), playing: true, position: 0 });
  check("切回后听众的上报又被拒绝了", blocked.body.accepted, false);
  check("拒绝原因", blocked.body.reason, "host-only");

  // ── 11. 房主交接 ────────────────────────────────────────────────────────────
  console.log("\n[11] 听众显式要求当房主（role=host）→ 顶掉现任，旧的房主随即失去话语权");
  const taken = await guest.join("host");
  check("听众拿到了房主位", taken.isHost, true);
  check("服务端下发了新的房主令牌", typeof taken.hostToken, "string");

  const guestPublish = await guest.publish({ track: track("1004", "换人之后的歌"), playing: true, position: 0 });
  check("新房主可以上报", guestPublish.body.accepted, true);

  const hostPublish = await host.publish({ track: track("1005", "旧房主的歌"), playing: true, position: 0 });
  check("旧房主的上报被拒绝", hostPublish.body.accepted, false);
  check("拒绝原因是身份不对", hostPublish.body.reason, "host-only");

  // ── 12. 成员列表 ────────────────────────────────────────────────────────────
  console.log("\n[12] 成员与房主标识");
  const finalRoom = await guest.poll(300);
  const hostMember = finalRoom.room.members.find((m) => m.clientId === finalRoom.room.hostClientId);
  check("新房主在成员列表里", Boolean(hostMember), true);
  check("房主名字正确", hostMember && hostMember.name, "听众");
  check("成员数", finalRoom.room.members.length, 2);
  check("当前曲目是交接后上报的那首", finalRoom.room.playback.track.title, "换人之后的歌");

  // ── 13. 房间列表（首页靠它列出有哪些房间）────────────────────────────────
  console.log("\n[13] 房间列表：首页靠它列出有哪些房间");
  const listed = await getJson("/api/rooms");
  const mine = listed.rooms.find((item) => item.roomId === ROOM);
  ok("列表里有这个房间", Boolean(mine));
  check("带上了成员数", mine?.members, 2);
  check("带上了控制模式", mine?.controlMode, "host");
  check("带上了正在播放的曲目摘要", mine?.nowPlaying?.title, "换人之后的歌");
  check("带上了艺人", mine?.nowPlaying?.artists, ["测试歌手"]);
  check("带上了播放态", mine?.playing, true);

  // ── 14. 共享队列 ───────────────────────────────────────────────────────────
  console.log("\n[14] 共享队列：大家的「下一首」从同一份来");

  const queuePost = (body) =>
    fetch(`${BASE}/api/room/${ROOM}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    }).then((response) => response.json());

  // 此时 guest 是房主、host 已经变成听众
  const added = await queuePost({
    clientId: host.state.clientId,
    action: "add",
    tracks: [track("5001", "队列甲"), track("5002", "队列乙")],
  });
  check("谁都可以往队列里加歌（点歌）", added.changed, 2);
  check("队列里有两首", added.queue.length, 2);
  check("顺序就是入队顺序", added.queue.map((entry) => entry.track.title), ["队列甲", "队列乙"]);

  const duplicate = await queuePost({
    clientId: host.state.clientId,
    action: "add",
    tracks: [track("5001", "队列甲")],
  });
  check("同一首歌不会重复入队", duplicate.changed, 0);

  const withQueue = await guest.poll(300);
  check("快照里带上了队列长度", withQueue.room.queueLength, 2);
  check("也带上了队列版本", typeof withQueue.room.queueVersion, "number");

  const fetchedQueue = await getJson(`/api/room/${ROOM}/queue`);
  check("队列内容单独拉得到", fetchedQueue.queue.length, 2);

  const denied = await queuePost({
    clientId: host.state.clientId,
    action: "remove",
    entryId: added.queue[0].id,
  });
  check("「只有房主可调」模式下听众删不掉", denied.ok, false);
  check("拒绝码", denied.code, "NOT_ALLOWED");

  const removed = await queuePost({
    clientId: guest.state.clientId,
    hostToken: guest.state.hostToken,
    action: "remove",
    entryId: added.queue[0].id,
  });
  check("控制者可以删", removed.changed, 1);
  check("删完只剩一首", removed.queue.length, 1);

  const cleared = await queuePost({
    clientId: guest.state.clientId,
    hostToken: guest.state.hostToken,
    action: "clear",
  });
  check("控制者可以清空", cleared.changed, 1);
  check("清空后队列是空的", cleared.queue.length, 0);
};

/**
 * 起一个临时服务端（另一个端口），返回 { base, stop }。
 *
 * 用于需要非默认配置的用例（短成员超时、开服务端密钥），
 * 跑完自己关掉，不影响前面那些用默认配置的断言。
 */
const startTempServer = async (port, env) => {
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const base = `http://127.0.0.1:${port}`;

  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "..", "server", "src", "index.ts")],
    {
      env: {
        ...process.env,
        // 端口由参数决定，别让子进程去抢主服务端的端口
        PORT: String(port),
        // 显式清掉，免得从当前 shell 继承到密钥把用例搞乱
        SERVER_KEY: "",
        ROOM_KEY: "",
        ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])),
      },
      stdio: "ignore",
    },
  );

  const stop = () => {
    try {
      child.kill();
    } catch {
      /* 已经退了 */
    }
  };

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) {
        return { base, stop };
      }
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  stop();
  return null;
};

/**
 * [15] 超时释放：房主 / 控制者掉线后，位子要腾出来，别让房间卡死。
 *
 * 这一步需要很短的成员超时，所以自己拉一个临时服务端。
 */
const timeoutScenario = async () => {
  console.log("\n[15] 超时释放：房主/控制者掉线后位子腾出来");

  const server = await startTempServer(8799, { MEMBER_TTL_MS: 1200 });
  if (!server) {
    failures += 1;
    console.log("  ✗ 临时服务端没起来，跳过");
    return;
  }
  const { base, stop } = server;
  const room = `ttl-${Date.now().toString(36)}`;

  try {
    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      return response.json();
    };

    const a = await post(`/api/room/${room}/join`, { name: "甲", role: "host" });
    const b = await post(`/api/room/${room}/join`, { name: "乙", role: "auto" });
    check("甲拿到房主位", a.isHost, true);
    check("乙是听众", b.isHost, false);

    await post(`/api/room/${room}/publish`, {
      clientId: a.clientId,
      hostToken: a.hostToken,
      playback: { track: track("3001", "甲的歌"), playing: true, position: 0, seq: 1, clientTime: Date.now() },
    });

    // 甲的成员身份会在这段时间里超时，甲不再发任何请求
    await new Promise((resolve) => setTimeout(resolve, 2_200));

    const seen = await post(`/api/room/${room}/poll`, { clientId: b.clientId, name: "乙", since: 0, wait: 0 });
    check("房主超时后房主位被释放", seen.room.hostClientId, null);
    check("控制者位也释放了", seen.room.driverClientId, null);

    const takeover = await post(`/api/room/${room}/join`, { clientId: b.clientId, name: "乙", role: "host" });
    check("乙顺利接管房主", takeover.isHost, true);

    const bPub = await post(`/api/room/${room}/publish`, {
      clientId: b.clientId,
      hostToken: takeover.hostToken,
      playback: { track: track("3002", "乙的歌"), playing: true, position: 0, seq: 1, clientTime: Date.now() },
    });
    check("接管后能正常上报", bPub.accepted, true);
  } finally {
    stop();
  }
};

/**
 * [16] 服务端密钥：设了之后谁都得带对才能用，陌生人连房间都建不了。
 */
const keyScenario = async () => {
  console.log("\n[16] 服务端密钥：没带或带错都进不来");

  const SECRET = "s3cret-for-test";
  const server = await startTempServer(8801, { SERVER_KEY: SECRET });
  if (!server) {
    failures += 1;
    console.log("  ✗ 临时服务端没起来，跳过");
    return;
  }
  const { base, stop } = server;

  try {
    const call = async (path, body, headers = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    const room = `key-${Date.now().toString(36)}`;
    const joinBody = { name: "陌生人", role: "host" };

    const anonymous = await call(`/api/room/${room}/join`, joinBody);
    check("不带密钥建房间被拒", anonymous.status, 401);
    check("错误码", anonymous.body.code, "SERVER_KEY_REQUIRED");

    const wrong = await call(`/api/room/${room}/join`, joinBody, { "X-Server-Key": "wrong-secret" });
    check("密钥不对也被拒", wrong.status, 401);
    check("长度不同的密钥也不崩（恒定时间比较）", wrong.body.code, "SERVER_KEY_REQUIRED");

    const allowed = await call(`/api/room/${room}/join`, joinBody, { "X-Server-Key": SECRET });
    check("带对密钥（请求头）可以建房间", allowed.status, 200);
    check("建出来的房间是空的", allowed.body.room.playback, null);

    // 浏览器房间页走查询参数（EventSource 设不了请求头）
    const viaQuery = await fetch(`${base}/api/room/${room}?key=${SECRET}`, {
      signal: AbortSignal.timeout(5_000),
    });
    check("带对密钥（查询参数）也能读", viaQuery.status, 200);

    const queryWrong = await fetch(`${base}/api/room/${room}?key=nope`, {
      signal: AbortSignal.timeout(5_000),
    });
    check("查询参数带错同样被拒", queryWrong.status, 401);

    // 探活接口是例外，但设了密钥就不再泄露房间数量
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5_000) });
    check("health 不需要密钥", health.status, 200);
    const healthBody = await health.json();
    check("但不再暴露房间数量", healthBody.rooms, undefined);
    check("仍然给出版本号（探活够用）", typeof healthBody.version, "string");
  } finally {
    stop();
  }
};

/**
 * main() 里那些用例需要一个跑着的服务端。
 *
 * 没跑着就自己起一个 —— 这样 `npm test` 一条命令能跑完，
 * CI 里也不用额外准备一个后台进程。
 */
let ownedServer = null;

const serverIsUp = async () => {
  try {
    const response = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
};

const ensureServer = async () => {
  if (await serverIsUp()) return;
  const port = Number(new URL(BASE).port || 80);
  console.log(`\n${BASE} 上没有服务端，测试自己起一个（端口 ${port}）`);
  ownedServer = await startTempServer(port, {});
  if (!ownedServer) throw new Error(`没能在 ${port} 端口把服务端起来`);
};

const run = async () => {
  try {
    await ensureServer();
    await main();
    await timeoutScenario();
    await keyScenario();
  } catch (error) {
    failures += 1;
    console.error("\n演练中断：", error.message);
  } finally {
    // 自己起的那个记得关掉；本来就有的别去动它
    ownedServer?.stop();
  }
  console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项未通过 ✗`}\n`);
  process.exit(failures === 0 ? 0 : 1);
};

run();
