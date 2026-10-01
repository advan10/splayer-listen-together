import { config } from "./config.ts";
import { t } from "./i18n.ts";
import type {
  ControlMode,
  MemberInfo,
  MemberRole,
  Playback,
  PluginTrack,
  QueueEntry,
  QueuePosition,
  RoomSnapshot,
  RoomSummary,
} from "./types.ts";
import { now, randomHex, sanitizeName, sha256 } from "./util.ts";

/** 长轮询的挂起请求 */
interface Waiter {
  clientId: string;
  since: number;
  resolve: (changed: boolean) => void;
  timer: NodeJS.Timeout;
}

interface Room {
  id: string;
  name: string;
  /** 房间口令；空串表示用全局 config.roomKey（可能也是空） */
  key: string;
  createdAt: number;
  touchedAt: number;
  version: number;
  playback: Playback | null;
  hostClientId: string | null;
  hostTokenHash: string | null;
  controlMode: ControlMode;
  /** 当前控制者（最后一次被接受的上报者） */
  driverClientId: string | null;
  /** 房间共享队列：大家的「下一首」从这里来 */
  queue: QueueEntry[];
  /** 队列版本，一变就 +1 */
  queueVersion: number;
  members: Map<string, MemberInfo>;
  waiters: Set<Waiter>;
  /** 网页端 SSE 订阅者 */
  listeners: Set<(snapshot: RoomSnapshot) => void>;
}

export class RoomError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = "RoomError";
    this.code = code;
    this.status = status;
  }
}

const membersOf = (room: Room): MemberInfo[] =>
  [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);

/** 判断「同一首歌」用的键 */
const trackKeyOf = (track: PluginTrack): string => `${track.source ?? ""}:${track.id}`;

const snapshotOf = (room: Room): RoomSnapshot => ({
  roomId: room.id,
  name: room.name,
  version: room.version,
  playback: room.playback,
  hostClientId: room.hostClientId,
  controlMode: room.controlMode,
  driverClientId: room.driverClientId,
  members: membersOf(room),
  serverTime: now(),
  queueVersion: room.queueVersion,
  queueLength: room.queue.length,
});

/**
 * 房间状态的唯一持有者。
 *
 * 全部在内存里：一起听是「此刻谁在听什么」的实时状态，重启即散场是合理的。
 * 需要留档的话，在 publish 里挂一个 append-only 的落盘即可。
 */
export class RoomStore {
  private readonly rooms = new Map<string, Room>();

  private ensure(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        name: roomId,
        key: "",
        createdAt: now(),
        touchedAt: now(),
        version: 1,
        playback: null,
        hostClientId: null,
        hostTokenHash: null,
        controlMode: "host",
        driverClientId: null,
        queue: [],
        queueVersion: 1,
        members: new Map(),
        waiters: new Set(),
        listeners: new Set(),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private effectiveKey(room: Room): string {
    return room.key || config.roomKey;
  }

  private assertKey(room: Room, key: unknown): void {
    const expected = this.effectiveKey(room);
    if (!expected) return;
    if (typeof key !== "string" || key !== expected) {
      throw new RoomError(t("room.badKey"), "BAD_ROOM_KEY", 403);
    }
  }

  /** 版本变化：唤醒长轮询 + 推送网页端 */
  private bump(room: Room): void {
    room.version += 1;
    room.touchedAt = now();
    const snapshot = snapshotOf(room);
    for (const waiter of room.waiters) {
      clearTimeout(waiter.timer);
      room.waiters.delete(waiter);
      waiter.resolve(true);
    }
    for (const listener of room.listeners) {
      try {
        listener(snapshot);
      } catch {
        /* 单个订阅者出错不影响房间 */
      }
    }
  }

  private isStale(member: MemberInfo | undefined): boolean {
    return !member || now() - member.lastSeen > config.memberTtlMs;
  }

  /**
   * 清理离线成员。
   *
   * 房主掉线就释放房主位（允许别人接管）；控制者掉线就释放控制者位
   * （「大家都可以调」模式下，下一个人动手就能接手）。
   */
  private prune(room: Room): boolean {
    let changed = false;
    for (const [clientId, member] of room.members) {
      if (now() - member.lastSeen > config.memberTtlMs) {
        room.members.delete(clientId);
        changed = true;
        if (room.hostClientId === clientId) {
          room.hostClientId = null;
          room.hostTokenHash = null;
        }
        if (room.driverClientId === clientId) {
          room.driverClientId = null;
        }
      }
    }
    return changed;
  }

  join(
    roomId: string,
    input: {
      clientId?: string;
      name?: string;
      role?: "host" | "guest" | "auto";
      key?: string;
      hostToken?: string;
      roomName?: string;
      controlMode?: ControlMode;
    },
  ): {
    clientId: string;
    role: MemberRole;
    hostToken?: string;
    room: RoomSnapshot;
  } {
    const room = this.ensure(roomId);
    this.prune(room);

    // 房间还没被锁上时，第一个带口令进来的人决定这个房间的口令
    // （先采纳再校验，所以创建者自己不会被打回）
    if (!room.key && !config.roomKey && typeof input.key === "string" && input.key.trim()) {
      room.key = input.key.trim();
    }
    // 控制模式同样是「创建时定下来」，之后只能经 /mode 改
    if (room.members.size === 0 && (input.controlMode === "host" || input.controlMode === "all")) {
      room.controlMode = input.controlMode;
    }
    if (typeof input.roomName === "string" && input.roomName.trim() && room.name === room.id) {
      room.name = sanitizeName(input.roomName, room.id);
    }
    this.assertKey(room, input.key);

    if (room.members.size >= config.maxMembers) {
      const existing = input.clientId ? room.members.get(input.clientId) : undefined;
      if (!existing) throw new RoomError(t("room.full"), "ROOM_FULL", 409);
    }

    const clientId = input.clientId?.trim() || randomHex(8);
    const name = sanitizeName(input.name, t("name.fallback", { id: clientId.slice(0, 4) }));
    const role: MemberRole | "auto" = input.role ?? "auto";

    // 房主判定：令牌有效 → 一定是房主；否则在「房主缺席」时按意愿接管
    const tokenValid =
      Boolean(input.hostToken) &&
      Boolean(room.hostTokenHash) &&
      sha256(input.hostToken as string) === room.hostTokenHash;

    const currentHost = room.hostClientId ? room.members.get(room.hostClientId) : undefined;
    const hostSeatFree =
      room.hostClientId === null ||
      room.hostClientId === clientId ||
      this.isStale(currentHost);

    let isHost = false;
    if (role === "guest") {
      // 明确当听众：只认令牌（重连时靠它保住已经有的房主位）
      isHost = tokenValid;
    } else if (tokenValid) {
      isHost = true;
    } else if (role === "host") {
      // 明确要求当房主 → 顶掉现任（口令已经校验过，房间口令就是「可信任的邀请」）
      isHost = true;
    } else if (hostSeatFree) {
      // auto：只有在房主缺席时才顶上
      isHost = true;
    }

    let hostToken: string | undefined;
    if (isHost && !tokenValid) {
      hostToken = randomHex(16);
      room.hostTokenHash = sha256(hostToken);
    }
    if (isHost) room.hostClientId = clientId;

    const existingMember = room.members.get(clientId);
    room.members.set(clientId, {
      clientId,
      name,
      role: isHost ? "host" : "guest",
      joinedAt: existingMember?.joinedAt ?? now(),
      lastSeen: now(),
    });

    if (!existingMember) this.bump(room);
    else room.touchedAt = now();

    return {
      clientId,
      role: isHost ? "host" : "guest",
      ...(hostToken ? { hostToken } : {}),
      room: snapshotOf(room),
    };
  }

  /**
   * 上报播放快照。
   *
   * 「只有房主可调」模式下非房主一律拒绝；「大家都可以调」模式下谁都被接受，
   * 上报者随即成为当前控制者，其他人跟着他走。
   *
   * 不接受的请求返回 `accepted: false` 而不是抛错，方便插件区分
   * 「没资格」和「网络挂了」。
   */
  publish(
    roomId: string,
    input: {
      clientId: string;
      hostToken?: string;
      track: PluginTrack | null;
      playing: boolean;
      position: number;
      seq: number;
      clientTime: number;
    },
  ): { accepted: boolean; reason?: "host-only" | "stale-seq"; room: RoomSnapshot } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(t("room.notFound"), "ROOM_NOT_FOUND", 404);

    const member = room.members.get(input.clientId);
    if (!member) throw new RoomError(t("room.notJoined"), "NOT_JOINED", 409);

    member.lastSeen = now();

    const tokenValid =
      Boolean(input.hostToken) &&
      Boolean(room.hostTokenHash) &&
      sha256(input.hostToken as string) === room.hostTokenHash;
    const isHost = room.hostClientId === input.clientId || tokenValid;

    if (room.controlMode === "host" && !isHost) {
      return { accepted: false, reason: "host-only", room: snapshotOf(room) };
    }

    // 迟到/重复的快照丢弃，避免进度回跳
    const previous = room.playback;
    const stale =
      previous !== null &&
      previous.sourceClientId === input.clientId &&
      input.seq <= previous.seq;
    if (stale) {
      return { accepted: false, reason: "stale-seq", room: snapshotOf(room) };
    }

    room.playback = {
      track: input.track,
      playing: Boolean(input.playing),
      position: Math.max(0, Number(input.position) || 0),
      seq: Number(input.seq) || 0,
      clientTime: Number(input.clientTime) || 0,
      publishedAt: now(),
      sourceClientId: input.clientId,
    };
    // 谁被接受，谁就是当前控制者
    room.driverClientId = input.clientId;
    this.bump(room);
    return { accepted: true, room: snapshotOf(room) };
  }

  /** 切换控制模式；只有房主（或持有有效房主令牌的人）能改 */
  setMode(
    roomId: string,
    input: { clientId: string; hostToken?: string; mode: ControlMode },
  ): { accepted: boolean; reason?: string; room: RoomSnapshot } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(t("room.notFound"), "ROOM_NOT_FOUND", 404);

    const member = room.members.get(input.clientId);
    if (!member) throw new RoomError(t("room.notJoined"), "NOT_JOINED", 409);
    member.lastSeen = now();

    const tokenValid =
      Boolean(input.hostToken) &&
      Boolean(room.hostTokenHash) &&
      sha256(input.hostToken as string) === room.hostTokenHash;
    if (room.hostClientId !== input.clientId && !tokenValid) {
      return { accepted: false, reason: "host-only", room: snapshotOf(room) };
    }

    if (room.controlMode !== input.mode) {
      room.controlMode = input.mode;
      // 切回「只有房主可调」时，如果当前控制者不是房主，就把控制者位收回 ——
      // 房主下一次心跳会自然接管。播放内容保留，不用把大家的画面清空。
      if (input.mode === "host" && room.driverClientId && room.driverClientId !== room.hostClientId) {
        room.driverClientId = null;
      }
      this.bump(room);
    }
    return { accepted: true, room: snapshotOf(room) };
  }

  /* ── 共享队列 ───────────────────────────────────────────────────────────── */

  /** 这个人有没有「改队列」的资格（和上报的控制权同一套规则） */
  private mayControl(room: Room, clientId: string, hostToken?: string): boolean {
    const tokenValid =
      Boolean(hostToken) &&
      Boolean(room.hostTokenHash) &&
      sha256(hostToken as string) === room.hostTokenHash;
    if (room.controlMode === "all") return true;
    return room.hostClientId === clientId || tokenValid;
  }

  /** 取整条队列：不进快照（队列可能很长），客户端按 queueVersion 变化来拉 */
  queueOf(roomId: string): { queueVersion: number; queue: QueueEntry[] } | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return { queueVersion: room.queueVersion, queue: room.queue };
  }

  /**
   * 往房间队列里加歌。
   *
   * 谁都可以加 —— 队列是张「点歌单」，房主看着不对可以删掉。
   * 只有删除和清空才需要控制权。
   */
  addToQueue(
    roomId: string,
    input: { clientId: string; tracks: PluginTrack[]; position?: QueuePosition },
  ): { added: number; room: RoomSnapshot } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(t("room.notFound"), "ROOM_NOT_FOUND", 404);
    const member = room.members.get(input.clientId);
    if (!member) throw new RoomError(t("room.notJoined"), "NOT_JOINED", 409);
    member.lastSeen = now();

    // 同一首歌不重复入队，免得本地播放队列和服务端队列越差越远
    const seen = new Set(room.queue.map((entry) => trackKeyOf(entry.track)));
    const fresh: QueueEntry[] = [];
    for (const track of input.tracks.slice(0, config.maxQueueAdd)) {
      if (!track || typeof track.id !== "string" || typeof track.title !== "string") continue;
      const key = trackKeyOf(track);
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({
        id: randomHex(6),
        track,
        addedBy: input.clientId,
        addedAt: now(),
        insertNext: input.position === "next",
      });
    }
    if (fresh.length === 0) return { added: 0, room: snapshotOf(room) };

    if (input.position === "next") room.queue.unshift(...fresh);
    else room.queue.push(...fresh);

    // 超上限从队尾丢：先保住在眼前的那些
    if (room.queue.length > config.maxQueue) room.queue.length = config.maxQueue;

    room.queueVersion += 1;
    this.bump(room);
    return { added: fresh.length, room: snapshotOf(room) };
  }

  /** 从队列里删一项；需要控制权 */
  removeFromQueue(
    roomId: string,
    input: { clientId: string; hostToken?: string; entryId: string },
  ): { removed: number; room: RoomSnapshot } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(t("room.notFound"), "ROOM_NOT_FOUND", 404);
    const member = room.members.get(input.clientId);
    if (!member) throw new RoomError(t("room.notJoined"), "NOT_JOINED", 409);
    member.lastSeen = now();

    if (!this.mayControl(room, input.clientId, input.hostToken)) {
      throw new RoomError(t("room.notAllowed"), "NOT_ALLOWED", 403);
    }

    const index = room.queue.findIndex((entry) => entry.id === input.entryId);
    if (index < 0) return { removed: 0, room: snapshotOf(room) };

    room.queue.splice(index, 1);
    room.queueVersion += 1;
    this.bump(room);
    return { removed: 1, room: snapshotOf(room) };
  }

  /** 清空队列；需要控制权 */
  clearQueue(
    roomId: string,
    input: { clientId: string; hostToken?: string },
  ): { cleared: number; room: RoomSnapshot } {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(t("room.notFound"), "ROOM_NOT_FOUND", 404);
    const member = room.members.get(input.clientId);
    if (!member) throw new RoomError(t("room.notJoined"), "NOT_JOINED", 409);
    member.lastSeen = now();

    if (!this.mayControl(room, input.clientId, input.hostToken)) {
      throw new RoomError(t("room.notAllowed"), "NOT_ALLOWED", 403);
    }

    const cleared = room.queue.length;
    if (cleared === 0) return { cleared: 0, room: snapshotOf(room) };

    room.queue = [];
    room.queueVersion += 1;
    this.bump(room);
    return { cleared, room: snapshotOf(room) };
  }

  /**
   * 拉取房间状态；版本没变化时挂起，最多等 waitMs。
   * @returns changed 表示是否因「有新内容」而返回
   */
  poll(
    roomId: string,
    input: { clientId: string; name?: string; since?: number; wait?: number },
  ): Promise<{ changed: boolean; room: RoomSnapshot }> {
    const room = this.rooms.get(roomId);
    if (!room) throw new RoomError(t("room.notFound"), "ROOM_NOT_FOUND", 404);

    // 顺手清一遍离线成员：控制者/房主掉线要尽快释放，别让房间卡在没人的状态
    if (this.prune(room)) this.bump(room);

    let member = room.members.get(input.clientId);
    if (!member) {
      // 宽容处理：会话丢了就当作新听众加入，不用让插件重走 join
      room.members.set(input.clientId, {
        clientId: input.clientId,
        name: sanitizeName(input.name, t("name.fallback", { id: input.clientId.slice(0, 4) })),
        role: room.hostClientId === input.clientId ? "host" : "guest",
        joinedAt: now(),
        lastSeen: now(),
      });
      member = room.members.get(input.clientId);
      this.bump(room);
    } else {
      member.lastSeen = now();
      if (typeof input.name === "string" && input.name.trim()) {
        member.name = sanitizeName(input.name, member.name);
      }
    }
    room.touchedAt = now();

    const since = Number(input.since);
    const waitMs = Math.min(
      Math.max(Number(input.wait) || 0, 0),
      config.maxPollWaitMs,
    );

    if (!Number.isFinite(since) || since < room.version || waitMs === 0) {
      return Promise.resolve({ changed: true, room: snapshotOf(room) });
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        clientId: input.clientId,
        since,
        resolve: (changed: boolean) => resolve({ changed, room: snapshotOf(room) }),
        timer: setTimeout(() => {
          room.waiters.delete(waiter);
          resolve({ changed: false, room: snapshotOf(room) });
        }, waitMs),
      };
      waiter.timer.unref?.();
      room.waiters.add(waiter);
    });
  }

  leave(roomId: string, clientId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.members.delete(clientId)) {
      if (room.hostClientId === clientId) {
        room.hostClientId = null;
        room.hostTokenHash = null;
      }
      this.bump(room);
    }
  }

  get(roomId: string): RoomSnapshot | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    this.prune(room);
    return snapshotOf(room);
  }

  list(): RoomSummary[] {
    return [...this.rooms.values()].map((room) => {
      this.prune(room);
      const track = room.playback ? room.playback.track : null;
      return {
        roomId: room.id,
        name: room.name,
        members: room.members.size,
        hostClientId: room.hostClientId,
        controlMode: room.controlMode,
        playing: Boolean(room.playback && room.playback.playing),
        nowPlaying: track
          ? {
              title: track.title,
              artists: (track.artists || []).map((artist) => artist.name),
              source: track.source,
              cover: track.cover || (track.album && track.album.cover) || "",
            }
          : null,
        updatedAt: room.playback ? room.playback.publishedAt : null,
      };
    });
  }

  /** 网页端 SSE 订阅 */
  subscribe(roomId: string, listener: (snapshot: RoomSnapshot) => void): () => void {
    const room = this.ensure(roomId);
    room.listeners.add(listener);
    return () => {
      room.listeners.delete(listener);
    };
  }

  /** 定期回收：清离线成员、删空房间 */
  sweep(): void {
    for (const [roomId, room] of this.rooms) {
      const changed = this.prune(room);
      if (changed) this.bump(room);
      const empty = room.members.size === 0;
      const idle = now() - room.touchedAt > config.roomTtlMs;
      if (empty && idle) {
        for (const waiter of room.waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(false);
        }
        this.rooms.delete(roomId);
      }
    }
  }
}

export const roomStore = new RoomStore();
