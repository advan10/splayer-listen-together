/**
 * @name        Listen Together
 * @id          listen-together.splayer
 * @version     0.4.0
 * @description 一起听：把当前播放同步到自建服务端，或跟着房主一起播放（默认网易云）
 * @author      Re-BeiChen
 * @type        control
 * @apiLevel    2
 * @grant       network control ui
 * @changelog   加房间共享队列（可经 MCP 同步到本机播放列表）；修重载后身份重复的问题
 */

/*
 * ─────────────────────────────────────────────────────────────────────────────
 *  一起听 · SPlayer-Next 控制插件
 *
 *  房主（host）：把当前曲目 / 播放态 / 进度上报到服务端。
 *  听众（guest）：订阅服务端状态，对齐播放、暂停与进度；
 *                若开启了「自动跟随切歌」，还能让本机切到房主的歌。
 *
 *  ⚠️ 为什么切歌要绕 MCP：插件 API 只有 play / pause / next / prev / seek /
 *  setVolume，**没有「播放指定曲目」**。唯一能指定曲目的本地入口是
 *  SPlayer-Next 的 MCP 接口（play_track 支持传完整 Track 对象）。
 *  因此自动切歌需要用户在 设置 → AI 集成 → MCP 里开启服务并填入密钥。
 *  没开也不影响其它同步能力。
 * ─────────────────────────────────────────────────────────────────────────────
 */

const VERSION = "0.4.0";

/** 长轮询的服务端等待时长与客户端超时（客户端必须更大，先让服务端开口） */
const POLL_WAIT_MS = 25_000;
const POLL_TIMEOUT_MS = 28_000;
const API_TIMEOUT_MS = 10_000;

/** 事件触发的上报节流：lineChange 每行都来，别每行打一次服务端 */
const PUBLISH_THROTTLE_MS = 2_000;
/** 重连退避 */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const log = splayer.log;

/* ========================================================================== *
 *  设置
 * ========================================================================== */

const SETTING_KEYS = [
  "enabled",
  "serverUrl",
  "serverKey",
  "roomId",
  "roomKey",
  "nickname",
  "role",
  "controlMode",
  "autoFollow",
  "enableMcpControl",
  "mcpPort",
  "mcpKey",
  "syncPlayState",
  "syncSeek",
  "localPause",
  "syncQueue",
  "seekThresholdMs",
  "heartbeatSec",
  "verboseLog",
];

/** 会被读取的当前配置；读取时统一做类型收敛与默认值兜底 */
const settings = {};

const readSettings = () => {
  const get = (key, fallback) => {
    const value = splayer.getSetting(key);
    return value === undefined || value === null ? fallback : value;
  };
  settings.enabled = Boolean(get("enabled", true));
  settings.serverUrl = String(get("serverUrl", "http://127.0.0.1:8788")).replace(/\/+$/, "");
  settings.serverKey = String(get("serverKey", ""));
  settings.roomId = String(get("roomId", "listen-together")).trim() || "listen-together";
  settings.roomKey = String(get("roomKey", ""));
  settings.nickname = String(get("nickname", ""));
  settings.role = String(get("role", "auto"));
  settings.controlMode = get("controlMode", "host") === "all" ? "all" : "host";
  settings.autoFollow = Boolean(get("autoFollow", true));
  settings.enableMcpControl = Boolean(get("enableMcpControl", false));
  settings.mcpPort = Number(get("mcpPort", 14559)) || 14559;
  settings.mcpKey = String(get("mcpKey", ""));
  settings.syncPlayState = Boolean(get("syncPlayState", true));
  settings.syncSeek = Boolean(get("syncSeek", true));
  settings.localPause = Boolean(get("localPause", false));
  settings.syncQueue = Boolean(get("syncQueue", false));
  settings.seekThresholdMs = Number(get("seekThresholdMs", 2000)) || 2000;
  settings.heartbeatSec = Number(get("heartbeatSec", 5)) || 5;
  settings.verboseLog = Boolean(get("verboseLog", false));
};

const debug = (...args) => {
  if (settings.verboseLog) log.info("[一起听]", ...args);
};

splayer.register({
  events: ["trackChange", "playStateChange", "lineChange", "lyricChange"],
  controls: true,
  settings: [
    { key: "enabled", type: "switch", label: "启用一起听", default: true },
    {
      key: "serverUrl",
      type: "text",
      label: "服务端地址",
      default: "http://127.0.0.1:8788",
      description: "自建服务端的根地址，带 http://",
      placeholder: "http://127.0.0.1:8788",
    },
    {
      key: "serverKey",
      type: "text",
      label: "服务端密钥",
      default: "",
      description: "服务端设了 SERVER_KEY 时必填，没设就留空",
      placeholder: "留空表示服务端没设密钥",
    },
    {
      key: "roomId",
      type: "text",
      label: "房间 ID",
      default: "listen-together",
      description: "字母/数字/下划线/连字符，同一个 ID 的人在一个房间",
      placeholder: "listen-together",
    },
    {
      key: "roomKey",
      type: "text",
      label: "房间口令",
      default: "",
      description: "可选。房主设了之后，其他人必须填一样的才能进入",
      placeholder: "留空表示不设口令",
    },
    {
      key: "nickname",
      type: "text",
      label: "昵称",
      default: "",
      description: "显示在房间成员列表里",
      placeholder: "留空自动生成",
    },
    {
      key: "role",
      type: "select",
      label: "角色",
      default: "auto",
      description: "auto：房间里没人当房主时自动顶上",
      options: [
        { label: "自动", value: "auto" },
        { label: "房主（我放什么大家听什么）", value: "host" },
        { label: "听众（跟随房主）", value: "guest" },
      ],
    },
    {
      key: "controlMode",
      type: "select",
      label: "控制模式",
      default: "host",
      description: "创建房间时生效；之后可用「一起听：切换控制模式」菜单改（房主才能改）",
      options: [
        { label: "只有房主可调", value: "host" },
        { label: "大家都可以调", value: "all" },
      ],
    },
    {
      key: "autoFollow",
      type: "switch",
      label: "自动跟随切歌",
      default: true,
      description: "房主换歌时也切过去（需要开启 MCP，见下一项）",
    },
    {
      key: "enableMcpControl",
      type: "switch",
      label: "允许经 MCP 自动切歌",
      default: false,
      description: "在 SPlayer 设置 → AI 集成 → MCP 里开启服务，并填入下方端口与密钥",
    },
    {
      key: "mcpPort",
      type: "number",
      label: "MCP 端口",
      default: 14559,
      min: 1024,
      max: 65535,
      description: "SPlayer 设置里显示的 MCP 服务端口",
    },
    {
      key: "mcpKey",
      type: "text",
      label: "MCP 连接密钥",
      default: "",
      description: "SPlayer 的 MCP 设置页「配置详情」里的 X-MCP-Key",
      placeholder: "粘贴密钥",
    },
    { key: "syncPlayState", type: "switch", label: "同步播放 / 暂停", default: true },
    {
      key: "localPause",
      type: "switch",
      label: "本地暂停不影响别人",
      default: false,
      description: "暂停时只停自己这一份，其他人照常；继续播放时自动追上进度。由你在控时仍会正常同步",
    },
    {
      key: "syncQueue",
      type: "switch",
      label: "同步房间队列",
      default: false,
      description: "把房间队列里新加的歌推进本机播放列表，大家的下一首才会是同一首（需要 MCP）",
    },
    {
      key: "syncSeek",
      type: "switch",
      label: "同步播放进度",
      default: true,
      description: "偏差超过下面的阈值才跳转",
    },
    {
      key: "seekThresholdMs",
      type: "number",
      label: "进度对齐阈值（毫秒）",
      default: 2000,
      min: 300,
      max: 15000,
      description: "调小更同步，但会频繁跳转",
    },
    {
      key: "heartbeatSec",
      type: "number",
      label: "房主上报间隔（秒）",
      default: 5,
      min: 2,
      max: 60,
      description: "没有歌词事件时靠它兜底刷新进度",
    },
    { key: "verboseLog", type: "switch", label: "详细日志", default: false },
  ],
  menus: [
    { id: "status", label: "一起听：状态" },
    { id: "sync-now", label: "一起听：立即同步" },
    { id: "add-queue", label: "一起听：把这首歌加入房间队列" },
    { id: "toggle-mode", label: "一起听：切换控制模式" },
    { id: "take-host", label: "一起听：我当房主" },
    { id: "open-room", label: "一起听：打开房间页面" },
    { id: "copy-room", label: "一起听：复制房间链接" },
  ],
});

/* ========================================================================== *
 *  小工具
 * ========================================================================== */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 大小写不敏感地取一个响应头 */
const pickHeader = (headers, name) => {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      return typeof value === "string" ? value : undefined;
    }
  }
  return undefined;
};

/** 同源同 id 视为同一首歌 */
const sameTrack = (a, b) =>
  Boolean(a && b && a.id === b.id && (a.source || "") === (b.source || ""));

/** 展示用的一行歌曲描述 */
const describe = (track) => {
  if (!track) return "（无）";
  const artists = (track.artists || []).map((artist) => artist.name).join(" / ");
  return `${track.title}${artists ? ` - ${artists}` : ""}`;
};

/** 控制模式的中文名 */
const describeMode = (mode) => (mode === "all" ? "大家都可以调" : "只有房主可调");

const trackKey = (track) => (track ? `${track.source || "?"}:${track.id}` : "");

/* ========================================================================== *
 *  本地播放状态镜像
 *
 *  宿主不会持续推位置（playStateChange 只在状态翻转时来，lineChange 要有歌词），
 *  所以自己按「最后一次已知位置 + 流逝时间」推算。
 * ========================================================================== */

const local = {
  track: null,
  playing: false,
  /** 最近一次已知进度（毫秒） */
  position: 0,
  /** 记录 position 的本地时刻 */
  positionAt: Date.now(),
};

const localPosition = () =>
  local.playing ? local.position + (Date.now() - local.positionAt) : local.position;

const notePosition = (position) => {
  local.position = Math.max(0, Number(position) || 0);
  local.positionAt = Date.now();
};

/* ========================================================================== *
 *  时钟校正
 *
 *  服务端时间戳是进度的唯一基准，本地时钟可能偏，必须换算。
 * ========================================================================== */

let clockOffset = 0;
let clockSynced = false;

const syncClock = (serverTime, sentAt) => {
  if (typeof serverTime !== "number") return;
  const receivedAt = Date.now();
  const roundTrip = receivedAt - sentAt;
  const sample = serverTime + roundTrip / 2 - receivedAt;
  // 首次直接采用，之后做低通滤波，避免单次抖动把估算带偏
  clockOffset = clockSynced ? clockOffset * 0.7 + sample * 0.3 : sample;
  clockSynced = true;
};

const serverNow = () => Date.now() + clockOffset;

/* ========================================================================== *
 *  服务端客户端
 * ========================================================================== */

const session = {
  clientId: null,
  hostToken: null,
  isHost: false,
  /** 房间的控制模式：host（只有房主可调）/ all（大家都可以调） */
  controlMode: "host",
  /** 当前控制者；all 模式下谁最后被接受谁就是它 */
  driverClientId: null,
  /** 已见到的房间版本号 */
  version: 0,
  /** 服务端返回的最新房间快照 */
  latest: null,
  joined: false,
  /** 最近一次失败原因，供「状态」菜单展示 */
  lastError: null,
};

/** 把服务端快照里的会话相关字段同步过来 */
const adoptRoom = (room) => {
  if (!room) return;
  session.controlMode = room.controlMode === "all" ? "all" : "host";
  session.driverClientId = room.driverClientId || null;
};

/**
 * 本次会话内强制使用的角色，覆盖设置里的值。
 * 「我当房主」菜单靠它生效 —— 设置里如果是「自动」，
 * 直接在 join 时改 settings 会被 readSettings() 冲掉。
 */
let forcedRole = null;

/** 调一次我们自己的服务端；网络错误不抛，统一返回 { ok, status, body, error } */
const api = async (path, body, timeout = API_TIMEOUT_MS, method = "POST") => {
  const sentAt = Date.now();
  try {
    const response = await splayer.request(`${settings.serverUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Client": `splayer-plugin/${VERSION}`,
        ...(settings.serverKey ? { "X-Server-Key": settings.serverKey } : {}),
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      responseType: "json",
      timeout,
    });
    const payload = response.body;
    if (payload && typeof payload.serverTime === "number") syncClock(payload.serverTime, sentAt);
    if (response.status < 200 || response.status >= 300) {
      return { ok: false, status: response.status, body: payload, error: describeError(payload) };
    }
    return { ok: true, status: response.status, body: payload };
  } catch (error) {
    return { ok: false, status: 0, error: error && error.message ? error.message : String(error) };
  }
};

const describeError = (payload) => {
  if (payload && typeof payload === "object" && typeof payload.error === "string") return payload.error;
  return "服务端返回错误";
};

/** 加入（或重新加入）房间 */
const joinRoom = async () => {
  const result = await api(`/api/room/${encodeURIComponent(settings.roomId)}/join`, {
    clientId: session.clientId || undefined,
    name: settings.nickname || undefined,
    role: forcedRole || settings.role,
    key: settings.roomKey || undefined,
    hostToken: session.hostToken || undefined,
    // 只在房间刚被创建时生效，之后靠「切换控制模式」菜单
    controlMode: settings.controlMode,
    roomName: settings.nickname || undefined,
  });

  if (!result.ok) {
    // 口令错误是配置问题，重试也没用，标记出来让状态菜单能说清楚
    session.lastError =
      result.status === 401
        ? "服务端密钥不正确（或服务端要求填密钥）"
        : result.status === 403
          ? "房间口令不正确"
          : result.error || "无法连接服务端";
    return false;
  }

  const body = result.body;
  session.clientId = body.clientId;
  session.isHost = Boolean(body.isHost);
  // 身份要留住：只存在内存里的话，插件一重载就会以新身份重新加入，
  // 旧的成员记录要等超时才消失，中间这段时间同一个人会显示成两个成员
  void splayer.storage.set("clientId", body.clientId).catch(() => {});
  void splayer.storage.set("roomId", settings.roomId).catch(() => {});
  if (typeof body.hostToken === "string") {
    session.hostToken = body.hostToken;
    // 房主令牌同理，丢了每次开应用都会重新抢一次房主位
    void splayer.storage.set("hostToken", body.hostToken).catch(() => {});
  }
  session.version = body.room ? body.room.version : 0;
  session.latest = body.room || null;
  adoptRoom(body.room);
  session.joined = true;
  session.lastError = null;
  log.info(
    `[一起听] 已加入房间 ${settings.roomId}（${session.isHost ? "房主" : "听众"}，${
      session.controlMode === "all" ? "大家都可以调" : "只有房主可调"
    }），成员 ${body.room ? body.room.members.length : 0} 人`,
  );
  return true;
};

/* ========================================================================== *
 *  上报资格
 *
 *  host 模式：只有房主有话语权，其他人在本地怎么点都不会影响房间。
 *  all  模式：谁动手谁接管 —— 这正是「大家都可以调」的含义。
 *             但跟随别人时本机也会变，那种变化不能再报回去，
 *             否则两个人会互相抢（A 跟随 B 后又把 B 顶掉，无限循环）。
 * ========================================================================== */

/** 有没有资格持续上报（心跳用）：all 模式下只有在控的人 / 无人控时才接手 */
const canReport = () => {
  if (!settings.enabled || !session.joined) return false;
  // 本地暂停期间谁也别报：否则会把自己的「暂停」变成全房间的暂停
  if (detached) return false;
  if (session.controlMode === "host") return session.isHost;
  if (session.driverClientId === session.clientId) return true;
  return session.driverClientId === null && Boolean(local.track);
};

/**
 * 本地动作能不能上报（事件用）：all 模式下任何人都能靠动手抢到控制权。
 *
 * 注意「动手」指的是换歌、播放、暂停这类**决定**。
 * 歌词行进（lineChange）不算 —— 那只是时间流逝，跟随别人时也一直在发生。
 * 早先把两者混在一起，听众每隔几秒就会把控制权从别人手里抢走，
 * 控制者在成员之间来回漂（见 issue #1）。
 */
const canReportIntent = () => {
  if (!settings.enabled || !session.joined) return false;
  if (detached) return false;
  if (isSuppressed()) return false;
  if (session.controlMode === "host") return session.isHost;
  return true;
};

/** 上报一次播放快照 */
let publishSeq = 0;
let lastPublishAt = 0;
let publishPending = false;
let suppressPublishUntil = 0;

/**
 * 在接下来一段时间内不要上报。
 *
 * 用于「这是跟随别人产生的变化，不是本机用户的操作」的场合。
 */
const suppressPublish = (ms = 2_000) => {
  suppressPublishUntil = Math.max(suppressPublishUntil, Date.now() + ms);
};

const isSuppressed = () => Date.now() < suppressPublishUntil;

const sendPublish = async (positionOverride) => {
  const position =
    typeof positionOverride === "number" ? positionOverride : localPosition();
  publishSeq += 1;
  lastPublishAt = Date.now();

  const result = await api(`/api/room/${encodeURIComponent(settings.roomId)}/publish`, {
    clientId: session.clientId,
    hostToken: session.hostToken || undefined,
    playback: {
      track: local.track,
      playing: local.playing,
      position: Math.round(position),
      seq: publishSeq,
      clientTime: Date.now(),
    },
  });

  if (!result.ok) {
    debug("上报失败：", result.error);
    return;
  }
  if (!result.body.accepted) {
    debug("服务端拒绝了这次上报：", result.body.reason);
    // 身份/模式和本地认知对不上了（例如房主位被顶掉、模式被改回 host），
    // 重新走一次 join 把身份弄清楚
    if (result.body.reason === "host-only") {
      session.isHost = false;
      session.joined = false;
    }
  }
};

/** 心跳 / 兜底上报：只有在控的人报 */
const publishHeartbeat = async (positionOverride) => {
  if (!canReport()) return;
  await sendPublish(positionOverride);
};

/**
 * 节流上报。
 *
 * @param options.force    跳过节流（播放/暂停、换歌要立刻反映出去）
 * @param options.asIntent 算不算「本机动手」—— 只有动手才能抢控制权，
 *                         歌词行进这类进度更新不能
 */
const publishThrottled = ({ force = false, asIntent = false } = {}) => {
  const allowed = () => (asIntent ? canReportIntent() : canReport());
  if (!allowed()) return;
  if (publishPending) return;
  const elapsed = Date.now() - lastPublishAt;
  if (force || elapsed >= PUBLISH_THROTTLE_MS) {
    void sendPublish();
    return;
  }
  publishPending = true;
  setTimeout(() => {
    publishPending = false;
    if (!allowed()) return;
    void sendPublish();
  }, PUBLISH_THROTTLE_MS - elapsed);
};

/* ========================================================================== *
 *  MCP 客户端（自动切歌的唯一入口）
 *
 *  SPlayer 内置 MCP 是 Streamable HTTP：先 initialize 拿 mcp-session-id，
 *  之后每个请求都带上它 + X-MCP-Key。会话是复用的，掉了就重开。
 * ========================================================================== */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const mcp = {
  sessionId: null,
  protocolVersion: PROTOCOL_VERSIONS[0],
  nextId: 1,

  get configured() {
    return settings.enableMcpControl && settings.mcpPort > 0 && Boolean(settings.mcpKey);
  },

  reset() {
    this.sessionId = null;
  },

  /** 把 SSE 或纯 JSON 的响应体都解析成对象 */
  parse(body) {
    if (typeof body !== "string") return body;
    const text = body.trim();
    if (!text) return null;
    if (text.startsWith("{")) {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    // text/event-stream：取第一个 data: 行
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch {
        /* 继续找下一行 */
      }
    }
    return null;
  },

  async request(message, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-MCP-Key": settings.mcpKey,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    if (options.version) headers["mcp-protocol-version"] = options.version;

    const payload =
      options.notification
        ? { jsonrpc: "2.0", method: message.method, params: message.params }
        : { jsonrpc: "2.0", id: this.nextId++, method: message.method, params: message.params };

    const response = await splayer.request(`http://127.0.0.1:${settings.mcpPort}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      responseType: "text",
      timeout: 8000,
    });

    return {
      status: response.status,
      sessionId: pickHeader(response.headers, "mcp-session-id"),
      payload: this.parse(response.body),
    };
  },

  /** 建立会话；返回是否可用 */
  async ensureSession() {
    if (!this.configured) return false;
    if (this.sessionId) return true;

    for (const version of PROTOCOL_VERSIONS) {
      try {
        const result = await this.request(
          {
            method: "initialize",
            params: {
              protocolVersion: version,
              capabilities: {},
              clientInfo: { name: "splayer-listen-together", version: VERSION },
            },
          },
          { version },
        );
        if (result.status === 401) {
          session.lastError = "MCP 密钥不正确";
          return false;
        }
        if (result.status >= 200 && result.status < 300 && result.sessionId) {
          this.sessionId = result.sessionId;
          this.protocolVersion = version;
          await this.request(
            { method: "notifications/initialized" },
            { version, notification: true },
          );
          debug("MCP 会话已建立，协议版本", version);
          return true;
        }
      } catch (error) {
        debug("MCP 握手失败：", error && error.message);
      }
    }
    return false;
  },

  /** 调用一个 MCP 工具，返回 { ok, message } */
  async callTool(name, args) {
    if (!(await this.ensureSession())) return { ok: false, message: "MCP 未配置或未开启" };

    const invoke = () =>
      this.request(
        { method: "tools/call", params: { name, arguments: args } },
        { version: this.protocolVersion },
      );

    let result;
    try {
      result = await invoke();
    } catch (error) {
      return { ok: false, message: (error && error.message) || "MCP 请求失败" };
    }

    // 会话被回收（服务端最多留 8 个、空闲 30 分钟）→ 重开一次再试
    if (result.status === 404 || !result.payload) {
      this.reset();
      try {
        result = await invoke();
      } catch (error) {
        return { ok: false, message: (error && error.message) || "MCP 请求失败" };
      }
    }

    if (result.status === 401) return { ok: false, message: "MCP 密钥不正确" };
    if (result.status < 200 || result.status >= 300) {
      return { ok: false, message: `MCP 返回 ${result.status}` };
    }

    const payload = result.payload;
    if (payload && payload.error) {
      return { ok: false, message: payload.error.message || "MCP 调用出错" };
    }
    const toolResult = payload && payload.result;
    if (toolResult && toolResult.isError) {
      const text = (toolResult.content || [])
        .map((item) => (item && item.text) || "")
        .join(" ")
        .trim();
      return { ok: false, message: text || "MCP 工具执行失败" };
    }
    return { ok: true };
  },

  /** 让本机播放指定曲目（整条 Track 原样交给 play_track） */
  async playTrack(track) {
    if (!track || typeof track.id !== "string") return { ok: false, message: "曲目缺少 id" };
    const result = await this.callTool("play_track", { track });
    if (!result.ok) log.warn("[一起听] 自动切歌失败：", result.message);
    else log.info("[一起听] 已切到：", describe(track));
    return result;
  },
};

/* ========================================================================== *
 *  跟随逻辑
 * ========================================================================== */

/** 切歌是异步加载的，等宿主真正切过去之后再对齐进度 */
let pendingFollow = null;

/** 同一首歌的提示只打一次，避免刷屏 */
let lastNoticeKey = "";
const noticeOnce = (key, ...args) => {
  if (lastNoticeKey === key) return;
  lastNoticeKey = key;
  log.info("[一起听]", ...args);
};

/** 由发布快照推算「此刻应有的进度」 */
const expectedPosition = (playback) => {
  const elapsed = playback.playing ? Math.max(0, serverNow() - playback.publishedAt) : 0;
  return playback.position + elapsed;
};

/* ========================================================================== *
 *  本地暂停（暂时脱离）
 *
 *  「我先停一下接个电话」和「我不想听了」是两回事。开启之后，
 *  不是控制者的人按暂停只暂停自己：不广播、也不会被别人拉回去；
 *  继续播放时自动跳回大家此刻的进度。
 * ========================================================================== */

let detached = false;

/** 此刻是不是由我在控 */
const isDriverNow = () =>
  session.controlMode === "host" ? session.isHost : session.driverClientId === session.clientId;

/** 暂时脱离：只停自己这一份 */
const detach = () => {
  if (detached) return;
  detached = true;
  noticeOnce("detached", "已暂时脱离同步：其他人照常，你继续播放时会自动追上进度");
};

/** 重新跟上：跳到大家此刻的位置 */
const reattach = async () => {
  if (!detached) return;
  detached = false;
  lastNoticeKey = "";

  const playback = session.latest && session.latest.playback;
  if (!playback || !playback.track) return;

  const target = expectedPosition(playback);

  if (!sameTrack(local.track, playback.track)) {
    // 脱离期间大家换过歌了：能自动切就切过去，切完由 pendingFollow 对齐进度
    if (settings.autoFollow && mcp.configured) {
      suppressPublish(5_000);
      const result = await mcp.playTrack(playback.track);
      if (result.ok) {
        pendingFollow = { key: trackKey(playback.track), playback };
        return;
      }
    }
    log.info("[一起听] 脱离期间大家换过歌了，你这边还停在原来那首");
    return;
  }

  log.info("[一起听] 已追上大家的进度：", `${Math.round(target / 1000)}s`);
  suppressPublish();
  splayer.player.seek(Math.max(0, Math.round(target)));
  notePosition(target);
};

/**
 * 应用服务端状态。
 * @param room 服务端房间快照
 */
const applyRoom = async (room) => {
  session.latest = room;
  session.version = room.version;
  adoptRoom(room);

  // 队列和「此刻在放什么」是两件事：队列版本变了就同步一次本机播放列表，
  // 放在下面那些早退之前处理，免得「现在没人在播」时把队列同步也一起跳过
  if (typeof room.queueVersion === "number" && room.queueVersion !== lastQueueVersion) {
    lastQueueVersion = room.queueVersion;
    void syncRoomQueue();
  }

  const playback = room.playback;

  // 房间还没人播放 / 是我自己上报的东西，都不用跟随
  if (!playback || !playback.track) return;
  if (playback.sourceClientId === session.clientId) return;
  if (!settings.enabled) return;
  // 本地暂停了就先不跟，继续播放时再一次性追上去
  if (detached) return;

  // 「当前控制者」的说法只在 all 模式下有意义，日志里区分一下更好读
  const who = session.controlMode === "all" ? "房间里的人" : "房主";
  const target = expectedPosition(playback);

  if (!sameTrack(local.track, playback.track)) {
    if (!settings.autoFollow) {
      noticeOnce(
        `track:${trackKey(playback.track)}`,
        `${who}正在播放「${describe(playback.track)}」，本地未跟随（可在插件菜单里手动同步）`,
      );
      return;
    }
    if (!mcp.configured) {
      noticeOnce(
        "no-mcp",
        `${who}切到了「${describe(playback.track)}」，但未开启 MCP 自动切歌，无法跟随`,
      );
      return;
    }
    // 切歌要走 MCP、还要等加载，这段时间里本机事件都不该被当成本地操作报回去
    suppressPublish(5_000);
    const result = await mcp.playTrack(playback.track);
    if (!result.ok) {
      noticeOnce("play-failed", "自动切歌失败：", result.message);
      return;
    }
    lastNoticeKey = "";
    pendingFollow = { key: trackKey(playback.track), playback };
    // 兜底：宿主迟迟不切过来就放弃这次跟随
    setTimeout(() => {
      if (pendingFollow && pendingFollow.key === trackKey(playback.track)) pendingFollow = null;
    }, 15_000);
    return;
  }

  // 同一首歌：对齐播放态与进度
  if (settings.syncPlayState) {
    if (playback.playing && !local.playing) {
      debug("跟随播放");
      suppressPublish();
      splayer.player.play();
    } else if (!playback.playing && local.playing) {
      debug("跟随暂停");
      suppressPublish();
      splayer.player.pause();
    }
  }

  if (!settings.syncSeek) return;

  const drift = Math.abs(target - localPosition());
  if (drift <= settings.seekThresholdMs) return;

  // 推算值只用来判断「要不要看一眼」，真跳转前取一次权威进度，避免误跳
  let actual = null;
  try {
    actual = await splayer.player.getPosition();
  } catch {
    /* 取不到就按推算值走 */
  }
  const reference = typeof actual === "number" && Number.isFinite(actual) ? actual : localPosition();
  if (typeof actual === "number") notePosition(actual);
  if (Math.abs(target - reference) <= settings.seekThresholdMs) return;

  debug(`进度对齐：本地 ${Math.round(reference)} → 目标 ${Math.round(target)}`);
  suppressPublish();
  splayer.player.seek(Math.max(0, Math.round(target)));
  notePosition(target);
};

/* ========================================================================== *
 *  房间共享队列
 *
 *  队列放在服务端，大家的「下一首」才会是同一首 —— 各人本地队列互相独立时，
 *  一首放完每个人会各自走向自己的下一首，直接乱掉。
 *
 *  本机这一侧只有一条路能碰播放队列：MCP 的 add_to_queue（控制插件 API 里
 *  没有队列接口）。也就是说只能往里加，读不到也删不掉 —— 服务端删掉的歌，
 *  本机这份要等它自己放完。所以这里是「尽量对齐」，不是双向同步。
 * ========================================================================== */

/**
 * 已推进本机播放队列的条目 id，避免重复推。
 *
 * 记的是**队列条目 id**，不是曲目 id —— 本机那一侧 SPlayer 会自己按曲目 ID 去重，
 * 所以插件重载后重新推一遍也没关系，不会出现两份。反过来，等哪天队列要支持
 * 「同一首歌在不同位置各来一次」，条目 id 和曲目 id 的边界就得重新想一遍。
 */
const pushedQueueEntries = new Set();
/** 上次见过的队列版本 */
let lastQueueVersion = -1;

/** 拉一次房间队列 */
const fetchRoomQueue = async () => {
  const result = await api(
    `/api/room/${encodeURIComponent(settings.roomId)}/queue`,
    null,
    API_TIMEOUT_MS,
    "GET",
  );
  if (!result.ok || !result.body || !Array.isArray(result.body.queue)) return null;
  return result.body;
};

/** 把房间队列里还没推过的歌加进本机播放队列 */
const syncRoomQueue = async () => {
  if (!settings.enabled || !session.joined || !settings.syncQueue) return;
  if (!mcp.configured) {
    noticeOnce("queue-no-mcp", "同步房间队列需要开启 MCP（要用它的 add_to_queue）");
    return;
  }

  const snapshot = await fetchRoomQueue();
  if (!snapshot) return;

  const fresh = snapshot.queue.filter((entry) => !pushedQueueEntries.has(entry.id));
  if (fresh.length === 0) return;

  // 标了「紧接着放」的用 next，其余补到队尾。
  // next 是逐个插到当前歌后面，所以要倒着推，先入队的才排在前面。
  const toInsertNext = fresh.filter((entry) => entry.insertNext).reverse();
  const toAppend = fresh.filter((entry) => !entry.insertNext);

  const push = async (entries, position) => {
    if (entries.length === 0) return true;
    const result = await mcp.callTool("add_to_queue", {
      tracks: entries.map((entry) => entry.track),
      position,
    });
    if (!result.ok) {
      log.warn("[一起听] 房间队列同步失败：", result.message);
      return false;
    }
    for (const entry of entries) pushedQueueEntries.add(entry.id);
    return true;
  };

  if (!(await push(toInsertNext, "next"))) return;
  if (!(await push(toAppend, "end"))) return;

  // 记过的条目不用留太久，防止长会话里无限膨胀
  if (pushedQueueEntries.size > 2_000) pushedQueueEntries.clear();

  log.info(`[一起听] 房间队列已同步 ${fresh.length} 首到本机播放列表`);
};

/* ========================================================================== *
 *  播放事件
 * ========================================================================== */

splayer.player.on("trackChange", ({ track }) => {
  local.track = track || null;
  // 换歌了，进度从 0 重新起算；真实值等下一次位置事件/心跳纠正
  notePosition(0);

  if (pendingFollow && track && trackKey(track) === pendingFollow.key) {
    const { playback } = pendingFollow;
    pendingFollow = null;
    // 加载需要一点时间，稍等再对齐，否则可能被后续的 load 覆盖
    setTimeout(() => {
      const target = expectedPosition(playback);
      if (Math.abs(target - localPosition()) > settings.seekThresholdMs) {
        suppressPublish();
        splayer.player.seek(Math.max(0, Math.round(target)));
        notePosition(target);
      }
      if (settings.syncPlayState && playback.playing) {
        suppressPublish();
        splayer.player.play();
      }
    }, 700);
    return;
  }

  // 本机用户换了歌：立即上报（all 模式下这一步就把控制权拿到自己手里）
  if (canReportIntent()) {
    publishThrottled({ force: true, asIntent: true });
    // 起播后真实进度会有几百毫秒，补一次准确值
    setTimeout(() => {
      void refreshPosition().then((position) => {
        if (!canReportIntent()) return;
        if (position > 0) void sendPublish(position);
      });
    }, 1200);
  }
});

splayer.player.on("playStateChange", ({ state, position }) => {
  local.playing = state === "playing";
  notePosition(position);

  // 刚跟随过远端状态，这次变化不是本机操作
  if (isSuppressed()) return;

  // 「本地暂停」：不是控制者的人按暂停只停自己，不广播也不被拉回去
  if (settings.localPause && !isDriverNow()) {
    if (state !== "playing") {
      detach();
      return;
    }
    if (detached) {
      void reattach();
      return;
    }
  }

  publishThrottled({ force: true, asIntent: true });
});

splayer.player.on("lineChange", ({ position }) => {
  notePosition(position);
  // 歌词行进比心跳密，节流一下就好。它只是进度，不能拿来抢控制权
  publishThrottled();
});

/** 主动向宿主要一次准确进度（即发即忘，失败就沿用推算值） */
const refreshPosition = async () => {
  try {
    const position = await splayer.player.getPosition();
    if (typeof position === "number" && Number.isFinite(position)) {
      notePosition(position);
      return position;
    }
  } catch {
    /* 忽略 */
  }
  return localPosition();
};

/* ========================================================================== *
 *  主循环
 * ========================================================================== */

let running = false;
let retryDelay = RETRY_MIN_MS;

/**
 * 循环代次。
 *
 * stop() 只是把 running 置 false，但循环多半正卡在 20 多秒的长轮询上，
 * 等它返回时 running 可能已经被新的 start() 重新置回 true —— 旧循环就复活了。
 * 每改一次设置都会 stop/start，于是循环越攒越多：多个订阅循环抢着 join、
 * 多个上报循环用各自的计数器互相顶掉。所以用一个代次号把它们区分开，
 * 对不上的循环在下一次回到循环头时自己退出。
 */
let generation = 0;

/**
 * 订阅循环：长轮询，服务端一有变化就立刻返回。
 *
 * 这个循环自己负责自愈 —— 掉线退避重试、房间没了就重新 join，
 * 只要代次没变就不会退出。
 */
const subscribeLoop = async (mine) => {
  while (running && mine === generation) {
    if (!session.joined) {
      const joined = await joinRoom();
      if (!joined) {
        debug("重新加入失败：", session.lastError);
        await sleep(retryDelay);
        retryDelay = clamp(retryDelay * 2, RETRY_MIN_MS, RETRY_MAX_MS);
        continue;
      }
      retryDelay = RETRY_MIN_MS;
      continue;
    }

    const result = await api(
      `/api/room/${encodeURIComponent(settings.roomId)}/poll`,
      {
        clientId: session.clientId,
        name: settings.nickname || undefined,
        since: session.version,
        wait: POLL_WAIT_MS,
      },
      POLL_TIMEOUT_MS,
    );

    if (!result.ok) {
      session.lastError = result.error || "无法连接服务端";
      // 房间被服务端回收 / 会话不在房间里 → 下一轮重新 join
      if (result.status === 404 || result.status === 409) {
        session.joined = false;
        session.version = 0;
      }
      debug("订阅失败：", session.lastError);
      await sleep(retryDelay);
      retryDelay = clamp(retryDelay * 2, RETRY_MIN_MS, RETRY_MAX_MS);
      continue;
    }

    retryDelay = RETRY_MIN_MS;
    session.lastError = null;
    if (result.body && result.body.room) await applyRoom(result.body.room);
  }
};

/**
 * 上报循环：兜住「没有歌词事件时进度不刷新」的缺口。
 *
 * 只有当前控制者（host 模式下即房主）会发心跳；加一点随机抖动，
 * 免得「大家都可以调」模式下控制者位空出来时几个人同一毫秒一起抢。
 */
const publishLoop = async (mine) => {
  while (running && mine === generation) {
    const interval = clamp(settings.heartbeatSec, 2, 60) * 1000 + Math.random() * 700;
    await sleep(interval);
    if (!running || mine !== generation) return;
    if (!canReport()) continue;
    const position = await refreshPosition();
    await publishHeartbeat(position);
  }
};

/** 停止所有循环：置位 + 换代次，让在飞的循环作废 */
const stop = () => {
  running = false;
  generation += 1;
};

/** 拉起所有循环；配置变化后调用即可重启 */
const start = async () => {
  if (running) return;
  // 手动调起（比如「我当房主」）时，别再让排着队的去抖重连补一刀
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  readSettings();
  if (!settings.enabled) {
    log.info("[一起听] 已禁用，不连接服务端");
    return;
  }

  // 先把上一代清干净，再记下这一代的号
  stop();
  running = true;
  const mine = generation;

  session.joined = false;
  session.version = 0;
  retryDelay = RETRY_MIN_MS;
  detached = false;
  lastQueueVersion = -1;
  pushedQueueEntries.clear();

  // 先同步试一次，好让「状态」菜单立刻能给出结果；失败也没关系，循环里会自愈
  await joinRoom();
  // 房间可能已经有队列了，主动拉一次，别等到第一次长轮询回来才同步
  if (session.joined) void syncRoomQueue();
  void subscribeLoop(mine);
  void publishLoop(mine);
};

/* ========================================================================== *
 *  设置变化 / 菜单 / 启动
 * ========================================================================== */

const RESTART_KEYS = ["enabled", "serverUrl", "serverKey", "roomId", "roomKey", "nickname", "role"];

/**
 * 重连去抖。
 *
 * 改设置时是一键一次事件，文本框里每敲一个字符都会触发一次 ——
 * 不去抖的话，敲完一串密钥就等于重连十几次。
 */
let restartTimer = null;
const scheduleRestart = () => {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    stop();
    mcp.reset();
    void start();
  }, 600);
};

/** 切换房间的控制模式；只有房主的请求会被服务端接受 */
const switchControlMode = async (mode) => {
  const result = await api(`/api/room/${encodeURIComponent(settings.roomId)}/mode`, {
    clientId: session.clientId,
    hostToken: session.hostToken || undefined,
    mode,
  });
  if (!result.ok) return { ok: false, message: result.error || "无法连接服务端" };
  if (!result.body.accepted) return { ok: false, message: "只有房主能改控制模式" };

  session.controlMode = result.body.mode === "all" ? "all" : "host";
  if (session.latest) session.latest.controlMode = session.controlMode;
  return { ok: true, mode: session.controlMode };
};

for (const key of SETTING_KEYS) {
  splayer.onSettingChange(key, () => {
    const before = { ...settings };
    readSettings();

    // 控制模式是房间属性：设置改了就地推给服务端（这个设置只在建房间时生效，
    // 所以房间里已经有人的话，必须显式推一次才符合用户预期）
    if (key === "controlMode" && before.controlMode !== settings.controlMode && session.joined) {
      void switchControlMode(settings.controlMode).then((result) => {
        if (!result.ok) log.warn("[一起听] 控制模式未能切换：", result.message);
        else log.info("[一起听] 控制模式已切换为：", describeMode(result.mode));
      });
      return;
    }

    // 关掉开关要立刻停，不能等去抖
    if (key === "enabled" && !settings.enabled) {
      log.info("[一起听] 已禁用");
      stop();
      return;
    }

    const needsRestart = RESTART_KEYS.some((name) => before[name] !== settings[name]);
    if (needsRestart) {
      log.info("[一起听] 配置变化，稍后重连…");
      // 换房间了才丢掉房主令牌与强制角色；改别的设置不该影响已有身份
      if (settings.roomId !== before.roomId) {
        session.hostToken = null;
        forcedRole = null;
      }
      scheduleRestart();
    }
  });
}

// 链接里不带密钥 —— 分享出去的地址是干净的，看的人自己在网页上填一次
const roomUrl = () => `${settings.serverUrl}/room/${encodeURIComponent(settings.roomId)}`;

splayer.on("menuClick", async ({ menuId, track }) => {
  switch (menuId) {
    case "open-room":
      return { openUrl: roomUrl() };
    case "copy-room":
      return { copyText: roomUrl() };
    case "add-queue": {
      if (!session.joined) return { toast: "还没连上服务端" };
      if (!track) return { toast: "当前没有歌曲" };
      const result = await api(`/api/room/${encodeURIComponent(settings.roomId)}/queue`, {
        clientId: session.clientId,
        hostToken: session.hostToken || undefined,
        action: "add",
        tracks: [track],
      });
      if (!result.ok) return { toast: `加不进去：${result.error || "网络错误"}` };
      if (!result.body || !result.body.changed) {
        return { toast: `「${track.title}」已经在房间队列里了` };
      }
      return { toast: `已加入房间队列：${track.title}` };
    }
    case "toggle-mode": {
      if (!session.joined) return { toast: "还没连上服务端" };
      const current = session.latest ? session.latest.controlMode : session.controlMode;
      const next = current === "all" ? "host" : "all";
      const result = await switchControlMode(next);
      if (!result.ok) return { toast: `切换失败：${result.message}` };
      return { toast: `已切换为「${describeMode(result.mode)}」` };
    }
    case "take-host": {
      stop();
      // 本次会话内强制以房主身份加入，覆盖设置里的角色
      forcedRole = "host";
      session.hostToken = null;
      session.joined = false;
      await sleep(100);
      await start();
      if (!session.isHost) forcedRole = null;
      return {
        toast: session.isHost
          ? `你已成为「${settings.roomId}」的房主`
          : `没能拿到房主位${session.lastError ? `：${session.lastError}` : ""}`,
      };
    }
    case "sync-now": {
      if (canReport()) {
        const position = await refreshPosition();
        await sendPublish(position);
        return { toast: "已上报当前播放" };
      }
      const room = session.latest;
      if (!room || !room.playback || !room.playback.track) return { toast: "房间里还没有人在播放" };
      await applyRoom(room);
      return { toast: `已尝试跟随：${describe(room.playback.track)}` };
    }
    case "status": {
      const members = session.latest ? session.latest.members.length : 0;
      const queued = session.latest ? session.latest.queueLength : 0;
      const headline = !settings.enabled
        ? "一起听：已禁用"
        : session.lastError
          ? `一起听：${session.lastError}`
          : session.joined
            ? `一起听：${session.isHost ? "房主" : "听众"} · 房间 ${settings.roomId} · ${members} 人 · ${describeMode(session.controlMode)} · 队列 ${queued ?? 0} 首`
            : "一起听：连接中…";
      const nowPlaying = session.latest && session.latest.playback
        ? describe(session.latest.playback.track)
        : describe(local.track);
      const driving =
        session.controlMode === "all" && session.driverClientId === session.clientId
          ? "（我在控）"
          : "";
      const detachedNote = detached ? "（已本地暂停，继续播放会自动追上）" : "";
      return { toast: `${headline}${driving}${detachedNote}｜当前：${nowPlaying}` };
    }
    default:
      return undefined;
  }
});

/** 启动：先干掉可能残留的旧状态，再拉起循环 */
void (async () => {
  try {
    readSettings();

    // 同一个房间的话，把上次的身份（clientId）和房主令牌恢复回来。
    // 少了这一步，插件每次重载都会以新身份加入，旧记录还在，
    // 房间里就会出现同一个人的两个成员。
    const savedRoom = await splayer.storage.get("roomId");
    if (savedRoom === settings.roomId) {
      const savedClientId = await splayer.storage.get("clientId");
      const savedToken = await splayer.storage.get("hostToken");
      if (typeof savedClientId === "string") session.clientId = savedClientId;
      if (typeof savedToken === "string") session.hostToken = savedToken;
      if (typeof savedClientId === "string" || typeof savedToken === "string") {
        debug("已恢复上次的房间身份");
      }
    }

    await start();
  } catch (error) {
    log.error("[一起听] 启动失败：", (error && error.message) || String(error));
  }
})();

// 卸载前留个脚印（宿主会杀掉沙箱，这里只做最好的努力）
log.info(`[一起听] v${VERSION} 已加载`);
