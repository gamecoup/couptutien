const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const store = require("./lib/store");
const oauth = require("./lib/oauth");
const rules = require("./lib/rules");
const sessions = new Map();
const TIME = {
  3: { game: 180000, move: 15000 },
  5: { game: 300000, move: 20000 },
  10: { game: 600000, move: 30000 },
  15: { game: 900000, move: 40000 }
};

const PORT = process.env.PORT || 8080;

const ROOT = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function safeFile(urlPath) {
  if (urlPath === "/") urlPath = "/index.html";
  const cleaned = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = path.join(ROOT, cleaned);
  const root = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (file !== ROOT && !file.startsWith(root)) return null;
  return file;
}

function redirect(res, loc) {
  res.writeHead(302, { Location: loc, "Cache-Control": "no-store" });
  res.end();
}

function htmlPage(res, title, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end("<!doctype html><meta charset=utf-8><title>" + title + "</title><body style='font-family:sans-serif;background:#1e140c;color:#ffe082;padding:24px'>" + body + "</body>");
}

function findOrLinkOAuth(info) {
  const accs = loadAcc();
  let acc = accs.find((a) => a.provider === info.provider && a.providerId === info.providerId);
  if (!acc && info.providerId) acc = accs.find((a) => String(a.providerId || "") === String(info.providerId));
  if (!acc && info.email) acc = accs.find((a) => norm(a.contact) === norm(info.email));
  if (!acc && info.email) acc = accs.find((a) => norm(a.email) === norm(info.email));
  if (!acc && info.email) acc = accs.find((a) => norm(a.name) === norm(info.email));
  if (!acc) {
    acc = {
      id: code() + code(),
      name: "",
      nameSet: false,
      contact: info.email || (info.provider + ":" + info.providerId),
      email: info.email || "",
      via: info.provider,
      provider: info.provider,
      providerId: info.providerId,
      createdAt: Date.now(),
      pts: 0,
      renamedAt: 0,
      avatarAt: 0,
      av: "",
      stats: { games: 0, wins: 0, losses: 0, draws: 0 }
    };
    accs.push(acc);
  } else {
    acc.provider = info.provider || acc.provider;
    acc.providerId = info.providerId || acc.providerId;
    acc.via = acc.via || info.provider;
    if (info.email) acc.email = info.email;
    if (info.email) acc.contact = acc.contact || info.email;
    if (acc.name && !acc.nameSet) acc.nameSet = true;
  }
  saveAcc(accs);
  return acc;
}

const server = http.createServer((req, res) => {
  const rawUrl = req.url || "/";
  let urlPath;
  try {
    urlPath = decodeURIComponent(rawUrl.split("?")[0]);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("URL không hợp lệ");
    return;
  }
  const qs = new URLSearchParams(rawUrl.split("?")[1] || "");

  if (urlPath === "/auth/google" || urlPath === "/auth/facebook") {
    const sid = qs.get("sid") || "";
    try {
      const loc = urlPath.indexOf("facebook") >= 0 ? oauth.facebookAuthUrl(req, sid) : oauth.googleAuthUrl(req, sid);
      redirect(res, loc);
    } catch (e) {
      htmlPage(res, "OAuth", "<p>" + String(e.message || e) + "</p><p>Thêm biến môi trường trên Render rồi thử lại.</p>");
    }
    return;
  }
  if (urlPath === "/auth/google/callback" || urlPath === "/auth/facebook/callback") {
    const st = oauth.takeState(qs.get("state"));
    const done = function (ok, need, claim) {
      redirect(res, "/oauth-done.html?ok=" + (ok ? "1" : "0") + "&need=" + (need ? "1" : "0") + (claim ? "&claim=" + encodeURIComponent(claim) : ""));
    };
    if (!st) { done(false, false); return; }
    const run = urlPath.indexOf("facebook") >= 0 ? oauth.facebookUser(req, qs.get("code")) : oauth.googleUser(req, qs.get("code"));
    run.then(function (info) {
      if (!info.providerId) throw new Error("Không lấy được ID mạng xã hội");
      const acc = findOrLinkOAuth(info);
      const need = !(acc.name && String(acc.name).trim());
      if (acc.name) acc.nameSet = true;
      const claim = require("crypto").randomBytes(16).toString("hex");
      oauth.putClaim(claim, { accId: acc.id, needProfile: need });
      oauth.putClaim(st.sid || acc.id, { accId: acc.id, needProfile: need });
      if (st.sid) oauth.putClaim(st.sid, { accId: acc.id, needProfile: need });
      done(true, need, claim);
    }).catch(function (err) {
      console.log("oauth", err && err.message);
      done(false, false);
    });
    return;
  }
  if (urlPath === "/oauth-done.html") {
    htmlPage(res, "Đăng nhập",
      "<script>(function(){var q=new URLSearchParams(location.search);var msg={type:'oauth',ok:q.get('ok')==='1',need:q.get('need')==='1',claim:q.get('claim')||''};var hasOpener=false;try{hasOpener=!!(window.opener&&!window.opener.closed);}catch(e){}if(hasOpener){try{window.opener.postMessage(msg,location.origin);window.opener.focus();}catch(e){}document.body.innerHTML='';try{window.close();}catch(e){}setTimeout(function(){try{window.close();}catch(e){}},50);return;}location.replace('/?oauth='+(msg.ok?'ok':'fail')+'&claim='+encodeURIComponent(msg.claim));})();</script>");
    return;
  }
  if (urlPath === "/auth/status") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    const c = oauth.cfg();
    res.end(JSON.stringify({ google: !!c.googleId, facebook: !!c.fbId }));
    return;
  }
  if (urlPath.startsWith("/uploads/avatars/")) {
    const name = path.basename(urlPath.split("?")[0]);
    const file = path.join(store.AV_DIR, name);
    if (!file.startsWith(store.AV_DIR) || !fs.existsSync(file)) {
      res.writeHead(404); res.end(); return;
    }
    const ext = path.extname(file);
    res.writeHead(200, { "Content-Type": MIME[ext] || "image/jpeg", "Cache-Control": "no-cache" });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const file = safeFile(urlPath);
  if (!file) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Không tìm thấy");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  });
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 64 * 1024 });
const rooms = new Map();
store.ensureDir();

function loadAcc() { return store.loadAcc(); }
function saveAcc(list) { store.saveAcc(list); }
function pubAcc(acc) { return store.pubAcc(acc); }
function norm(s) { return String(s || "").trim().toLowerCase(); }
const NAME_RE = /^[A-Za-z0-9_]{6,24}$/;
function validName(s) { return NAME_RE.test(String(s || "")); }
const NAME_RULE_TEXT = "Tên 6-24 ký tự, chỉ chữ cái không dấu/số/gạch dưới, không khoảng trắng.";

function publicProfile(ws) {
  if (!ws) return { id: code(), name: "Đạo hữu" };
  if (ws.profile && ws.profile.id) {
    return { id: ws.profile.id, name: ws.profile.name || "Đạo hữu" };
  }
  if (ws.account && ws.account.id) {
    return { id: ws.account.id, name: ws.account.name || "Đạo hữu" };
  }
  return { id: ws._id || (ws._id = code()), name: "Đạo hữu" };
}

function issueSession(ws) {
  const tok = store.token();
  ws.token = tok;
  sessions.set(tok, ws);
  return tok;
}

function live(ws) {
  return ws && ws.readyState === 1;
}

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(s) ? code() : s;
}

function send(ws, obj) {
  if (!live(ws)) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) {}
}

function visibleGame(game, color, extra) {
  if (!game) return null;
  extra = extra || {};
  return {
    board: game.board.map((row) => row.map((piece) => {
      if (!piece) return null;
      const copy = Object.assign({}, piece);
      if (!copy.revealed && copy.color !== color) copy.type = copy.slot;
      return copy;
    })),
    turn: extra.turn || game.turn,
    over: !!game.over,
    winner: game.winner || null,
    ply: game.ply || 0,
    captured: game.captured || { red: [], black: [] },
    started: extra.started != null ? !!extra.started : !game.over,
    clocks: extra.clocks || null,
    timeId: extra.timeId
  };
}

function sendGameSync(room) {
  if (!room || !room.game) return;
  const extra = {
    started: !!(room.busy && !room.over),
    clocks: room.clocks || null,
    timeId: room.timeId || 3,
    turn: room.turn || room.game.turn
  };
  room.players.forEach((p) => send(p.ws, {
    type: "relay",
    payload: { kind: "sync", game: visibleGame(room.game, p.color, extra) }
  }));
  (room.specs || []).forEach((s) => send(s, {
    type: "relay",
    payload: { kind: "sync", game: visibleGame(room.game, null, extra) }
  }));
}

function purgeUserFromAllRooms(ws) {
  if (!ws) return;
  const tok = ws.token;
  const accId = ws.account && ws.account.id;
  const profId = ws.profile && ws.profile.id;

  rooms.forEach((room, rId) => {
    const had = (room.players || []).some(p => 
      p.ws === ws || 
      (tok && p.token === tok) || 
      (accId && p.accountId === accId) || 
      (profId && p.profileId === profId)
    );

    if (had) {
      room.players = (room.players || []).filter(p => 
        p.ws !== ws && 
        (!tok || p.token !== tok) && 
        (!accId || p.accountId !== accId) && 
        (!profId || p.profileId !== profId)
      );

      if (!room.players.length) {
        rooms.delete(rId);
      } else {
        if (!room.players.some(p => p.host)) room.players[0].host = true;
        room.busy = false;
        room.over = true;
        room.game = null;
        room.clocks = null;
        room.players.forEach(p => { p.ready = false; });
        seat(room);
      }
    }
    room.specs = (room.specs || []).filter(s => s !== ws);
  });
  ws.roomId = null;
}

function restoreGameBoard(room, p, ws) {
  const extra = {
    started: true,
    clocks: room.clocks,
    timeId: room.timeId || 3,
    turn: room.turn
  };
  const gView = visibleGame(room.game, p.color, extra);

  send(ws, {
    type: "start",
    variant: room.variant || "up",
    clocks: room.clocks,
    turn: room.turn,
    timeId: room.timeId || 3,
    color: p.color,
    isHost: !!p.host,
    game: gView
  });

  send(ws, {
    type: "resume-game",
    clocks: room.clocks,
    turn: room.turn,
    timeId: room.timeId || 3,
    game: gView
  });

  send(ws, {
    type: "relay",
    payload: { kind: "sync", game: gView }
  });

  room.players.forEach((other) => {
    if (other.ws !== ws) {
      send(other.ws, { type: "peer-back", count: room.players.length });
    }
  });
  sendRoomState(room);
}

function pruneRoom(room) {
  if (!room) return false;
  const now = Date.now();
  let droppedAway = false;

  room.players = (room.players || []).filter((p) => {
    if (live(p.ws)) {
      p.away = false;
      p.awaySince = 0;
      p.autoResignedAt = 0;
      return true;
    }

    if (room.busy && !room.over) {
      if (p.awaySince && now - p.awaySince < 120000) {
        return true;
      }
      droppedAway = true;
      return false;
    }

    const waitStart = p.autoResignedAt || room.finishedAt || p.awaySince;
    if (waitStart && (now - waitStart > 40000)) {
      droppedAway = true;
      if (p.ws) {
        try { p.ws.roomId = null; p.ws.terminate(); } catch (e) {}
      }
      return false;
    }

    return true;
  });

  room.specs = (room.specs || []).filter((s) => live(s));

  if (!room.players.length) {
    if (!room.emptySince) room.emptySince = now;
    if (now - room.emptySince > 120000) {
      rooms.delete(room.id);
      return false;
    }
  } else {
    room.emptySince = null;
  }

  if (!room.players.some((p) => p.host) && room.players.length > 0) {
    room.players[0].host = true;
  }

  if (droppedAway) {
    room.busy = false;
    room.over = true;
    room.game = null;
    room.clocks = null;
    room.players.forEach((p) => { p.ready = false; });
    room.version = (room.version || 0) + 1;
    room.players.forEach((p) => send(p.ws, { type: "peer-left", count: room.players.length }));
    seat(room);
  }
  return true;
}

function pruneAll() {
  Array.from(rooms.values()).forEach(pruneRoom);
}

function seat(room) {
  if (!pruneRoom(room)) return;
  room.version = (room.version || 0) + 1;
  const profiles = {};
  room.players.forEach((p) => {
    if (p.color) profiles[p.color] = p.profile || publicProfile(p.ws);
  });
  room.players.forEach((p) => {
    send(p.ws, {
      type: "seated",
      room: room.id,
      color: p.color,
      isHost: !!p.host,
      count: room.players.length,
      busy: !!room.busy,
      variant: room.variant || "up",
      profile: p.profile || publicProfile(p.ws),
      profiles: profiles,
      ready: !!p.ready,
      peerReady: room.players.some((x) => x.ws !== p.ws && x.ready)
    });
  });
  sendRoomState(room);
}

function listPayload() {
  pruneAll();
  return Array.from(rooms.values()).filter((r) => r.players.length > 0).map((r) => ({
    id: r.id,
    n: r.players.length,
    specs: (r.specs || []).length,
    busy: !!r.busy,
    lock: !!r.password,
    variant: r.variant || "up"
  }));
}

function broadcastList() {
  const tables = listPayload();
  wss.clients.forEach((ws) => send(ws, { type: "tables", tables: tables }));
}

function presenceList() {
  const list = [];
  wss.clients.forEach((c) => {
    if (!live(c) || !c.profile) return;
    list.push({
      id: c.profile.id,
      name: c.profile.name,
      room: c.roomId || null,
      busy: !!(c.roomId && rooms.get(c.roomId) && rooms.get(c.roomId).busy),
      logged: !!c.account
    });
  });
  return list;
}

function broadcastPresence() {
  const list = presenceList();
  wss.clients.forEach((ws) => send(ws, { type: "presence", n: list.length, list: list }));
}

function specCount(room) {
  return (room.specs || []).filter((s) => live(s)).length;
}

function sendSpecCount(room) {
  if (!room) return;
  const n = specCount(room);
  const payload = { type: "spec-count", n: n };
  room.players.forEach((p) => send(p.ws, payload));
  (room.specs || []).forEach((s) => send(s, payload));
}

function sendRoomState(room) {
  if (!room) return;
  room.players.forEach((p) => send(p.ws, {
    type: "room-state",
    version: room.version || 0,
    room: room.id,
    count: room.players.length,
    busy: !!room.busy,
    variant: room.variant || "up",
    ready: !!p.ready,
    peerReady: room.players.some((x) => x.ws !== p.ws && x.ready)
  }));
}

function leaveRoom(ws, silent) {
  const roomId = ws.roomId;
  const wasSpec = !!(ws.spectate);
  purgeUserFromAllRooms(ws);
  pruneAll();
  if (!roomId || !rooms.has(roomId)) {
    broadcastList();
    broadcastPresence();
    return;
  }
  const room = rooms.get(roomId);
  if (!pruneRoom(room)) {
    broadcastList();
    broadcastPresence();
    return;
  }
  if (wasSpec) {
    sendSpecCount(room);
  } else {
    room.busy = false;
    room.over = true;
    room.game = null;
    room.clocks = null;
    room.players.forEach((p) => { p.ready = false; });
    room.version = (room.version || 0) + 1;
    if (!silent) {
      room.players.forEach((p) => send(p.ws, { type: "peer-left", count: room.players.length }));
    }
    seat(room);
  }
  sendSpecCount(room);
  broadcastList();
  broadcastPresence();
}

function roomOf(ws) {
  if (!ws || !ws.roomId) return null;
  const r = rooms.get(ws.roomId);
  if (!r) {
    ws.roomId = null;
    return null;
  }
  return r;
}

function initClocks(room) {
  const tm = TIME[room.timeId || 3] || TIME[3];
  room.clocks = { red: tm.game, black: tm.game, moveLeft: tm.move };
  room.turn = room.nextFirst || "red";
  room.lastTick = Date.now();
  room.over = false;
}

function finishRoom(room, winner, reason) {
  if (!room || room.over) return;
  room.over = true;
  room.busy = false;
  room.lastWinner = winner;
  room.lastReason = reason;
  room.finishedAt = Date.now();
  room.version = (room.version || 0) + 1;
  room.players.forEach((p) => { 
    p.ready = false; 
    if (p.away) p.autoResignedAt = Date.now();
  });
  const payload = { type: "relay", payload: { kind: "finish", winner: winner, reason: reason } };
  const accs = loadAcc();
  let dirty = false;
  room.players.forEach((p) => {
    send(p.ws, payload);
    if (p.ws && p.ws.account) {
      const acc = accs.find((a) => a.id === p.ws.account.id);
      if (acc) {
        acc.stats = acc.stats || { games: 0, wins: 0, losses: 0, draws: 0 };
        acc.stats.games++;
        if (winner === "draw") acc.stats.draws++;
        else if (winner === p.color) { acc.stats.wins++; acc.pts = (acc.pts || 0) + 25; }
        else { acc.stats.losses++; acc.pts = Math.max(0, (acc.pts || 0) - 12); }
        p.ws.account = acc;
        send(p.ws, { type: "account", acc: pubAcc(acc) });
        dirty = true;
      }
    }
  });
  if (dirty) saveAcc(accs);
  (room.specs || []).forEach((s) => send(s, payload));
  store.logMatch({
    room: room.id,
    winner: winner,
    reason: reason,
    timeId: room.timeId || 3,
    names: room.players.map((p) => (p.ws && p.ws.profile && p.ws.profile.name) || p.color)
  });

  room.game = null;
  room.clocks = null;

  broadcastList();
  sendRoomState(room);
}

setInterval(function () {
  const now = Date.now();
  rooms.forEach((room) => {
    if (!room.busy || room.over || !room.clocks) return;
    const dt = now - (room.lastTick || now);
    room.lastTick = now;
    const turn = room.turn || "red";
    room.clocks[turn] = Math.max(0, (room.clocks[turn] || 0) - dt);
    room.clocks.moveLeft = Math.max(0, (room.clocks.moveLeft || 0) - dt);

    if (room.clocks[turn] <= 0 || room.clocks.moveLeft <= 0) {
      const winner = turn === "red" ? "black" : "red";
      finishRoom(room, winner, (turn === "red" ? "Đỏ" : "Đen") + " hết giờ (Tự động xin thua)");
    }
  });
}, 250);

function findWaiting(exceptWs, variant) {
  pruneAll();
  const v = variant === "tuong" ? "tuong" : "up";
  const pool = [];
  for (const r of rooms.values()) {
    if (r.password) continue;
    if (r.busy) continue;
    if ((r.variant || "up") !== v) continue;
    if (r.players.length !== 1) continue;
    if (r.players[0].ws === exceptWs) continue;
    if (!live(r.players[0].ws)) continue;
    pool.push(r);
  }
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function assignColorsAndJoin(room, ws) {
  const taken = room.players[0] && room.players[0].color;
  const color = taken ? (taken === "red" ? "black" : "red") : (Math.random() < 0.5 ? "black" : "red");
  if (room.players[0] && !room.players[0].color) {
    room.players[0].color = color === "red" ? "black" : "red";
  }
  const prof = publicProfile(ws);
  room.players.push({ 
    ws, 
    host: false, 
    color: color, 
    token: ws.token, 
    ready: false,
    profile: prof,
    profileId: prof.id,
    accountId: ws.account && ws.account.id
  });
  ws.roomId = room.id;
  ws.spectate = false;
  send(ws, { type: "joined", room: room.id, color: color, count: room.players.length, variant: room.variant || "up", profile: prof, ready: false, peerReady: false });
  seat(room);
  broadcastList();
}

wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.isAlive = true;
  ws.messageWindow = { at: Date.now(), count: 0 };
  issueSession(ws);
  send(ws, { type: "session", token: ws.token });
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    if (raw.length > 64 * 1024) {
      send(ws, { type: "error", text: "Dữ liệu gửi quá lớn." });
      return;
    }
    const now = Date.now();
    if (now - ws.messageWindow.at >= 10000) ws.messageWindow = { at: now, count: 0 };
    if (++ws.messageWindow.count > 120) {
      send(ws, { type: "error", text: "Gửi quá nhanh. Vui lòng thử lại sau." });
      return;
    }

    let msg;
    try { 
      msg = JSON.parse(String(raw)); 
    } catch (e) { 
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "resume") {
      const targetToken = String(msg.token || "");
      const old = sessions.get(targetToken);
      if (old && old !== ws) {
        ws.account = old.account;
        ws.profile = old.profile;
        ws.token = old.token;
      } else if (targetToken) {
        ws.token = targetToken;
      }
      sessions.set(ws.token, ws);

      let found = null;
      rooms.forEach((room) => {
        room.players.forEach((p) => {
          if (p.token === ws.token || (old && (p.token === old.token || p.ws === old))) {
            p.ws = ws;
            p.token = ws.token;
            p.away = false;
            p.awaySince = 0;
            p.autoResignedAt = 0;
            if (p.profile) ws.profile = p.profile;
            ws.roomId = room.id;
            found = { room, player: p, color: p.color, host: !!p.host };
          }
        });
      });

      send(ws, { type: "session", token: ws.token, account: ws.account ? pubAcc(ws.account) : null });

      if (found) {
        if (found.room.busy && !found.room.over && found.room.game && found.room.clocks) {
          send(ws, { 
            type: "joined", 
            room: found.room.id, 
            color: found.color, 
            count: found.room.players.length, 
            variant: found.room.variant || "up", 
            profile: publicProfile(ws) 
          });
          restoreGameBoard(found.room, found.player, ws);
        } else {
          send(ws, {
            type: "relay",
            payload: { 
              kind: "finish", 
              winner: found.room.lastWinner || "draw", 
              reason: found.room.lastReason || "Hết giờ" 
            }
          });
          found.room.busy = false;
          found.room.over = false;
          found.room.game = null;
          found.room.clocks = null;
          found.room.players.forEach(p => { p.ready = false; p.away = false; });
          
          send(ws, { 
            type: "joined", 
            room: found.room.id, 
            color: found.color, 
            count: found.room.players.length, 
            variant: found.room.variant || "up", 
            profile: publicProfile(ws) 
          });
          seat(found.room);
        }
      } else {
        ws.roomId = null;
        send(ws, {
          type: "relay",
          payload: { kind: "finish", winner: "draw", reason: "Ván đấu cũ đã kết thúc" }
        });
        send(ws, { type: "resume-none" });
      }
      return;
    }

    if (msg.type === "create") {
      purgeUserFromAllRooms(ws);
      let id = String(msg.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (id && rooms.has(id)) { send(ws, { type: "error", text: "Tên phòng đã tồn tại" }); return; }
      if (!id) id = code();
      const password = String(msg.password || "").trim();
      const prof = publicProfile(ws);
      const room = {
        id,
        password: password || "",
        busy: false,
        specs: [],
        variant: msg.variant === "tuong" ? "tuong" : "up",
        version: 0,
        players: [{ 
          ws, 
          host: true, 
          color: "red", 
          token: ws.token, 
          ready: false,
          profile: prof,
          profileId: prof.id,
          accountId: ws.account && ws.account.id
        }]
      };
      rooms.set(id, room);
      ws.roomId = id;
      send(ws, { type: "created", room: id, password: !!password, variant: room.variant, color: "red", profile: prof });
      broadcastList();
      return;
    }

    if (msg.type === "play") {
      purgeUserFromAllRooms(ws);
      const variant = msg.variant === "tuong" ? "tuong" : "up";
      const target = findWaiting(ws, variant);
      if (target) {
        assignColorsAndJoin(target, ws);
        return;
      }
      const id = code();
      const prof = publicProfile(ws);
      const room = {
        id,
        password: "",
        busy: false,
        specs: [],
        variant: variant,
        version: 0,
        players: [{ 
          ws, 
          host: true, 
          color: "red", 
          token: ws.token, 
          ready: false,
          profile: prof,
          profileId: prof.id,
          accountId: ws.account && ws.account.id
        }]
      };
      rooms.set(id, room);
      ws.roomId = id;
      send(ws, { type: "created", room: id, password: false, waiting: true, variant: variant, color: "red", profile: prof });
      broadcastList();
      return;
    }

    if (msg.type === "join") {
      pruneAll();
      const id = String(msg.room || "").toUpperCase().trim();
      const room = rooms.get(id);
      if (!room) { send(ws, { type: "error", text: "Không có phòng này hoặc phòng đã trống" }); return; }
      if (!pruneRoom(room)) { send(ws, { type: "error", text: "Phòng đã trống và bị xóa" }); broadcastList(); return; }

      let already = room.players.find((p) => 
        p.ws === ws || 
        (p.token && (p.token === ws.token || (msg.token && p.token === msg.token))) ||
        (ws.account && p.accountId && p.accountId === ws.account.id) ||
        (ws.profile && p.profileId && p.profileId === ws.profile.id)
      );

      if (already) {
        already.ws = ws;
        already.token = ws.token;
        already.away = false;
        already.awaySince = 0;
        already.autoResignedAt = 0;
        if (already.profile) ws.profile = already.profile;
        ws.roomId = room.id;
        ws.spectate = false;

        send(ws, { 
          type: "joined", 
          room: room.id, 
          color: already.color, 
          count: room.players.length, 
          variant: room.variant || "up", 
          profile: publicProfile(ws) 
        });

        if (room.busy && !room.over && room.game && room.clocks) {
          restoreGameBoard(room, already, ws);
        } else {
          send(ws, {
            type: "relay",
            payload: { kind: "finish", winner: room.lastWinner || "draw", reason: room.lastReason || "Kết thúc" }
          });
          room.busy = false;
          room.over = false;
          room.game = null;
          room.clocks = null;
          room.players.forEach(p => { p.ready = false; });
          seat(room);
        }
        return;
      }

      if (room.players.length >= 2) {
        if (msg.spectate) {
          room.specs = room.specs || [];
          if (!room.specs.includes(ws)) room.specs.push(ws);
          if (ws.roomId && ws.roomId !== room.id) leaveRoom(ws, true);
          ws.roomId = room.id;
          ws.spectate = true;
          send(ws, { type: "spectate", room: room.id, specs: specCount(room), variant: room.variant || "up" });
          room.players.forEach((p) => send(p.ws, { type: "spec-join" }));
          sendSpecCount(room);
          broadcastList();
          return;
        }
        send(ws, { type: "error", text: "Phòng đã đủ 2 người" });
        return;
      }

      if (room.password && String(msg.password || "") !== room.password) {
        send(ws, { type: "error", text: "Sai mật khẩu phòng" });
        return;
      }

      purgeUserFromAllRooms(ws);
      assignColorsAndJoin(room, ws);
      return;
    }

    if (msg.type === "list") {
      send(ws, { type: "tables", tables: listPayload() });
      return;
    }

    if (msg.type === "leave") {
      leaveRoom(ws, false);
      return;
    }

    if (msg.type === "ready") {
      const rr = roomOf(ws);
      if (!rr) return;
      if (rr.busy && !rr.over) {
        send(ws, { type: "error", text: "Ván đang diễn ra." });
        return;
      }
      const me = rr.players.find((p) => p.ws === ws || (p.token && p.token === ws.token));
      if (!me) return;
      me.ws = ws;
      me.ready = msg.on !== undefined ? !!msg.on : !me.ready;
      rr.version = (rr.version || 0) + 1;
      rr.players.forEach((p) => send(p.ws, {
        type: "ready-state",
        count: rr.players.length,
        mine: !!p.ready,
        peer: rr.players.some((x) => x.ws !== p.ws && x.ready),
        timeId: rr.timeId || 3
      }));
      sendRoomState(rr);
      return;
    }

    if (msg.type === "resign") {
      const rr = roomOf(ws);
      if (!rr) return;
      const player = rr.players.find((p) => p.ws === ws);
      if (!player || ws.spectate) return;
      if (!rr.busy || rr.over) {
        send(ws, { type: "error", text: "Ván chưa sẵn sàng." });
        return;
      }
      send(ws, { type: "resign-accepted" });
      finishRoom(rr, player.color === "red" ? "black" : "red", (player.color === "red" ? "Đỏ" : "Đen") + " xin thua");
      return;
    }

    if (msg.type === "begin") {
      const br = roomOf(ws);
      if (!br || br.players.length < 2) return;
      const host = br.players.find((p) => p.host);
      const guest = br.players.find((p) => !p.host);
      if (!host || host.ws !== ws) return;
      if (!guest || !host.ready || !guest.ready) {
        send(ws, { type: "error", text: "Cả hai người chơi phải sẵn sàng." });
        return;
      }
      br.busy = true;
      br.over = false;
      br.version = (br.version || 0) + 1;
      br.nextFirst = br.nextFirst === "red" ? "black" : br.nextFirst === "black" ? "red" : (Math.random() < 0.5 ? "red" : "black");
      const variant = br.variant || "up";
      br.game = rules.createSecretGame(rules.makeInitialBoard(variant), variant, br.nextFirst);
      initClocks(br);
      br.turn = br.game.turn;
      br.players.forEach((p) => { p.ready = false; });
      const extra = {
        started: true,
        clocks: br.clocks,
        timeId: br.timeId || 3,
        turn: br.turn
      };
      br.players.forEach((p) => {
        send(p.ws, {
          type: "start",
          variant: br.variant || "up",
          clocks: br.clocks,
          turn: br.turn,
          timeId: br.timeId || 3,
          color: p.color,
          isHost: !!p.host,
          game: visibleGame(br.game, p.color, extra)
        });
      });
      broadcastList();
      return;
    }

    if (msg.type === "time") {
      const tr = roomOf(ws);
      if (!tr) return;
      const host = tr.players.find((p) => p.host);
      if (!host || host.ws !== ws) {
        send(ws, { type: "error", text: "Chỉ chủ phòng được đổi giờ." });
        return;
      }
      if (tr.players.some((p) => p.ready)) {
        send(ws, { type: "error", text: "Hủy sẵn sàng rồi mới đổi giờ." });
        return;
      }
      tr.timeId = msg.timeId;
      tr.players.forEach((p) => send(p.ws, { type: "time", timeId: tr.timeId }));
      return;
    }

    if (msg.type === "oauth-claim") {
      const rec = oauth.takeClaim(String(msg.claim || "")) || oauth.takeClaim(ws.token) || oauth.takeClaim(String(msg.sid || ""));
      if (!rec) { send(ws, { type: "error", text: "Đăng nhập mạng xã hội hết hạn. Bấm lại." }); return; }
      const acc = loadAcc().find((a) => a.id === rec.accId);
      if (!acc) { send(ws, { type: "error", text: "Không tìm thấy hồ sơ." }); return; }
      ws.account = acc;
      ws.profile = { id: acc.id, name: acc.name || "Đạo hữu" };
      send(ws, { type: "account", acc: pubAcc(acc), needProfile: !acc.nameSet || !acc.name });
      return;
    }

    if (msg.type === "profile-create") {
      if (!ws.account) { send(ws, { type: "error", text: "Cần đăng nhập Google/Facebook trước." }); return; }
      const next = String(msg.name || "").trim();
      if (!validName(next)) { send(ws, { type: "error", text: NAME_RULE_TEXT }); return; }
      const accs = loadAcc();
      if (accs.some((a) => a.id !== ws.account.id && norm(a.name) === norm(next))) {
        send(ws, { type: "error", text: "Tên đã có người dùng." }); return; }
      const acc = accs.find((a) => a.id === ws.account.id);
      if (!acc) return;
      acc.name = next;
      acc.nameSet = true;
      acc.renamedAt = Date.now();
      saveAcc(accs);
      ws.account = acc;
      ws.profile = { id: acc.id, name: acc.name };
      send(ws, { type: "account", acc: pubAcc(acc), needProfile: false });
      return;
    }

    if (msg.type === "hello") {
      const name = String(msg.name || "Khách").slice(0, 16);
      ws.profile = Object.assign(ws.profile || {}, { id: ws._id || (ws._id = code()), name: name });
      send(ws, { type: "hello-ok", id: ws.profile.id, name: ws.profile.name, account: !!ws.account, token: ws.token });
      broadcastPresence();
      return;
    }

    if (msg.type === "profile-save") {
      if (!ws.account) return;
      const accs = loadAcc();
      const acc = accs.find((a) => a.id === ws.account.id);
      if (!acc) return;
      const wait = 30 * 24 * 60 * 60 * 1000;
      if (typeof msg.av === "string") {
        if (acc.avatarAt && Date.now() - acc.avatarAt < wait) {
          send(ws, { type: "error", text: "Ảnh đại diện chỉ đổi 30 ngày một lần." });
          return;
        }
        const url = store.saveAvatar(acc.id, msg.av);
        if (url) {
          acc.av = url;
          acc.avatarAt = Date.now();
        }
      }
      if (msg.name) {
        const next = String(msg.name).trim();
        if (next && next !== acc.name) {
          if (!validName(next)) { send(ws, { type: "error", text: NAME_RULE_TEXT }); return; }
          if (acc.renamedAt && Date.now() - acc.renamedAt < wait) {
            send(ws, { type: "error", text: "Tên chỉ đổi 30 ngày một lần." });
            return;
          }
          if (accs.some((a) => a.id !== acc.id && norm(a.name) === norm(next))) {
            send(ws, { type: "error", text: "Tên đã có người dùng." });
            return;
          }
          acc.name = next;
          acc.renamedAt = Date.now();
        }
      }
      saveAcc(accs);
      ws.account = acc;
      send(ws, { type: "account", acc: pubAcc(acc) });
      return;
    }

    if (msg.type === "prefs") {
      ws.blockInvite = !!msg.blockInvite;
      return;
    }

    if (msg.type === "online") {
      const list = presenceList();
      send(ws, { type: "presence", n: list.length, list: list });
      return;
    }

    if (msg.type === "search") {
      const q = norm(msg.q);
      const list = [];
      if (q) {
        wss.clients.forEach((c) => {
          if (!live(c) || c === ws || !c.profile) return;
          const name = (c.account && c.account.name) || c.profile.name || "";
          if (norm(name) !== q) return;
          list.push({
            id: c.profile.id,
            name: name,
            via: (c.account && (c.account.provider || c.account.via)) || "online",
            room: c.roomId || null,
            busy: !!(c.roomId && rooms.get(c.roomId) && rooms.get(c.roomId).busy),
            online: true
          });
        });
      }
      send(ws, { type: "search", list: list.slice(0, 30) });
      return;
    }

    if (msg.type === "invite") {
      if (!ws.account) { send(ws, { type: "error", text: "Cần đăng nhập tài khoản để gửi lời mời." }); return; }
      if (ws.profile && String(msg.to) === String(ws.profile.id)) {
        send(ws, { type: "error", text: "Không thể tự mời mình." }); return; }
      const target = Array.from(wss.clients).find((c) => c.profile && c.profile.id === msg.to);
      if (!target || !live(target)) { send(ws, { type: "error", text: "Người chơi không online." }); return; }
      if (!target.account) { send(ws, { type: "error", text: "Đối phương chưa đăng nhập tài khoản." }); return; }
      if (target.blockInvite) { send(ws, { type: "error", text: "Người này đang chặn lời mời." }); return; }
      if (target.roomId && rooms.get(target.roomId) && rooms.get(target.roomId).busy) {
        send(ws, { type: "error", text: "Người này đang trong ván đấu." }); return; }
      send(target, {
        type: "invite",
        fromId: ws.profile && ws.profile.id,
        fromName: (ws.profile && ws.profile.name) || "Đạo hữu"
      });
      send(ws, { type: "error", text: "Đã gửi lời mời tới " + target.profile.name + "." });
      return;
    }

    if (msg.type === "invite-ok") {
      const from = Array.from(wss.clients).find((c) => c.profile && c.profile.id === msg.fromId);
      if (!from || !live(from)) { send(ws, { type: "error", text: "Người mời đã offline." }); return; }
      purgeUserFromAllRooms(from);
      purgeUserFromAllRooms(ws);
      const id = code();
      const fProf = publicProfile(from);
      const room = { 
        id, 
        password: "", 
        busy: false, 
        specs: [], 
        players: [{ 
          ws: from, 
          host: true, 
          color: "red", 
          token: from.token, 
          ready: false,
          profile: fProf,
          profileId: fProf.id,
          accountId: from.account && from.account.id
        }] 
      };
      rooms.set(id, room);
      from.roomId = id;
      send(from, { type: "created", room: id, password: false, variant: room.variant || "up", color: "red", profile: fProf });
      assignColorsAndJoin(room, ws);
      return;
    }

    if (msg.type === "invite-no") {
      const from = Array.from(wss.clients).find((c) => c.profile && c.profile.id === msg.fromId);
      if (from) send(from, { type: "error", text: "Đối phương từ chối lời mời." });
      return;
    }

    const room = roomOf(ws);
    if (!room) return;
    if (msg.type === "busy") { room.busy = !!msg.on; broadcastList(); }
    if (msg.type === "relay") {
      let pld = msg.payload || {};
      const player = room.players.find((p) => p.ws === ws);
      let revealedType = null;
      if (pld.kind === "chat") {
        const text = String(pld.text || "").trim().slice(0, 80);
        if (!text) return;
        const now = Date.now();
        if (ws.lastChatAt && now - ws.lastChatAt < 10000) return;
        ws.lastChatAt = now;
        const color = player ? player.color : null;
        const fallback = color === "red" ? "Đỏ" : color === "black" ? "Đen" : "Người xem";
        const who = String((ws.profile && ws.profile.name) || fallback).slice(0, 16);
        const chat = { kind: "chat", who: who, speakerId: ws.profile && ws.profile.id, color: color, text: text };
        room.players.forEach((p) => send(p.ws, { type: "relay", payload: chat }));
        (room.specs || []).forEach((s) => send(s, { type: "relay", payload: chat }));
        return;
      }
      if (!player || ws.spectate) return;
      if (pld.kind === "sync") {
        if (!player.host || room.game || !pld.game || !rules.validInitialBoard(pld.game.board, room.variant || "up")) return;
        room.game = rules.createSecretGame(pld.game.board, room.variant || "up", pld.game.turn);
        room.turn = room.game.turn;
        sendGameSync(room);
        return;
      }
      if (!["sync", "move", "finish", "chat", "draw-ask", "draw-yes", "draw-no", "draw-cancel", "profile"].includes(pld.kind)) return;
      if (pld.kind === "move") {
        if (!room.game || !room.busy || room.over) {
          send(ws, { type: "error", text: "Ván chưa sẵn sàng." });
          return;
        }
        if (room.turn !== player.color) {
          send(ws, { type: "error", text: "Chưa tới lượt." });
          sendGameSync(room);
          return;
        }
        const checked = rules.validateMove(room.game, pld.mv, player.color, room.variant || "up");
        if (!checked.ok) {
          send(ws, { type: "error", text: checked.reason });
          sendGameSync(room);
          return;
        }
        const tm = TIME[room.timeId || 3] || TIME[3];
        const moved = room.game.board[pld.mv.fromR][pld.mv.fromC];
        revealedType = moved && moved.type;
        rules.applyMove(room.game, pld.mv);
        room.turn = room.turn === "red" ? "black" : "red";
        room.clocks.moveLeft = tm.move;
        room.lastTick = Date.now();
        pld = { kind: "move", mv: pld.mv, revealedType: revealedType, turn: room.turn, clocks: room.clocks };
        room.players.forEach((p) => send(p.ws, { type: "relay", payload: pld }));
        (room.specs || []).forEach((s) => send(s, { type: "relay", payload: pld }));
        if (!rules.hasLegalMove(room.game, room.turn, room.variant || "up")) {
          room.game.over = true;
          finishRoom(room, player.color, rules.inCheck(room.game.board, room.turn, room.variant || "up") ? "Chiếu bí" : "Hết nước đi");
        }
        return;
      }
      if (pld.kind === "finish") {
        if (!room.busy || room.over || !pld.winner || !["red", "black", "draw"].includes(pld.winner)) return;
        finishRoom(room, pld.winner, pld.reason || "Kết thúc");
        return;
      }
      room.players.forEach((p) => {
        if (p.ws !== ws) send(p.ws, { type: "relay", payload: pld });
      });
      (room.specs || []).forEach((s) => send(s, { type: "relay", payload: pld }));
    }
  });

  ws.on("close", () => {
    const room = roomOf(ws);
    if (room && room.busy && !room.over) {
      const me = room.players.find((p) => p.ws === ws);
      if (me) { 
        me.away = true; 
        me.awaySince = Date.now(); 
        me.token = ws.token; 
      }
      room.players.forEach((p) => {
        if (p.ws !== ws) send(p.ws, { type: "peer-away", count: room.players.length });
      });
      return;
    }
    leaveRoom(ws, false);
  });
});

const beat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) {}
      leaveRoom(ws, false);
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
  pruneAll();
  rooms.forEach(sendRoomState);
  broadcastList();
  broadcastPresence();
}, 15000);

wss.on("close", () => clearInterval(beat));

server.listen(PORT, () => {
  console.log("Cờ Úp Online: http://localhost:" + PORT);
});