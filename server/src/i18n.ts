/**
 * 服务端 i18n：API 错误信息与控制台输出的多语言文案。
 *
 * 语言由 LOCALE 环境变量决定（见 config.ts），进程启动时确定一次，
 * 不做按请求的语言协商 —— 客户端应以响应中的 error.code 为准，
 * error 文案只用于人读。
 */
import { config } from "./config.ts";

type Dict = Record<string, string>;

const zhCn: Dict = {
  /* ── API 错误 ─────────────────────────────────────────────────────────── */
  "api.serverKeyRequired": "服务端密钥缺失或不正确",
  "api.notFound": "未知接口",
  "api.badRoomId": "房间 ID 只能包含字母、数字、下划线和连字符（1-64 位）",
  "api.badRoomIdShort": "房间 ID 非法",
  "api.methodNotAllowed": "方法不允许",
  "api.roomNotFound": "房间不存在",
  "api.missingClientIdPlayback": "缺少 clientId 或 playback",
  "api.missingClientId": "缺少 clientId",
  "api.missingClientIdMode": "缺少 clientId，或 mode 不是 host/all",
  "api.noTracks": "没有要加入队列的曲目",
  "api.missingEntryId": "缺少 entryId",
  "api.badQueueAction": "action 只能是 add / remove / clear",
  "api.badJson": "请求体不是合法 JSON",
  "api.payloadTooLarge": "请求体过大",
  "api.internal": "服务端内部错误",

  /* ── 房间业务错误（RoomError） ─────────────────────────────────────────── */
  "room.badKey": "房间口令不正确",
  "room.full": "房间人数已满",
  "room.notFound": "房间不存在",
  "room.notJoined": "尚未加入房间",
  "room.notAllowed": "现在只有控制者能改队列",
  "name.fallback": "听众-{id}",

  /* ── 控制台输出 ───────────────────────────────────────────────────────── */
  "log.requestFailed": "[server] 请求处理失败:",
  "log.shutdown": "\n收到 {signal}，正在关闭…",
  "banner.started": "\n  一起听服务端 v{version} 已启动",
  "banner.roomList": "  房间列表  {base}/",
  "banner.roomPage": "  房间页面  {base}/room/<房间ID>",
  "banner.health": "  健康检查  {base}/api/health",
  "banner.keyOn": "  服务端密钥 已开启：插件要填对密钥才能连上",
  "banner.keyOff": "  服务端密钥 未设置 —— 任何人都能创建房间，建议设一个 SERVER_KEY",
  "banner.roomKey": "  房间口令  已由 ROOM_KEY 环境变量设置",
};

const enUs: Dict = {
  /* ── API errors ───────────────────────────────────────────────────────── */
  "api.serverKeyRequired": "Server key is missing or incorrect",
  "api.notFound": "Unknown endpoint",
  "api.badRoomId": "Room ID can only contain letters, digits, underscores and hyphens (1-64 chars)",
  "api.badRoomIdShort": "Invalid room ID",
  "api.methodNotAllowed": "Method not allowed",
  "api.roomNotFound": "Room not found",
  "api.missingClientIdPlayback": "Missing clientId or playback",
  "api.missingClientId": "Missing clientId",
  "api.missingClientIdMode": "Missing clientId, or mode is not host/all",
  "api.noTracks": "No tracks to add to the queue",
  "api.missingEntryId": "Missing entryId",
  "api.badQueueAction": "action must be add / remove / clear",
  "api.badJson": "Request body is not valid JSON",
  "api.payloadTooLarge": "Request body too large",
  "api.internal": "Internal server error",

  /* ── Room business errors (RoomError) ─────────────────────────────────── */
  "room.badKey": "Incorrect room key",
  "room.full": "The room is full",
  "room.notFound": "Room not found",
  "room.notJoined": "Not joined to a room yet",
  "room.notAllowed": "Only the controller can modify the queue right now",
  "name.fallback": "Listener-{id}",

  /* ── Console output ───────────────────────────────────────────────────── */
  "log.requestFailed": "[server] Failed to handle request:",
  "log.shutdown": "\nReceived {signal}, shutting down…",
  "banner.started": "\n  Listen Together server v{version} started",
  "banner.roomList": "  Room list    {base}/",
  "banner.roomPage": "  Room page    {base}/room/<room-id>",
  "banner.health": "  Health check {base}/api/health",
  "banner.keyOn": "  Server key   ON — plugins must present the correct key to connect",
  "banner.keyOff": "  Server key   not set — anyone can create rooms; consider setting SERVER_KEY",
  "banner.roomKey": "  Room key     set via the ROOM_KEY environment variable",
};

const DICTS: Record<string, Dict> = { zh_cn: zhCn, en_us: enUs };

/** 按当前 locale 取文案；`{name}` 形式的占位符用 params 替换 */
export const t = (key: string, params?: Record<string, string | number>): string => {
  const dict = DICTS[config.locale] ?? zhCn;
  let text = dict[key] ?? zhCn[key] ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
  }
  return text;
};
