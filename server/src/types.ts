/**
 * 一起听 —— 服务端与插件之间的协议类型
 *
 * 这里的类型是「线上格式」的唯一权威定义；插件侧（纯 JS，无法 import）
 * 有一份等价的手写定义，改动时两边要一起改。见 docs/protocol.md。
 */

/** SPlayer 的 Track.source：内置在线平台 + 本地 + 流媒体服务器 */
export type TrackSource = "local" | "streaming" | "netease" | "qqmusic" | "kugou" | (string & {});

export interface PluginArtist {
  id?: string;
  name: string;
  avatar?: string;
}

export interface PluginAlbum {
  id?: string;
  name: string;
  cover?: string;
}

/**
 * SPlayer Track 的宽松子集。
 *
 * 只保证列出的字段，其余原样透传 —— 这样宿主新增字段时服务端不用改。
 * 跟随端会把整条 track 原样交给本机 MCP 的 play_track，所以不要裁剪字段。
 */
export interface PluginTrack {
  id: string;
  extId?: string;
  source: TrackSource;
  path?: string;
  cuePath?: string;
  cueAudioPath?: string;
  cueStartMs?: number;
  cueEndMs?: number;
  serverId?: string;
  originalId?: string;
  title: string;
  comment?: string;
  artists: PluginArtist[];
  album?: PluginAlbum;
  track?: number;
  duration: number;
  cover?: string;
  coverOriginal?: string;
  fileSize?: number;
  quality?: unknown;
  fee?: number;
  cloud?: boolean;
  [key: string]: unknown;
}

/**
 * 房主发布的一次播放快照。
 *
 * `position` 是**发布那一刻**的进度，`publishedAt` 是服务端**收到**它的时间。
 * 跟随端据此推算当前应有的进度：
 *   target = position + (playing ? serverNow - publishedAt : 0)
 */
export interface Playback {
  /** 当前曲目，null 表示房主没有在播放任何东西 */
  track: PluginTrack | null;
  /** 是否正在播放 */
  playing: boolean;
  /** 发布时刻的进度（毫秒） */
  position: number;
  /** 发布者自增序号，用于识别乱序/重复 */
  seq: number;
  /** 发布者的本地墙钟（仅用于排查时钟问题） */
  clientTime: number;
  /** 服务端收到该快照的时间戳（毫秒） */
  publishedAt: number;
  /** 发布者 clientId */
  sourceClientId: string;
}

export type MemberRole = "host" | "guest";

/**
 * 房间的控制模式。
 *
 * - `host`：只有房主能换歌 / 调进度，其他人只管跟随。
 * - `all`：谁都能动手。动手的人成为「当前控制者」（driver），其他人跟着他走。
 */
export type ControlMode = "host" | "all";

export interface MemberInfo {
  clientId: string;
  name: string;
  role: MemberRole;
  /** 加入时间（毫秒） */
  joinedAt: number;
  /** 最近一次 poll/publish 的时间（毫秒），用于判定离线 */
  lastSeen: number;
}

/** 房间快照：join / poll 的返回值，也是网页端看到的东西 */
export interface RoomSnapshot {
  roomId: string;
  name: string;
  /** 每次播放状态或成员变化都 +1；follow 端用它判断「有没有新东西」 */
  version: number;
  playback: Playback | null;
  hostClientId: string | null;
  controlMode: ControlMode;
  /**
   * 当前控制者：最后一次被服务端接受的 reporter。
   *
   * `controlMode: "all"` 时，控制者位空着（或控制者退出）任何人都有资格上报；
   * 一旦有人上报，他就是新的控制者，其他人只跟随 —— 这样两个人不会互相抢进度。
   */
  driverClientId: string | null;
  members: MemberInfo[];
  serverTime: number;
  /** 队列版本，队列一变就 +1；客户端据此决定要不要重新拉队列 */
  queueVersion: number;
  /** 队列长度。完整的队列内容不塞进快照里（可能很大），另走 /queue 拿 */
  queueLength: number;
}

/** 房间列表里的一行；只带首页展示够用的信息，不含完整 Track */
export interface RoomSummary {
  roomId: string;
  name: string;
  members: number;
  hostClientId: string | null;
  controlMode: ControlMode;
  playing: boolean;
  /** 当前曲目的摘要，没人在播时为 null */
  nowPlaying: {
    title: string;
    artists: string[];
    source: TrackSource;
    cover: string;
  } | null;
  /** 最后一次上报的时刻（毫秒），没人在播时为 null */
  updatedAt: number | null;
}

/**
 * 房间共享队列里的一项。
 *
 * 队列放在服务端是为了让大家的「下一首」是同一首 —— 各人本地队列互相独立时，
 * 一首放完每个人会各自走向自己的下一首，直接乱掉。
 */
export interface QueueEntry {
  /** 房间内唯一序号；删除与去重都靠它 */
  id: string;
  /** 整条 Track 原样带着，客户端要拿它调本机 MCP 的 add_to_queue */
  track: PluginTrack;
  /** 加进来的人 */
  addedBy: string;
  addedAt: number;
  /** 入队时要求「紧接着放」；客户端据此决定用 next 还是 end 推给本机播放队列 */
  insertNext: boolean;
}

/** 插入位置：next 插到队首（紧接着当前播放），end 追加到队尾 */
export type QueuePosition = "next" | "end";

/** 队列请求的动作 */
export interface QueueRequest {
  clientId: string;
  hostToken?: string;
  action: "add" | "remove" | "clear";
  /** action = add 时必填 */
  tracks?: PluginTrack[];
  /** action = add 时的插入位置，默认 end */
  position?: QueuePosition;
  /** action = remove 时必填 */
  entryId?: string;
}

/** 队列接口的响应；每次都会把整条队列带回去，省一次往返 */
export interface QueueResponse {
  ok: boolean;
  /** 这次动作影响了几项（取队列时为 undefined） */
  changed?: number;
  queueVersion: number;
  queue: QueueEntry[];
  serverTime: number;
}

/* ================= 请求 / 响应 ================= */

export interface JoinRequest {
  clientId?: string;
  name?: string;
  role?: "host" | "guest" | "auto";
  /** 房间口令（房间设置了口令时必填） */
  key?: string;
  /** 上次拿到的房主令牌，用于重连后夺回房主身份 */
  hostToken?: string;
  /** 期望的控制模式；只在房间创建时生效，之后用 /mode 改 */
  controlMode?: ControlMode;
}

export interface JoinResponse {
  ok: true;
  roomId: string;
  clientId: string;
  role: MemberRole;
  /** 是否是房主（role === "host" 的简写，方便插件判断） */
  isHost: boolean;
  /** 房主令牌：只在本次成为房主时下发，插件应存进 splayer.storage */
  hostToken?: string;
  /** 服务端时间（毫秒），插件据此校正时钟偏移 */
  serverTime: number;
  room: RoomSnapshot;
}

export interface PublishRequest {
  clientId: string;
  hostToken?: string;
  playback: {
    track: PluginTrack | null;
    playing: boolean;
    position: number;
    seq: number;
    clientTime: number;
  };
}

export interface PublishResponse {
  ok: boolean;
  /** false 表示服务端没接受（不够资格 / 序号过期） */
  accepted: boolean;
  reason?: "host-only" | "stale-seq" | "not-joined";
  version: number;
  serverTime: number;
}

/** 切换房间的控制模式；只有房主能改 */
export interface SetModeRequest {
  clientId: string;
  hostToken?: string;
  mode: ControlMode;
}

export interface SetModeResponse {
  ok: boolean;
  accepted: boolean;
  reason?: string;
  mode: ControlMode;
  version: number;
  serverTime: number;
}

export interface PollRequest {
  clientId: string;
  name?: string;
  /** 已知版本号；服务端在版本超过它时立刻返回 */
  since?: number;
  /** 长轮询等待上限（毫秒，0 表示立即返回），服务端会夹取到 [0, 30000] */
  wait?: number;
}

export interface PollResponse {
  ok: true;
  /** 本次响应是「有新内容」还是「等到超时」 */
  changed: boolean;
  serverTime: number;
  room: RoomSnapshot;
}

export interface ErrorResponse {
  ok: false;
  error: string;
  code?: string;
}
