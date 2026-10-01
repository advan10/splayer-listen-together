import type { IncomingMessage, ServerResponse } from "node:http";
import { config, VERSION } from "./config.ts";
import { t } from "./i18n.ts";
import { RoomError, roomStore } from "./rooms.ts";
import type { JoinRequest, PluginTrack, PollRequest, PublishRequest, QueueRequest } from "./types.ts";
import { extractServerKey, isValidRoomId, readJson, safeEqual, sendEmpty, sendJson } from "./util.ts";

const startedAt = Date.now();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const fail = (res: ServerResponse, status: number, error: string, code: string): void => {
  sendJson(res, status, { ok: false, error, code });
};

/**
 * 处理 /api 下的所有请求。
 * @returns 是否已处理（false 表示交给静态资源）
 */
export const handleApi = async (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> => {
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) return false;

  // 服务端密钥：设了就要求所有接口都带上。
  // /api/health 例外——它是探活用的，被拦掉容器健康检查就没法做了；
  // 代价是它对外可见，所以下面会把房间数隐掉。
  const isHealth = pathname === "/api/health";
  if (config.serverKey && !isHealth && !safeEqual(extractServerKey(req, url), config.serverKey)) {
    fail(res, 401, t("api.serverKeyRequired"), "SERVER_KEY_REQUIRED");
    return true;
  }

  try {
    // GET /api/health
    if (isHealth) {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        uptimeMs: Date.now() - startedAt,
        serverTime: Date.now(),
        ...(config.serverKey ? {} : { rooms: roomStore.list().length }),
      });
      return true;
    }

    // GET /api/rooms
    if (pathname === "/api/rooms") {
      sendJson(res, 200, { ok: true, rooms: roomStore.list() });
      return true;
    }

    const match = /^\/api\/room\/([^/]+)(?:\/(join|poll|publish|leave|mode|queue))?$/.exec(pathname);
    if (!match) {
      fail(res, 404, t("api.notFound"), "NOT_FOUND");
      return true;
    }

    const roomId = decodeURIComponent(match[1] as string);
    const action = match[2];

    if (!isValidRoomId(roomId)) {
      fail(res, 400, t("api.badRoomId"), "BAD_ROOM_ID");
      return true;
    }

    // GET /api/room/:id —— 取一次快照
    if (!action) {
      if (req.method !== "GET") {
        fail(res, 405, t("api.methodNotAllowed"), "METHOD_NOT_ALLOWED");
        return true;
      }
      const snapshot = roomStore.get(roomId);
      if (!snapshot) {
        fail(res, 404, t("api.roomNotFound"), "ROOM_NOT_FOUND");
        return true;
      }
      sendJson(res, 200, { ok: true, room: snapshot });
      return true;
    }

    // GET /api/room/:id/queue —— 取整条队列（队列不进快照，单独拉）
    if (action === "queue" && req.method === "GET") {
      const result = roomStore.queueOf(roomId);
      if (!result) {
        fail(res, 404, t("api.roomNotFound"), "ROOM_NOT_FOUND");
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        queueVersion: result.queueVersion,
        queue: result.queue,
        serverTime: Date.now(),
      });
      return true;
    }

    if (req.method !== "POST") {
      fail(res, 405, t("api.methodNotAllowed"), "METHOD_NOT_ALLOWED");
      return true;
    }

    const body = asRecord(await readJson(req));

    if (action === "join") {
      const input = body as unknown as JoinRequest;
      const result = roomStore.join(roomId, {
        ...(typeof input.clientId === "string" ? { clientId: input.clientId } : {}),
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(input.role ? { role: input.role } : {}),
        ...(typeof input.key === "string" ? { key: input.key } : {}),
        ...(typeof input.hostToken === "string" ? { hostToken: input.hostToken } : {}),
        ...(input.controlMode === "host" || input.controlMode === "all"
          ? { controlMode: input.controlMode }
          : {}),
        ...(typeof body.roomName === "string" ? { roomName: body.roomName } : {}),
      });
      sendJson(res, 200, {
        ok: true,
        roomId,
        clientId: result.clientId,
        role: result.role,
        isHost: result.role === "host",
        ...(result.hostToken ? { hostToken: result.hostToken } : {}),
        serverTime: Date.now(),
        room: result.room,
      });
      return true;
    }

    if (action === "publish") {
      const input = body as unknown as PublishRequest;
      if (typeof input.clientId !== "string" || !input.playback) {
        fail(res, 400, t("api.missingClientIdPlayback"), "BAD_REQUEST");
        return true;
      }
      const result = roomStore.publish(roomId, {
        clientId: input.clientId,
        ...(typeof input.hostToken === "string" ? { hostToken: input.hostToken } : {}),
        track: input.playback.track ?? null,
        playing: input.playback.playing,
        position: input.playback.position,
        seq: input.playback.seq,
        clientTime: input.playback.clientTime,
      });
      sendJson(res, 200, {
        ok: true,
        accepted: result.accepted,
        ...(result.reason ? { reason: result.reason } : {}),
        version: result.room.version,
        serverTime: Date.now(),
      });
      return true;
    }

    if (action === "poll") {
      const input = body as unknown as PollRequest;
      if (typeof input.clientId !== "string") {
        fail(res, 400, t("api.missingClientId"), "BAD_REQUEST");
        return true;
      }
      // 长轮询：期间客户端断开就把挂起项收掉，别让它等到超时
      const result = await roomStore.poll(roomId, {
        clientId: input.clientId,
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        since: Number(input.since),
        wait: Math.min(Number(input.wait) || 0, config.maxPollWaitMs),
      });
      if (res.writableEnded || res.destroyed) return true;
      sendJson(res, 200, {
        ok: true,
        changed: result.changed,
        serverTime: Date.now(),
        room: result.room,
      });
      return true;
    }

    if (action === "mode") {
      const input = body;
      if (typeof input.clientId !== "string" || (input.mode !== "host" && input.mode !== "all")) {
        fail(res, 400, t("api.missingClientIdMode"), "BAD_REQUEST");
        return true;
      }
      const result = roomStore.setMode(roomId, {
        clientId: input.clientId,
        ...(typeof input.hostToken === "string" ? { hostToken: input.hostToken } : {}),
        mode: input.mode,
      });
      sendJson(res, 200, {
        ok: true,
        accepted: result.accepted,
        ...(result.reason ? { reason: result.reason } : {}),
        mode: result.room.controlMode,
        version: result.room.version,
        serverTime: Date.now(),
      });
      return true;
    }

    if (action === "queue") {
      const input = body as unknown as QueueRequest;
      if (typeof input.clientId !== "string") {
        fail(res, 400, t("api.missingClientId"), "BAD_REQUEST");
        return true;
      }

      const respond = (changed: number | undefined): void => {
        const current = roomStore.queueOf(roomId);
        sendJson(res, 200, {
          ok: true,
          ...(changed === undefined ? {} : { changed }),
          queueVersion: current ? current.queueVersion : 0,
          queue: current ? current.queue : [],
          serverTime: Date.now(),
        });
      };

      if (input.action === "add") {
        const tracks = Array.isArray(input.tracks) ? (input.tracks as PluginTrack[]) : [];
        if (tracks.length === 0) {
          fail(res, 400, t("api.noTracks"), "BAD_REQUEST");
          return true;
        }
        const result = roomStore.addToQueue(roomId, {
          clientId: input.clientId,
          tracks,
          ...(input.position === "next" ? { position: "next" as const } : {}),
        });
        respond(result.added);
        return true;
      }

      if (input.action === "remove") {
        if (typeof input.entryId !== "string") {
          fail(res, 400, t("api.missingEntryId"), "BAD_REQUEST");
          return true;
        }
        const result = roomStore.removeFromQueue(roomId, {
          clientId: input.clientId,
          ...(typeof input.hostToken === "string" ? { hostToken: input.hostToken } : {}),
          entryId: input.entryId,
        });
        respond(result.removed);
        return true;
      }

      if (input.action === "clear") {
        const result = roomStore.clearQueue(roomId, {
          clientId: input.clientId,
          ...(typeof input.hostToken === "string" ? { hostToken: input.hostToken } : {}),
        });
        respond(result.cleared);
        return true;
      }

      fail(res, 400, t("api.badQueueAction"), "BAD_REQUEST");
      return true;
    }

    if (action === "leave") {
      if (typeof body.clientId !== "string") {
        fail(res, 400, t("api.missingClientId"), "BAD_REQUEST");
        return true;
      }
      roomStore.leave(roomId, body.clientId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    fail(res, 404, "未知接口", "NOT_FOUND");
    return true;
  } catch (error) {
    if (error instanceof RoomError) {
      fail(res, error.status, error.message, error.code);
      return true;
    }
    if (error instanceof Error && error.message === "invalid json") {
      fail(res, 400, t("api.badJson"), "BAD_JSON");
      return true;
    }
    if (error instanceof Error && error.message === "payload too large") {
      fail(res, 413, t("api.payloadTooLarge"), "PAYLOAD_TOO_LARGE");
      return true;
    }
    console.error("[api] 未捕获错误:", error);
    fail(res, 500, t("api.internal"), "INTERNAL");
    return true;
  }
};

/** OPTIONS 预检：插件跑在 Node 侧不会发，但网页端调试会用到 */
export const handlePreflight = (req: IncomingMessage, res: ServerResponse): boolean => {
  if (req.method !== "OPTIONS") return false;
  sendEmpty(res, 204);
  return true;
};
