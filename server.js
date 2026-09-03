const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const store = require("./lib/store");
const oauth = require("./lib/oauth");
const rules = require("./lib/rules");
const otps = new Map();
const sessions = new Map();
const TIME = {
  3: { game: 180000, move: 15000 },
  5: { game: 300000, move: 20000 },
  10: { game: 600000, move: 30000 },
  15: { game: 900000, move: 40000 }
};

const PORT = process.env.PORT || 8080;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
async function sendOtpMail(to, otp) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER || "noreply@co-up.local";
  const subject = "Ma OTP Co Up Tu Tien";
  const text = "Ma OTP lay lai mat khau: " + otp + "\nHieu luc 2 phut. Toi da 3 lan/ngay.";
  if (process.env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: from, to: [to], subject: subject, text: text })
    });
    if (!res.ok) throw new Error("resend " + res.status);
    return;
  }
  if (process.env.SMTP_HOST) {
    let nodemailer;
    try { nodemailer = require("nodemailer"); } catch (e) { throw new Error("thieu nodemailer"); }
    const trans = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: String(process.env.SMTP_SECURE || "") === "1",
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
    await trans.sendMail({ from: from, to: to, subject: subject, text: text });
    return;
  }
  console.log("[OTP email chua cau hinh] " + to);
  throw new Error("chua-cau-hinh-email");
}
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
function hashPass(p, salt) { return store.hashPass(p, salt); }
function pubAcc(acc) { return store.pubAcc(acc); }
function norm(s) { return String(s || "").trim().toLowerCase(); }
function publicProfile(ws) {
  if (!ws || !ws.profile) return null;
  return { id: ws.profile.id, name: ws.profile.name || "Đạo hữu" };
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

function pruneRoom(room) {
  if (!room) return false;
  const now = Date.now();
  room.players = (room.players || []).filter((p) => {
    if (live(p.ws)) { p.away = false; return true; }
    if (room.busy && p.awaySince && now - p.awaySince < 90000) return true;
    return false;
  });
  room.specs = (room.specs || []).filter((s) => live(s));
  if (!room.players.length) {
    rooms.delete(room.id);
    return false;
  }
  if (!room.players.some((p) => p.host)) room.players[0].host = true;
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
    if (p.color) profiles[p.color] = publicProfile(p.ws);
  });
  room.players.forEach((p) => {
    send(p.ws, {
      type: "seated",
      room: room.id,
      color: p.color,
      isHost: !!p.host,
      count: room.players.length,
      variant: room.variant || "up",
      profile: publicProfile(p.ws),
      profiles: profiles,
      ready: !!p.ready,
      peerReady: room.players.some((x) => x.ws !== p.ws && x.ready)
    });
  });
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
  rooms.forEach((room) => {
    room.players = (room.players || []).filter((p) => p.ws !== ws);
    room.specs = (room.specs || []).filter((s) => s !== ws);
  });
  ws.roomId = null;
  ws.spectate = false;
  pruneAll();
  if (!roomId || !rooms.has(roomId)) {
    broadcastList();
    broadcastPresence();
    return;
  }
  const room = rooms.get(roomId);
  room.players = room.players.filter((p) => p.ws !== ws);
  room.specs = (room.specs || []).filter((s) => s !== ws);
  if (!pruneRoom(room)) {
    broadcastList();
    broadcastPresence();
    return;
  }
  if (wasSpec) {
    sendSpecCount(room);
  } else if (!silent) {
    room.players.forEach((p) => send(p.ws, { type: "peer-left", count: room.players.length }));
    seat(room);
  }
  sendSpecCount(room);
  broadcastList();
  broadcastPresence();
}

function roomOf(ws) {
  return ws.roomId ? rooms.get(ws.roomId) : null;
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
  room.version = (room.version || 0) + 1;
  room.players.forEach((p) => { p.ready = false; });
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
      finishRoom(room, turn === "red" ? "black" : "red", "Hết giờ");
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
  room.players.push({ ws, host: false, color: color });
  ws.roomId = room.id;
  ws.spectate = false;
  send(ws, { type: "joined", room: room.id, color: color, count: room.players.length, variant: room.variant || "up", profile: publicProfile(ws), ready: false, peerReady: false });
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
    try { msg = JSON.parse(String(raw)); } catch (e) { return; }

    if (msg.type === "resume") {
      const old = sessions.get(String(msg.token || ""));
      if (!old || old === ws) return;
      ws.account = old.account;
      ws.profile = old.profile;
      ws.token = old.token;
      sessions.set(ws.token, ws);
      let found = null;
      rooms.forEach((room) => {
        room.players.forEach((p) => {
          if (p.token === ws.token || p.ws === old) {
            p.ws = ws;
            p.away = false;
            p.awaySince = 0;
            ws.roomId = room.id;
            found = { room, color: p.color, host: !!p.host };
          }
        });
      });
      send(ws, { type: "session", token: ws.token, account: ws.account ? pubAcc(ws.account) : null });
      if (found) {
        send(ws, { type: "joined", room: found.room.id, color: found.color, count: found.room.players.length, variant: found.room.variant || "up", profile: publicProfile(ws) });
        if (found.room.busy && found.room.clocks) {
          send(ws, { type: "resume-game", clocks: found.room.clocks, turn: found.room.turn, timeId: found.room.timeId || 3, game: visibleGame(found.room.game, found.color) });
        }
        seat(found.room);
      }
      return;
    }

    if (msg.type === "create") {
      if (roomOf(ws)) leaveRoom(ws, true);
      let id = String(msg.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (id && rooms.has(id)) { send(ws, { type: "error", text: "Tên phòng đã tồn tại" }); return; }
      if (!id) id = code();
      const password = String(msg.password || "").trim();
      const room = {
        id,
        password: password || "",
        busy: false,
        specs: [],
        variant: msg.variant === "tuong" ? "tuong" : "up",
        version: 0,
        players: [{ ws, host: true, color: "red" }]
      };
      rooms.set(id, room);
      ws.roomId = id;
      send(ws, { type: "created", room: id, password: !!password, variant: room.variant, color: "red", profile: publicProfile(ws) });
      broadcastList();
      return;
    }

    if (msg.type === "play") {
      const variant = msg.variant === "tuong" ? "tuong" : "up";
      const target = findWaiting(ws, variant);
      if (target) {
        if (roomOf(ws)) leaveRoom(ws, true);
        assignColorsAndJoin(target, ws);
        return;
      }
      if (roomOf(ws)) leaveRoom(ws, true);
      const id = code();
      const room = {
        id,
        password: "",
        busy: false,
        specs: [],
        variant: variant,
        version: 0,
        players: [{ ws, host: true, color: "red" }]
      };
      rooms.set(id, room);
      ws.roomId = id;
      send(ws, { type: "created", room: id, password: false, waiting: true, variant: variant, color: "red", profile: publicProfile(ws) });
      broadcastList();
      return;
    }

    if (msg.type === "join") {
      pruneAll();
      const id = String(msg.room || "").toUpperCase().trim();
      const room = rooms.get(id);
      if (!room) { send(ws, { type: "error", text: "Không có phòng này hoặc phòng đã trống" }); return; }
      if (!pruneRoom(room)) { send(ws, { type: "error", text: "Phòng đã trống và bị xóa" }); broadcastList(); return; }

      const already = room.players.find((p) => p.ws === ws);
      if (already) {
        ws.roomId = room.id;
        send(ws, { type: "joined", room: room.id, color: already.color, count: room.players.length, variant: room.variant || "up", profile: publicProfile(ws) });
        seat(room);
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

      if (ws.roomId && ws.roomId !== room.id) leaveRoom(ws, true);
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
      const me = rr.players.find((p) => p.ws === ws);
      if (!me) return;
      me.ready = !!msg.on;
      rr.version = (rr.version || 0) + 1;
      rr.players.forEach((p) => send(p.ws, {
        type: "ready-state",
        count: rr.players.length,
        mine: !!p.ready,
        peer: rr.players.some((x) => x.ws !== p.ws && x.ready),
        timeId: rr.timeId || 3
      }));
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
      const next = String(msg.name || "").trim().slice(0, 16);
      if (next.length < 2) { send(ws, { type: "error", text: "Tên từ 2 đến 16 ký tự." }); return; }
      const accs = loadAcc();
      if (accs.some((a) => a.id !== ws.account.id && norm(a.name) === norm(next))) {
        send(ws, { type: "error", text: "Tên đã có người dùng." }); return;
      }
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

    if (msg.type === "register") {
      const contact = norm(msg.contact);
      const via = String(msg.via || "email");
      const pass = String(msg.pass || "");
      let name = String(msg.name || "").trim().slice(0, 16);
      if (!contact || contact.length < 6) {
        send(ws, { type: "error", text: "Cần email, SĐT hoặc tài khoản mạng xã hội." });
        return;
      }
      if (pass.length < 4) { send(ws, { type: "error", text: "Mật khẩu tối thiểu 4 ký tự." }); return; }
      const accs = loadAcc();
      if (accs.some((a) => a.contact === contact)) {
        send(ws, { type: "error", text: "Tài khoản đã tồn tại. Hãy đăng nhập." });
        return;
      }
      if (!name) name = "Đạo hữu";
      if (accs.some((a) => norm(a.name) === norm(name))) {
        send(ws, { type: "error", text: "Tên đã có người dùng." });
        return;
      }
      const hp = store.hashPass(pass);
      const acc = { id: code() + code(), name, contact, via, salt: hp.salt, hash: hp.hash, pts: 0, renamedAt: 0, av: "", stats: {games:0,wins:0,losses:0,draws:0} };
      accs.push(acc);
      saveAcc(accs);
      ws.account = acc;
      ws.profile = { id: acc.id, name: acc.name };
      send(ws, { type: "account", acc: pubAcc(acc) });
      return;
    }

    if (msg.type === "logout") {
      ws.account = null;
      send(ws, { type: "error", text: "Đã đăng xuất. Bạn đang là khách." });
      return;
    }

    if (msg.type === "login") {
      const contact = norm(msg.contact);
      const acc = loadAcc().find((a) => a.contact === contact);
      if (!acc || !store.checkPass(msg.pass, acc)) {
        send(ws, { type: "error", text: "Sai tài khoản hoặc mật khẩu." });
        return;
      }
      ws.account = acc;
      ws.profile = { id: acc.id, name: acc.name };
      send(ws, { type: "account", acc: pubAcc(acc) });
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
        const next = String(msg.name).trim().slice(0, 16);
        if (next && next !== acc.name) {
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

    if (msg.type === "forgot") {
      const contact = norm(msg.contact);
      const accs = loadAcc();
      const acc = accs.find((a) => a.contact === contact);
      if (!acc) { send(ws, { type: "error", text: "Không thấy tài khoản này." }); return; }
      if ((acc.via || "email") !== "email" && String(acc.contact).indexOf("@") < 0) {
        send(ws, { type: "error", text: "Chỉ gửi OTP qua email đã đăng ký." }); return;
      }
      const day = todayKey();
      if (acc.otpDay !== day) { acc.otpDay = day; acc.otpCount = 0; }
      if ((acc.otpCount || 0) >= 3) {
        send(ws, { type: "error", text: "Đã gọi OTP 3 lần hôm nay. Thử lại ngày mai." }); return;
      }
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      otps.set(contact, { otp: otp, exp: Date.now() + 2 * 60 * 1000 });
      acc.otpCount = (acc.otpCount || 0) + 1;
      saveAcc(accs);
      sendOtpMail(acc.contact, otp).then(function () {
        send(ws, {
          type: "otp",
          via: "email",
          contact: acc.contact,
          text: "OTP 6 số đã gửi về email " + acc.contact + ". Hiệu lực 2 phút."
        });
      }).catch(function (err) {
        console.log("otp mail", err && err.message);
        send(ws, {
          type: "otp",
          via: "email",
          contact: acc.contact,
          text: "Chưa gửi được email (cần SMTP/RESEND trên Render). Kiểm tra cấu hình máy chủ."
        });
      });
      return;
    }

    if (msg.type === "reset") {
      const contact = norm(msg.contact);
      const rec = otps.get(contact);
      if (!rec || rec.exp < Date.now() || rec.otp !== String(msg.otp || "")) {
        send(ws, { type: "error", text: "OTP sai hoặc hết hạn." });
        return;
      }
      if (String(msg.pass || "").length < 4) { send(ws, { type: "error", text: "Mật khẩu mới tối thiểu 4 ký tự." }); return; }
      const accs = loadAcc();
      const acc = accs.find((a) => a.contact === contact);
      if (!acc) return;
      const nextPass = hashPass(msg.pass);
      delete acc.pass;
      acc.salt = nextPass.salt;
      acc.hash = nextPass.hash;
      saveAcc(accs);
      otps.delete(contact);
      send(ws, { type: "error", text: "Đã tạo mật khẩu mới. Hãy đăng nhập." });
      return;
    }

    if (msg.type === "rename") {
      if (!ws.account) { send(ws, { type: "error", text: "Chưa đăng ký nên không đổi tên được." }); return; }
      const next = String(msg.name || "").trim().slice(0, 16);
      if (!next) return;
      const wait = 30 * 24 * 60 * 60 * 1000;
      if (ws.account.renamedAt && Date.now() - ws.account.renamedAt < wait) {
        send(ws, { type: "error", text: "Chỉ đổi tên 30 ngày một lần." });
        return;
      }
      const accs = loadAcc();
      if (accs.some((a) => a.id !== ws.account.id && norm(a.name) === norm(next))) {
        send(ws, { type: "error", text: "Tên đã có người dùng." });
        return;
      }
      const acc = accs.find((a) => a.id === ws.account.id);
      if (!acc) return;
      acc.name = next;
      acc.renamedAt = Date.now();
      saveAcc(accs);
      ws.account = acc;
      ws.profile.name = next;
      send(ws, { type: "account", acc: { name: acc.name, contact: acc.contact, via: acc.via, pts: acc.pts || 0, renamedAt: acc.renamedAt } });
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
      const online = new Map();
      wss.clients.forEach((c) => {
        if (!live(c) || !c.profile) return;
        online.set(c.profile.id, c);
        if (c.account && c.account.id) online.set(c.account.id, c);
      });
      function haystack(acc, prof) {
        return [
          prof && prof.name,
          acc && acc.name,
          acc && acc.contact,
          acc && acc.email,
          acc && acc.provider,
          acc && acc.via,
          acc && acc.providerId
        ].map((s) => norm(s)).join(" ");
      }
      const seen = new Set();
      const list = [];
      wss.clients.forEach((c) => {
        if (!live(c) || c === ws || !c.profile) return;
        if (q && haystack(c.account, c.profile).indexOf(q) < 0) return;
        seen.add(c.profile.id);
        if (c.account) seen.add(c.account.id);
        list.push({
          id: c.profile.id,
          name: (c.account && c.account.name) || c.profile.name,
          via: (c.account && (c.account.provider || c.account.via)) || "online",
          contact: c.account ? (c.account.email || c.account.contact || "") : "",
          room: c.roomId || null,
          busy: !!(c.roomId && rooms.get(c.roomId) && rooms.get(c.roomId).busy),
          online: true
        });
      });
      if (q) {
        loadAcc().forEach((acc) => {
          if (!acc || seen.has(acc.id)) return;
          if (haystack(acc, acc).indexOf(q) < 0) return;
          const liveC = online.get(acc.id);
          list.push({
            id: acc.id,
            name: acc.name || "Đạo hữu",
            via: acc.provider || acc.via || "",
            contact: acc.email || acc.contact || "",
            room: liveC ? liveC.roomId : null,
            busy: !!(liveC && liveC.roomId && rooms.get(liveC.roomId) && rooms.get(liveC.roomId).busy),
            online: !!liveC
          });
        });
      }
      send(ws, { type: "search", list: list.slice(0, 30) });
      return;
    }

    if (msg.type === "invite") {
      if (!ws.account) { send(ws, { type: "error", text: "Cần đăng nhập tài khoản để gửi lời mời." }); return; }
      if (ws.profile && String(msg.to) === String(ws.profile.id)) {
        send(ws, { type: "error", text: "Không thể tự mời mình." }); return;
      }
      const target = Array.from(wss.clients).find((c) => c.profile && c.profile.id === msg.to);
      if (!target || !live(target)) { send(ws, { type: "error", text: "Người chơi không online." }); return; }
      if (!target.account) { send(ws, { type: "error", text: "Đối phương chưa đăng nhập tài khoản." }); return; }
      if (target.blockInvite) { send(ws, { type: "error", text: "Người này đang chặn lời mời." }); return; }
      if (target.roomId && rooms.get(target.roomId) && rooms.get(target.roomId).busy) {
        send(ws, { type: "error", text: "Người này đang trong ván đấu." }); return;
      }
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
      if (roomOf(from)) leaveRoom(from, true);
      if (roomOf(ws)) leaveRoom(ws, true);
      const id = code();
      const room = { id, password: "", busy: false, specs: [], players: [{ ws: from, host: true, color: "red" }] };
      rooms.set(id, room);
      from.roomId = id;
      send(from, { type: "created", room: id, password: false, variant: room.variant || "up", color: "red", profile: publicProfile(from) });
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
      if (me) { me.away = true; me.awaySince = Date.now(); me.token = ws.token; }
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
