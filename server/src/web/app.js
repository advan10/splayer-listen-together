/**
 * 一起听 · 网页端
 *
 * 两种模式，按路径分：
 *   /                    房间列表 —— 这台服务端上现在有哪些房间
 *   /room/<房间ID>        房间详情 —— 谁在听什么、进度、成员
 *
 * 数据来自服务端：房间详情走 SSE（服务端推），房间列表定时拉。
 * 进度是本地推算的（服务端给的是一次快照 + 发布时刻），
 * 所以页面能在两次事件之间平滑地走下去。
 */

(() => {
  "use strict";

  const KEY_STORAGE = "listen-together-key";
  const ROOMS_REFRESH_MS = 5_000;

  const pathMatch = /^\/room\/([^/]+)\/?$/.exec(location.pathname);
  const ROOM_ID = pathMatch ? decodeURIComponent(pathMatch[1]) : "";
  /** 根路径（或别的路径）→ 显示房间列表 */
  const IS_INDEX = !ROOM_ID;

  const $ = (id) => document.getElementById(id);

  /** 最近一次房间快照 */
  let room = null;
  /** 当前曲目的本地投影：{ track, playing, positionAtSync, localSyncedAt } */
  let view = null;
  /** 上一首的封面，用于避免重复设置背景 */
  let lastCover = null;

  let serverKey =
    new URLSearchParams(location.search).get("key") || localStorage.getItem(KEY_STORAGE) || "";
  let source = null;
  let roomsTimer = null;
  let lastProbeAt = 0;

  /* ====================================================================== *
   *  小工具
   * ====================================================================== */

  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );

  const fmt = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return "0:00";
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  /** 只放行 http(s) 图片地址，顺便让 URL 解析器把引号之类的字符编码掉 */
  const safeImageUrl = (value) => {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value, location.href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  };

  /** 用名字算一个稳定的头像底色 */
  const avatarColor = (name) => {
    let hash = 0;
    for (let index = 0; index < name.length; index += 1) {
      hash = (hash * 31 + name.charCodeAt(index)) % 360;
    }
    return `hsl(${hash} 58% 68%)`;
  };

  /**
   * 房间控制模式的说法。
   *
   * 网页是给人「看」的，所以用陈述句（谁在控制），而不是插件设置里那种
   * 命令式的「你可以调」——那是配置项的口吻。
   */
  const modeLabelOf = (room) =>
    room && room.controlMode === "all" ? "大家一起控制" : "房主控制";

  const SOURCE_LABELS = {
    netease: "网易云",
    qqmusic: "QQ 音乐",
    kugou: "酷狗",
    local: "本地",
    streaming: "流媒体",
  };

  let toastTimer = null;
  const toast = (text) => {
    const node = $("toast");
    node.textContent = text;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 1_800);
  };

  /** 需要带上密钥的请求头 */
  const authHeaders = () =>
    serverKey ? { "X-Server-Key": serverKey } : {};

  /**
   * 给 URL 拼上密钥。
   *
   * 只用在 EventSource 上 —— 浏览器不让它设请求头，长连接只能靠查询参数。
   * 页面上显示、复制的链接一律不带密钥，密钥由用户在闸门里填一次并记住。
   */
  const keyed = (path) =>
    serverKey ? `${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(serverKey)}` : path;

  /* ====================================================================== *
   *  房间详情
   * ====================================================================== */

  /** 本地推算的当前进度；暂停时停在快照位置 */
  const currentPosition = () => {
    if (!view || !view.track) return 0;
    if (!view.playing) return view.positionAtSync;
    const elapsed = Date.now() - view.localSyncedAt;
    return Math.min(view.positionAtSync + elapsed, view.track.duration || 0);
  };

  /** 背景光晕跟着封面走；同一张封面不重复设，免得反复触发过渡 */
  const setBackdrop = (cover) => {
    if (cover === lastCover) return;
    lastCover = cover;
    const bg = $("bg");
    if (!cover) {
      bg.classList.remove("has-art");
      return;
    }
    bg.style.backgroundImage = `url("${cover}")`;
    bg.classList.add("has-art");
  };

  const renderNowPlaying = () => {
    const container = $("now");
    const track = view && view.track;

    if (!track) {
      container.className = "card now";
      container.innerHTML = `
        <div class="empty">
          <div class="glyph" aria-hidden="true">♪</div>
          <div class="hint">还没有人在播放</div>
        </div>`;
      setBackdrop("");
      return;
    }

    const artists = (track.artists || []).map((artist) => artist.name).join(" / ") || "未知艺人";
    const cover = safeImageUrl(track.cover || (track.album && track.album.cover));
    const modeLabel = modeLabelOf(room);
    const driver = room && (room.members || []).find((m) => m.clientId === room.driverClientId);
    const playing = view.playing;

    const tags = [
      `<span class="tag">${esc(SOURCE_LABELS[track.source] || track.source || "未知来源")}</span>`,
      playing
        ? `<span class="tag live"><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>播放中</span>`
        : `<span class="tag">已暂停</span>`,
      `<span class="tag">${modeLabel}</span>`,
    ];
    if (driver && room.controlMode === "all") {
      tags.push(`<span class="tag accent">${esc(driver.name)} 正在控制</span>`);
    }

    container.className = `card now${playing ? "" : " paused"}`;
    container.innerHTML = `
      <div class="track">
        <div class="cover${cover ? "" : " empty"}" id="cover">${cover ? "" : "♪"}</div>
        <div class="meta">
          <h1 class="title">${esc(track.title)}</h1>
          <p class="artists">${esc(artists)}</p>
          <p class="album">${esc((track.album && track.album.name) || "")}</p>
        </div>
      </div>
      <div class="progress">
        <div class="bar"><div class="fill" id="fill"></div></div>
        <div class="times">
          <span id="pos">0:00</span>
          <span id="dur">${fmt(track.duration)}</span>
        </div>
      </div>
      <div class="tags">${tags.join("")}</div>`;

    // 封面走 style 属性赋值，不拼进 innerHTML
    const coverNode = $("cover");
    if (coverNode && cover) coverNode.style.backgroundImage = `url("${cover}")`;
    setBackdrop(cover);

    document.title = `${track.title} · 一起听`;
    tick();
  };

  const tick = () => {
    const fill = $("fill");
    const pos = $("pos");
    if (!fill || !pos || !view || !view.track) return;
    const duration = view.track.duration || 0;
    const position = currentPosition();
    fill.style.width = duration > 0 ? `${Math.min(100, (position / duration) * 100)}%` : "0%";
    pos.textContent = fmt(position);
  };

  const renderMembers = () => {
    if (!room) return;
    const members = room.members || [];
    $("memberCount").textContent = members.length ? `${members.length} 人` : "";

    $("members").innerHTML = members.length
      ? members
          .map((member) => {
            const isHost = member.clientId === room.hostClientId;
            const isDriver = room.controlMode === "all" && member.clientId === room.driverClientId;
            const name = member.name || "听众";
            const badges = [
              `<span class="badge ${isHost ? "host" : ""}">${isHost ? "房主" : "听众"}</span>`,
            ];
            // 「大家一起控制」时才需要标出谁在控制；房主控制模式下房主就是控制者，标了是废话
            if (isDriver) badges.push('<span class="badge host">正在控制</span>');
            return `
              <li class="member">
                <span class="avatar" style="background:${avatarColor(name)}" aria-hidden="true">${esc(name.slice(0, 1))}</span>
                <span class="name">${esc(name)}</span>
                <span class="badges">${badges.join("")}</span>
              </li>`;
          })
          .join("")
      : '<li class="member"><span class="name" style="color:var(--faint)">暂时没有人在房间里</span></li>';

    $("modeLine").textContent =
      room.controlMode === "all"
        ? `控制模式：${modeLabelOf(room)} · 谁最后操作，谁就接管`
        : `控制模式：${modeLabelOf(room)}`;
  };

  const applyRoom = (payload) => {
    if (!payload) return;
    room = payload;
    $("roomName").textContent = payload.name || payload.roomId || ROOM_ID;

    const playback = payload.playback;
    view =
      playback && playback.track
        ? {
            track: playback.track,
            playing: Boolean(playback.playing),
            // 服务端给的是「发布那一刻的进度」，换算到本地时钟
            positionAtSync:
              playback.position +
              (playback.playing ? Math.max(0, Date.now() - playback.publishedAt) : 0),
            localSyncedAt: Date.now(),
          }
        : null;

    renderNowPlaying();
    renderMembers();
    $("serverTime").textContent = new Date(payload.serverTime).toLocaleTimeString("zh-CN");

    // 队列内容不在快照里，版本变了才单独去拉
    if (typeof payload.queueVersion === "number" && payload.queueVersion !== queueVersion) {
      void refreshQueue();
    }
  };

  /* ====================================================================== *
   *  房间队列
   *
   *  队列内容不进快照（可能很长），快照里只给 queueVersion；
   *  版本一变就单独拉一次整条队列。
   * ====================================================================== */

  /** 已渲染的队列版本；-1 表示还没拉过 */
  let queueVersion = -1;

  const renderQueue = (queue) => {
    const list = Array.isArray(queue) ? queue : [];
    const names = new Map((room && room.members ? room.members : []).map((m) => [m.clientId, m.name]));
    $("queueCount").textContent = list.length ? `${list.length} 首` : "";
    $("queue").classList.toggle("scrollable", list.length > 8);

    if (list.length === 0) {
      $("queue").innerHTML =
        '<li class="queue-row"><span class="room-sub idle">队列是空的。在 SPlayer 里用插件菜单就能把歌加进来。</span></li>';
      return;
    }

    $("queue").innerHTML = list
      .map((entry, index) => {
        const track = entry.track || {};
        const cover = safeImageUrl(track.cover || (track.album && track.album.cover));
        const artists = (track.artists || []).map((artist) => artist.name).join(" / ");
        const who = names.get(entry.addedBy);
        return `
          <li class="queue-row">
            <span class="queue-index">${index + 1}</span>
            <span class="room-art"${cover ? ` data-cover="${esc(cover)}"` : ""}>${cover ? "" : "♪"}</span>
            <span class="room-body">
              <span class="room-title">${esc(track.title || "未知曲目")}</span>
              <span class="room-sub">${esc(artists)}</span>
            </span>
            ${who ? `<span class="queue-who">${esc(who)} 点的</span>` : ""}
          </li>`;
      })
      .join("");

    for (const node of document.querySelectorAll("#queue .room-art[data-cover]")) {
      node.style.backgroundImage = `url("${node.dataset.cover}")`;
    }
  };

  const refreshQueue = async () => {
    try {
      const response = await fetch(`/api/room/${encodeURIComponent(ROOM_ID)}/queue`, {
        headers: authHeaders(),
      });
      if (!response.ok) return;
      const payload = await response.json();
      queueVersion = payload.queueVersion;
      renderQueue(payload.queue);
    } catch {
      /* 拉不到就先不显示，下次队列变化会再试 */
    }
  };

  const openStream = () => {
    if (source) source.close();
    source = new EventSource(keyed(`/api/room/${encodeURIComponent(ROOM_ID)}/events`));

    source.onopen = () => {
      $("dot").className = "dot on";
      $("statusText").textContent = "已连接";
    };

    source.onerror = () => {
      $("dot").className = "dot off";
      $("statusText").textContent = "连接断开，重连中…";
      // 可能是密钥被改掉了。别每次报错都去问服务端，间隔一下
      if (Date.now() - lastProbeAt < 5_000) return;
      void probe().then((result) => {
        if (result.status === 401) {
          source.close();
          showGate("密钥不对，请重新输入");
        }
      });
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        applyRoom(payload.room);
      } catch (error) {
        console.warn("无法解析事件", error);
      }
    };
  };

  /* ====================================================================== *
   *  房间列表（根路径）
   * ====================================================================== */

  const renderRooms = (list) => {
    $("roomsCount").textContent = list.length ? `${list.length} 个` : "";

    if (list.length === 0) {
      $("rooms").innerHTML = `
        <li class="room-row">
          <span class="room-sub idle">现在还没有房间。在 SPlayer 里启用「一起听」插件之后，房间就会出现在这里。</span>
        </li>`;
      return;
    }

    $("rooms").innerHTML = list
      .map((item) => {
        const href = `/room/${encodeURIComponent(item.roomId)}`;
        const now = item.nowPlaying;
        const cover = now ? safeImageUrl(now.cover) : "";
        const artists = now && now.artists.length ? ` — ${now.artists.join(" / ")}` : "";
        const subtitle = now
          ? `${item.playing ? "" : "已暂停 · "}${now.title}${artists}`
          : "还没有人在播放";
        const modeLabel = modeLabelOf(item);

        return `
          <li class="room-row">
            <a class="room-link" href="${esc(href)}">
              <span class="room-art"${cover ? ` data-cover="${esc(cover)}"` : ""}>${cover ? "" : "♪"}</span>
              <span class="room-body">
                <span class="room-title">${esc(item.name || item.roomId)}</span>
                <span class="room-sub${now ? "" : " idle"}">${esc(subtitle)}</span>
              </span>
              <span class="badges">
                <span class="badge">${item.members} 人</span>
                <span class="badge">${modeLabel}</span>
              </span>
              <span class="arrow" aria-hidden="true">›</span>
            </a>
          </li>`;
      })
      .join("");

    // 封面同样走 style 属性赋值（data-cover 里的实体已由浏览器解码回来）
    for (const node of document.querySelectorAll("#rooms .room-art[data-cover]")) {
      node.style.backgroundImage = `url("${node.dataset.cover}")`;
    }
  };

  const refreshRooms = async () => {
    try {
      const response = await fetch(keyed("/api/rooms"), { headers: authHeaders() });
      if (response.status === 401) {
        stopRoomList();
        showGate("密钥不对，请重新输入");
        return;
      }
      if (!response.ok) return;
      const payload = await response.json();
      const list = (payload.rooms || []).slice();
      // 正在播的排前面，其次按最近上报时间
      list.sort((left, right) => {
        const playingDiff = Number(Boolean(right.nowPlaying)) - Number(Boolean(left.nowPlaying));
        if (playingDiff !== 0) return playingDiff;
        return (right.updatedAt || 0) - (left.updatedAt || 0);
      });
      renderRooms(list);
      $("dot").className = "dot on";
      $("statusText").textContent = "已连接";
      $("serverTime").textContent = new Date().toLocaleTimeString("zh-CN");
    } catch {
      $("dot").className = "dot off";
      $("statusText").textContent = "连不上服务端";
    }
  };

  const startRoomList = () => {
    void refreshRooms();
    if (roomsTimer) clearInterval(roomsTimer);
    roomsTimer = setInterval(() => void refreshRooms(), ROOMS_REFRESH_MS);
  };

  const stopRoomList = () => {
    if (roomsTimer) clearInterval(roomsTimer);
    roomsTimer = null;
  };

  /* ====================================================================== *
   *  连接与密钥
   * ====================================================================== */

  /**
   * 探一下密钥对不对。
   *
   * 不能靠 EventSource 自己报错来判断 —— 它分不清 401 和网络抖动，而且会一直重试。
   * 先用一次普通请求问清楚，再决定开不开流。
   */
  const probe = async () => {
    lastProbeAt = Date.now();
    const path = IS_INDEX ? "/api/rooms" : `/api/room/${encodeURIComponent(ROOM_ID)}`;
    try {
      const response = await fetch(path, { headers: authHeaders() });
      return { status: response.status };
    } catch {
      return { status: 0 };
    }
  };

  const showGate = (message) => {
    $("gate").classList.add("show");
    $("gateError").textContent = message || "";
    $("gateInput").focus();
  };
  const hideGate = () => $("gate").classList.remove("show");

  const connect = async () => {
    const result = await probe();

    if (result.status === 401) {
      $("dot").className = "dot off";
      $("statusText").textContent = "需要密钥";
      showGate(serverKey ? "密钥不对，请重新输入" : "");
      return;
    }
    if (result.status === 0) {
      $("dot").className = "dot off";
      $("statusText").textContent = "连不上服务端";
      return;
    }

    hideGate();
    if (serverKey) {
      localStorage.setItem(KEY_STORAGE, serverKey);
      // 密钥已经记住了，别让它在地址栏里一直挂着
      if (new URLSearchParams(location.search).has("key")) {
        history.replaceState(null, "", location.pathname + location.hash);
      }
    }
    if (IS_INDEX) startRoomList();
    else openStream();
  };

  /* ====================================================================== *
   *  交互
   * ====================================================================== */

  $("gateButton").addEventListener("click", () => {
    const value = $("gateInput").value.trim();
    if (!value) {
      $("gateError").textContent = "请填写密钥";
      return;
    }
    serverKey = value;
    $("gateError").textContent = "";
    void connect();
  });

  $("gateInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("gateButton").click();
  });

  $("copyLink").addEventListener("click", async () => {
    // 不带密钥：分享出去的链接是干净的，密钥各自在闸门里填
    const url = `${location.origin}${location.pathname}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("链接已复制");
    } catch {
      // 非 https 或没给剪贴板权限时退回到老办法
      const field = document.createElement("textarea");
      field.value = url;
      document.body.appendChild(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      toast(copied ? "链接已复制" : "复制失败，请手动复制地址栏");
    }
    const button = $("copyLink");
    button.classList.add("done");
    setTimeout(() => button.classList.remove("done"), 1_200);
  });

  /* ====================================================================== *
   *  启动
   * ====================================================================== */

  if (IS_INDEX) {
    // 房间列表模式：把房间详情那几块收起来
    $("now").hidden = true;
    $("membersCard").hidden = true;
    $("queueCard").hidden = true;
    $("roomsCard").hidden = false;
    $("copyLink").hidden = true;
    $("roomName").hidden = true;
    $("modeLine").hidden = true;
    document.title = "一起听";
    void connect();
  } else {
    $("roomsCard").hidden = true;
    $("roomName").textContent = ROOM_ID;
    document.title = `一起听 · ${ROOM_ID}`;
    void connect();
  }

  // 进度条每 500ms 自己走一步；数据一来就被 applyRoom 重新锚定
  setInterval(tick, 500);
})();
