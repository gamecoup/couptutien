/* net.js — phòng chơi WebSocket */
var pendingAuth = null;
var oauthLoginPending = false;
var netConnectWaiters = [];
var playPending = false;
var netReconnectTimer = null;
var netReconnectDelay = 2000;

// Tiền biên dịch Regex và bảng ánh xạ tĩnh để tối đa hóa tốc độ escape chuỗi
const HTML_ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const HTML_ESCAPE_REGEX = /[&<>"']/g;
function escapeNetHtml(value) {
  return String(value == null ? "" : value).replace(HTML_ESCAPE_REGEX, function (ch) {
    return HTML_ESCAPE_MAP[ch];
  });
}

// Hàm tự động cắt vuông và nén ảnh avatar siêu nhẹ (~15KB - 20KB) chống diss mạng
function compressAvatarFile(file, callback) {
  if (!file || !file.type.startsWith("image/")) return;
  var reader = new FileReader();
  reader.onload = function (e) {
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement("canvas");
      var size = 128;
      canvas.width = size;
      canvas.height = size;
      var ctx = canvas.getContext("2d");

      var minSide = Math.min(img.width, img.height);
      var sx = (img.width - minSide) / 2;
      var sy = (img.height - minSide) / 2;

      ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, size, size);
      callback(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Helpers thao tác DOM an toàn, chống văng lỗi nếu thiếu element
function safeEl(id) {
  return document.getElementById(id);
}
function safeText(id, txt) {
  var el = safeEl(id);
  if (el) el.textContent = txt;
}
function safeClick(id, fn) {
  var el = safeEl(id);
  if (el) el.onclick = fn;
}

function netUrl() {
  var proto = location.protocol === "https:" ? "wss://" : "ws://";
  var host = location.host || "localhost:8080";
  return proto + host + "/ws";
}

function netSend(obj) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj));
}

function relay(payload) {
  netSend({ type: "relay", payload: payload });
}

function importGame(g) {
  if (!g) return;
  state = {
    board: g.board,
    turn: g.turn,
    over: g.over,
    winner: g.winner,
    ply: g.ply,
    reason: g.reason || null,
    captured: g.captured || { red: [], black: [] },
    quietPly: g.quietPly || 0,
    trace: g.trace || []
  };
  if (g.clocks) clocks = g.clocks;
  if (g.nextFirst) nextFirst = g.nextFirst;
  pendingDraw = g.pendingDraw || null;
  var tm = TIME_MODES.find(function (m) { return m.id === g.timeId; });
  if (tm) timeMode = tm;
  if (typeof g.started === "boolean") started = g.started;
  else started = !g.over;
  selected = null;
  hints = [];
  lastTick = performance.now();
  hideOverlay();
  hideDrawAsk();
  if (typeof moveLock !== "undefined") moveLock = false;
  var readyGateEl = safeEl("readyGate");
  if (started && !state.over) {
    if (readyGateEl) readyGateEl.classList.remove("show");
    if (typeof hideStartButton === "function") hideStartButton();
    if (typeof setPlayingUI === "function") setPlayingUI(true);
  } else if (typeof updateReadyUI === "function") updateReadyUI();
  if (typeof renderModes === "function") renderModes();
  paintCaptures(); paintClocks(); paintRanks(); setStatus(); draw();
  if (started && !state.over) startTick();
  else stopTick();
}

function handleRelay(p) {
  if (!p) return;
  switch (p.kind) {
    case "sync":
      importGame(p.game);
      break;
    case "move":
      if (p.clocks) clocks = p.clocks;
      applyMove(p.mv, true, { revealedType: p.revealedType });
      break;
    case "finish":
      finish(p.winner, p.reason, true);
      break;
    case "chat":
      showChat(p.who || "Đạo hữu", p.text || "");
      break;
    case "draw-ask":
      onDrawAsked(p.from);
      break;
    case "draw-yes":
      acceptDraw(true);
      break;
    case "draw-no":
      declineDraw(true);
      break;
    case "draw-cancel":
      cancelDraw(true);
      break;
    case "profile":
      if (p.color && net.color && p.color === net.color) return;
      if (!net.profiles) net.profiles = {};
      net.profiles[p.color] = p.profile || {};
      if (typeof paintSeats === "function") paintSeats();
      else if (p.profile && p.profile.av && typeof setAvatar === "function") setAvatar(p.color, p.profile.av);
      break;
    case "lobby":
      started = false;
      myReady = false;
      peerReady = false;
      stopTick();
      hideOverlay();
      hideDrawAsk();
      if (typeof goTable === "function") goTable();
      safeText("netHint", "Phòng " + net.room + " · bạn cầm " + (net.color === "red" ? "Đỏ" : "Đen") + ". Đợi chủ phòng bắt đầu ván mới.");
      break;
  }
}

function applySeat(msg) {
  net.room = msg.room;
  net.online = true;
  if (msg.variant) net.variant = msg.variant === "tuong" ? "tuong" : "up";
  if (typeof applyVariantUI === "function") applyVariantUI();
  if (msg.color) net.color = msg.color;
  if (msg.profile && net.color) {
    if (!net.profiles) net.profiles = {};
    net.profiles[net.color] = msg.profile;
  }
  if (msg.profiles) {
    if (!net.profiles) net.profiles = {};
    var pKeys = Object.keys(msg.profiles);
    for (var i = 0; i < pKeys.length; i++) {
      var color = pKeys[i];
      if (msg.profiles[color]) net.profiles[color] = msg.profiles[color];
    }
  }
  if (typeof msg.isHost === "boolean") net.isHost = msg.isHost;
  if (typeof msg.count === "number") net.count = msg.count;
  if (typeof msg.ready === "boolean") myReady = msg.ready;
  if (typeof msg.peerReady === "boolean") peerReady = msg.peerReady;
  if (!started && typeof resetBoard === "function") resetBoard();
  if (typeof applyViewLayout === "function") applyViewLayout();
  if (typeof paintSeats === "function") paintSeats();
  if (!started && typeof updateReadyUI === "function") updateReadyUI();
  var side = net.color === "red" ? "Đỏ" : net.color === "black" ? "Đen" : "?";
  if (msg.count >= 2 && net.color) {
    safeText("netHint", "Phòng " + net.room + " · bạn cầm " + side + (net.isHost ? ". Bấm Sẵn sàng để bắt đầu." : ". Đợi chủ phòng bấm Sẵn sàng."));
    addLog("Hai người đã vào phòng. Bạn cầm " + side + ".");
    hideHall();
    shareMyProfile();
    if (typeof playKnock === "function") playKnock();
  }
}

function shareMyProfile() {
  if (!net.color) return;
  const me = loadMe();
  const st = (typeof myStats === "function") ? myStats() : { games: 0, wins: 0, losses: 0, draws: 0 };
  const avs = (function () {
    try { return JSON.parse(localStorage.getItem("coupAvatars") || "{}"); }
    catch (e) { return {}; }
  })();
  const prof = {
    name: (typeof ownName === "function" ? ownName() : ((net.account && net.account.name) || me.name || "Đạo hữu")),
    av: (typeof ownAvatarSrc === "function" ? ownAvatarSrc() : (me.av || avs[net.color] || "")),
    games: st.games || 0,
    wins: st.wins || 0,
    losses: st.losses || 0,
    draws: st.draws || 0,
    pts: (net.account && net.account.pts) || 0
  };
  if (!net.profiles) net.profiles = {};
  net.profiles[net.color] = prof;
  if (prof.av && typeof setAvatar === "function") setAvatar(net.color, prof.av);
  relay({ kind: "profile", color: net.color, profile: prof });
}

function onNetMsg(ev) {
  var msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  if (oauthLoginPending && (msg.type === "joined" || msg.type === "seated" ||
      msg.type === "resume-game" || msg.type === "relay" || msg.type === "peer-left")) return;

  switch (msg.type) {
    case "hello-ok":
      net.myId = msg.id;
      netSend({ type: "online" });
      break;

    case "session":
      if (msg.token) sessionStorage.setItem("coupSess", msg.token);
      if (msg.account) net.account = msg.account;
      break;

    case "resume-game":
      if (oauthLoginPending) return;
      if (msg.clocks) clocks = msg.clocks;
      if (msg.timeId) {
        var tmg = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
        if (tmg) timeMode = tmg;
      }
      if (msg.game && msg.game.board) {
        importGame({
          board: msg.game.board, turn: msg.turn, over: false, winner: null,
          ply: msg.game.ply || 0, captured: msg.game.captured || { red: [], black: [] },
          clocks: msg.clocks, timeId: msg.timeId, started: true
        });
      } else {
        started = true;
      }
      var rGate = safeEl("readyGate");
      if (rGate) rGate.classList.remove("show");
      if (typeof startTick === "function") startTick();
      if (!oauthLoginPending) goTable();
      break;

    case "peer-away":
      addLog("Đối thủ mất kết nối. Đang chờ vào lại...");
      break;

    case "resume-none":
      var gWrap = safeEl("gameWrap");
      if (net.room || (gWrap && gWrap.classList.contains("show"))) {
        addLog("Bàn cũ đã kết thúc do quá hạn chờ kết nối lại.");
        safeText("netHint", "Bàn cũ đã kết thúc do quá hạn chờ kết nối lại.");
        goHome();
      }
      break;

    case "error":
      playPending = false;
      var playButton = safeEl("btnPlayNow");
      if (playButton) playButton.disabled = false;
      if (typeof resignPending !== "undefined") {
        resignPending = false;
        var rBtn = safeEl("btnResign");
        if (rBtn) rBtn.disabled = false;
      }
      if (typeof moveLock !== "undefined") moveLock = false;
      safeText("netHint", msg.text);
      addLog(msg.text);
      if (typeof selected !== "undefined") { selected = null; hints = []; }
      if (typeof draw === "function") draw();
      break;

    case "resign-accepted":
      if (typeof resignPending !== "undefined") {
        resignPending = false;
        var rBtnOk = safeEl("btnResign");
        if (rBtnOk) rBtnOk.disabled = false;
      }
      break;

    case "created":
      playPending = false;
      var btnPNow = safeEl("btnPlayNow");
      if (btnPNow) btnPNow.disabled = false;
      net.room = msg.room;
      net.isHost = true;
      net.online = true;
      net.profiles = {};
      net.color = msg.color || "red";
      if (msg.profile) net.profiles[net.color] = msg.profile;
      myReady = false;
      peerReady = false;
      if (msg.variant) net.variant = msg.variant === "tuong" ? "tuong" : "up";
      if (typeof applyVariantUI === "function") applyVariantUI();
      var lock = msg.password ? " (có mật khẩu)" : " (công khai)";
      var wait = msg.waiting ? " Chưa có phòng trống — đang ngồi chờ." : "";
      safeText("netHint", "Phòng " + msg.room + lock + ". Ngồi chờ đối thủ." + wait);
      addLog("Vào phòng chờ " + msg.room + lock);
      net.count = 1;
      if (typeof paintSeats === "function") paintSeats();
      if (!oauthLoginPending) goTable();
      break;

    case "joined":
      playPending = false;
      var btnPNowJ = safeEl("btnPlayNow");
      if (btnPNowJ) btnPNowJ.disabled = false;
      net.room = msg.room;
      net.isHost = false;
      net.online = true;
      if (!net.profiles) net.profiles = {};
      myReady = !!msg.ready;
      peerReady = !!msg.peerReady;
      if (msg.variant) net.variant = msg.variant === "tuong" ? "tuong" : "up";
      if (typeof applyVariantUI === "function") applyVariantUI();
      if (msg.color) net.color = msg.color;
      if (msg.profile && net.color) net.profiles[net.color] = msg.profile;
      safeText("netHint", "Đã vào " + msg.room + ".");
      addLog("Đã vào phòng " + msg.room);
      if (!oauthLoginPending) goTable();
      if (typeof applyViewLayout === "function") applyViewLayout();
      if (typeof paintSeats === "function") paintSeats();
      if (typeof updateReadyUI === "function") updateReadyUI();
      break;

    case "spectate":
      net.room = msg.room;
      net.online = true;
      net.profiles = {};
      if (msg.variant) net.variant = msg.variant === "tuong" ? "tuong" : "up";
      if (typeof applyVariantUI === "function") applyVariantUI();
      net.spectate = true;
      net.color = null;
      net.isHost = false;
      net.specs = msg.specs || 0;
      if (typeof paintSpecBox === "function") paintSpecBox(net.specs);
      if (typeof paintSeats === "function") paintSeats();
      addLog("Đang xem bàn " + msg.room);
      hideHall();
      goTable();
      if (typeof updateReadyUI === "function") updateReadyUI();
      break;

    case "spec-join":
      if (!net.spectate && state && typeof exportGame === "function") {
        relay({ kind: "sync", game: exportGame() });
      }
      break;

    case "presence":
      renderOnline(msg.list || [], msg.n || 0);
      break;

    case "tables":
      renderHall(msg.tables || []);
      break;

    case "seated":
      applySeat(msg);
      break;
      case "peer-join":
      if (typeof playRoomSound === "function") playRoomSound("join");
      else if (typeof playDoor === "function") playDoor();
      break;

    case "peer-left":
      if (typeof playRoomSound === "function") playRoomSound("leave");
      else if (typeof playDoor === "function") playDoor();
      net.count = msg.count || 1;
      addLog("Đối thủ mất kết nối. Phòng còn " + (msg.count || 1) + " người.");
      peerReady = false;
      myReady = false;
      if (started) { started = false; stopTick(); }
      if (net.profiles && net.color) {
        var oppColor = net.color === "red" ? "black" : "red";
        delete net.profiles[oppColor];
      }
      if (typeof paintSeats === "function") paintSeats();
      if (typeof updateReadyUI === "function") updateReadyUI();
      break;

    case "relay":
      handleRelay(msg.payload);
      break;

    case "search":
      renderFind(msg.list || []);
      break;

    case "invite":
      if (!net.account || net.blockInvite) {
        netSend({ type: "invite-no", fromId: msg.fromId });
        return;
      }
      showInvite(msg);
      break;

    case "spec-count":
      net.specs = msg.n || 0;
      if (typeof paintSpecBox === "function") paintSpecBox(net.specs);
      break;

    case "otp":
      safeText("authTitle", "OTP lấy lại mật khẩu");
      safeText("authText", msg.text);
      var authOtp = safeEl("authOtp");
      var authNewPass = safeEl("authNewPass");
      var authPop = safeEl("authPop");
      if (authOtp) authOtp.style.display = "inline-block";
      if (authNewPass) authNewPass.style.display = "inline-block";
      if (authPop) authPop.classList.add("show");
      pendingAuth = { kind: "reset", contact: msg.contact };
      break;

    case "account":
      net.account = msg.acc;
      var hName = safeEl("homeName");
      if (hName) {
        hName.value = msg.acc.name;
        hName.classList.remove("guest-name");
      }
      safeText("homeHint", "Đã đăng ký: " + msg.acc.name + " · " + msg.acc.via);
      var me2 = loadMe();
      me2.name = msg.acc.name;
      me2.contact = msg.acc.contact;
      if (msg.acc.av) me2.av = msg.acc.av;
      saveMe(me2);
      if (typeof paintHomeProfile === "function") paintHomeProfile();
      else if (msg.acc.av) {
        var hAv = safeEl("homeAv");
        if (hAv) hAv.innerHTML = '<img alt="" src="' + msg.acc.av + '">';
      }
      if (msg.acc.stats && typeof saveStats === "function") saveStats(msg.acc.stats);
      if (typeof msg.acc.pts === "number" && net.color) {
        scores[net.color] = msg.acc.pts;
        if (typeof paintRanks === "function") paintRanks();
      }
      if (typeof paintSeats === "function") paintSeats();
      net.guest = false;
      if (oauthLoginPending) {
        oauthLoginPending = false;
        clearRoomState(true);
      }
      var lGate = safeEl("loginGate");
      var aPop = safeEl("authPop");
      if (lGate) lGate.classList.remove("show");
      if (aPop) aPop.classList.remove("show");
      if (window.oauthWin && !window.oauthWin.closed) {
        try { window.oauthWin.close(); } catch (e) {}
        window.oauthWin = null;
      }
      applyAuthUI();
      var pPop = safeEl("profilePop");
      if (msg.needProfile && !(msg.acc && msg.acc.name)) openProfilePop();
      else if (pPop) pPop.classList.remove("show");
      break;

    case "ready-state":
      myReady = !!msg.mine;
      peerReady = !!msg.peer;
      if (msg.timeId && !(started && state && !state.over)) {
        var tmReady = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
        if (tmReady) { timeMode = tmReady; renderModes(); paintClocks(); }
      }
      if (typeof updateReadyUI === "function") updateReadyUI();
      break;

    case "room-state":
      if (msg.room && net.room && msg.room !== net.room) return;
      if (typeof msg.version === "number" && msg.version < (net.roomVersion || 0)) return;
      if (typeof msg.version === "number") net.roomVersion = msg.version;
      if (msg.variant) {
        net.variant = msg.variant === "tuong" ? "tuong" : "up";
        if (typeof applyVariantUI === "function") applyVariantUI();
      }
      if (typeof msg.count === "number") net.count = msg.count;
      myReady = !!msg.ready;
      peerReady = !!msg.peerReady;
      if (typeof updateReadyUI === "function") updateReadyUI();
      break;

    case "time":
      var tm2 = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
      if (tm2) {
        timeMode = tm2;
        clocks = { red: timeMode.gameMs, black: timeMode.gameMs, moveLeft: timeMode.moveMs };
        renderModes(); paintClocks();
      }
      break;

    case "start":
      if (msg.variant) {
        net.variant = msg.variant === "tuong" ? "tuong" : "up";
        if (typeof applyVariantUI === "function") applyVariantUI();
      }
      if (typeof hideStartButton === "function") hideStartButton();
      var rGateStart = safeEl("readyGate");
      if (rGateStart) rGateStart.classList.remove("show");
      if (typeof msg.color === "string") net.color = msg.color;
      if (typeof msg.isHost === "boolean") net.isHost = msg.isHost;
      if (msg.clocks) clocks = msg.clocks;
      if (msg.timeId) {
        var tms = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
        if (tms) timeMode = tms;
      }
      myReady = false;
      peerReady = false;
      if (typeof resignPending !== "undefined") resignPending = false;
      if (typeof moveLock !== "undefined") moveLock = false;
      if (msg.game && msg.game.board) {
        importGame({
          board: msg.game.board,
          turn: msg.turn || msg.game.turn,
          over: false,
          winner: null,
          ply: msg.game.ply || 0,
          captured: msg.game.captured || { red: [], black: [] },
          clocks: msg.clocks || msg.game.clocks,
          timeId: msg.timeId || msg.game.timeId,
          started: true
        });
        if (typeof applyViewLayout === "function") applyViewLayout();
        if (typeof hideHall === "function") hideHall();
        if (typeof ensureAudio === "function") ensureAudio();
        if (typeof musicOn !== "undefined" && musicOn && typeof startMusic === "function") startMusic();
        if (typeof playStartJingle === "function") playStartJingle();
        if (typeof setPlayingUI === "function") setPlayingUI(true);
        addLog((timeMode && timeMode.label ? timeMode.label + " · " : "") + ((msg.turn || state.turn) === "red" ? "Đỏ" : "Đen") + " đi trước.");
      } else if (net.vsBot) {
        startMatch(false);
      } else {
        started = true;
        if (typeof setPlayingUI === "function") setPlayingUI(true);
        if (typeof playStartJingle === "function") playStartJingle();
        if (typeof renderModes === "function") renderModes();
        if (typeof startTick === "function") startTick();
        if (typeof setStatus === "function") setStatus();
        if (typeof paintClocks === "function") paintClocks();
      }
      break;
  }
}

function connectNet(cb) {
  safeText("netHint", "Đang kết nối máy chủ...");
  if (net.ws && net.ws.readyState === 1) { if (cb) cb(); return; }
  if (cb) netConnectWaiters.push(cb);
  if (net.ws && net.ws.readyState === 0) return;
  try {
    net.ws = new WebSocket(netUrl());
  } catch (e) {
    net.ws = null;
    netConnectWaiters = [];
    safeText("netHint", "Không mở được WebSocket.");
    scheduleReconnect();
    return;
  }
  var socket = net.ws;
  socket.onopen = function () {
    safeText("netHint", "Đã kết nối. Tạo hoặc vào phòng.");
    netReconnectDelay = 2000;
    clearTimeout(netReconnectTimer);
    var tok = sessionStorage.getItem("coupSess");
    if (tok && !oauthLoginPending && signedIn()) netSend({ type: "resume", token: tok });
    sendHello();
    var waiters = netConnectWaiters.splice(0);
    for (var i = 0; i < waiters.length; i++) waiters[i]();
  };
  socket.onmessage = onNetMsg;
  socket.onclose = function () {
    if (net.ws !== socket) return;
    addLog("Mất kết nối máy chủ.");
    net.ws = null;
    netConnectWaiters = [];
    playPending = false;
    var playButton = safeEl("btnPlayNow");
    if (playButton) playButton.disabled = false;
    if (started && state && !state.over && net.online && !net.vsBot && !net.spectate && typeof stopTick === "function") {
      stopTick();
    }
    scheduleReconnect();
  };
  socket.onerror = function () {
    safeText("netHint", "Lỗi kết nối. Chạy server rồi mở http://localhost:8080");
  };
}

function scheduleReconnect() {
  clearTimeout(netReconnectTimer);
  netReconnectTimer = setTimeout(function () {
    if (!net.ws || net.ws.readyState === 3) connectNet();
    netReconnectDelay = Math.min(netReconnectDelay * 1.5, 15000);
  }, netReconnectDelay);
}

window.addEventListener("online", function () {
  if (!net.ws || net.ws.readyState === 3) connectNet();
});

function goLogin() {
  hideHall();
  var hub = safeEl("hub"), home = safeEl("home"), gWrap = safeEl("gameWrap"), lGate = safeEl("loginGate");
  if (hub) hub.classList.remove("show");
  if (home) home.classList.add("show");
  if (gWrap) gWrap.classList.remove("show");
  if (lGate) lGate.classList.add("show");
}

function goHub() {
  hideHall();
  var lGate = safeEl("loginGate"), home = safeEl("home"), gWrap = safeEl("gameWrap"), hub = safeEl("hub");
  if (lGate) lGate.classList.remove("show");
  if (home) home.classList.add("show");
  if (gWrap) gWrap.classList.remove("show");
  if (hub) hub.classList.remove("show");
  net.vsBot = false;
}

function clearRoomState(sendLeave) {
  if (sendLeave && net.room) netSend({ type: "leave" });
  net.room = null;
  net.color = null;
  net.isHost = false;
  net.count = 0;
  net.roomVersion = 0;
  net.spectate = false;
  net.vsBot = false;
  myReady = false;
  peerReady = false;
  started = false;
  if (typeof stopTick === "function") stopTick();
  if (typeof resetBoard === "function") resetBoard();
}

function applyVariantUI() {
  var brand = safeEl("homeBrand");
  if (brand) brand.textContent = net.variant === "tuong" ? "CỜ TƯỚNG" : "CỜ ÚP TU TIÊN";
}

function openMode(variant) {
  net.variant = variant === "tuong" ? "tuong" : "up";
  net.vsBot = false;
  if (typeof resetBoard === "function") resetBoard();
  applyVariantUI();
  var hub = safeEl("hub"), home = safeEl("home");
  if (hub) hub.classList.remove("show");
  if (home) home.classList.add("show");
}

function goHome() {
  hideHall();
  var hub = safeEl("hub"), home = safeEl("home"), gWrap = safeEl("gameWrap");
  if (hub) hub.classList.remove("show");
  if (home) home.classList.add("show");
  if (gWrap) gWrap.classList.remove("show");
  applyVariantUI();
  if (typeof stopMusic === "function") stopMusic();
  if (typeof stopTracks === "function") stopTracks();
  if (typeof startHomeMusic === "function") startHomeMusic();
  clearRoomState(!!net.room);
  net.spectate = false;
}

function goTable() {
  var home = safeEl("home"), gWrap = safeEl("gameWrap");
  if (home) home.classList.remove("show");
  hideHall();
  if (gWrap) gWrap.classList.add("show");
  if (typeof clearChatLog === "function") clearChatLog();
  if (typeof stopHomeMusic === "function") stopHomeMusic();
  if (typeof startMusic === "function") startMusic();
  if (typeof layout === "function") layout();
  if (typeof draw === "function" && state) draw();
  if (typeof updateReadyUI === "function") updateReadyUI();
}

function showHall() {
  var hall = safeEl("hall");
  if (hall) hall.classList.add("show");
  netSend({ type: "list" });
}

function hideHall() {
  var hall = safeEl("hall");
  if (hall) hall.classList.remove("show");
}

function joinTable(t) {
  if (!t || !t.id) return;
  if (t.id === net.room) return;
  if (t.n < 2 && t.lock) {
    var pw = prompt("Mật khẩu bàn " + t.id) || "";
    netSend({ type: "join", room: t.id, password: pw });
    return;
  }
  if (t.n < 2) netSend({ type: "join", room: t.id });
  else netSend({ type: "join", room: t.id, spectate: true });
}

function renderOnline(list, n) {
  var btn = safeEl("btnOnline");
  if (btn) btn.textContent = (n || list.length || 0) + " người đang online";
  var box = safeEl("onlineList");
  if (!box) return;
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = "<div class='on-row'>Chưa thấy đạo hữu khác.</div>";
    return;
  }
  var frag = document.createDocumentFragment();
  list.forEach(function (u) {
    var row = document.createElement("div");
    row.className = "on-row";
    var st = u.busy ? "đang đấu" : (u.room ? "trong bàn" : "rảnh");
    row.innerHTML = "<span>" + escapeNetHtml(u.name || "Đạo hữu") + " · " + escapeNetHtml(st) + "</span>";
    if (u.id && u.id === net.myId) {
      frag.appendChild(row);
      return;
    }
    if (!u.busy && u.id && net.account && u.logged) {
      var b = document.createElement("button");
      b.textContent = "Mời";
      b.onclick = function (ev) {
        ev.stopPropagation();
        if (!net.account) { addLog("Cần đăng nhập tài khoản để gửi lời mời."); return; }
        if (u.id === net.myId) return;
        netSend({ type: "invite", to: u.id });
      };
      row.appendChild(b);
    }
    frag.appendChild(row);
  });
  box.appendChild(frag);
}

function renderHall(tables) {
  var strip = safeEl("hallStrip");
  if (!strip) return;
  strip.innerHTML = "";
  tables = (tables || []).filter(function (t) {
    return (t.variant || "up") === (net.variant || "up");
  });
  if (!tables.length) {
    strip.innerHTML = "<div class='tbl'><div class='tid'>—</div><div class='st'>Chưa có bàn nào</div></div>";
    return;
  }
  var frag = document.createDocumentFragment();
  tables.forEach(function (t) {
    var d = document.createElement("div");
    d.className = "tbl" + (t.id === net.room ? " mine" : "");
    var st = t.busy ? "Đang chơi" : (t.n < 2 ? "Đang chờ" : "Đủ 2 người");
    if (t.lock) st += " · có mật khẩu";
    d.innerHTML = "<div class='tid'>" + escapeNetHtml(t.id) + "</div><div class='st'>" + escapeNetHtml(st) +
      "</div><div class='st'>" + escapeNetHtml(t.n + "/2 người" + (t.specs ? " · xem " + t.specs : "")) + "</div>";
    if (t.id !== net.room) {
      var b = document.createElement("button");
      b.textContent = t.n < 2 ? (t.lock ? "Nhập mật khẩu" : "Vào chơi") : "Vào xem";
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        joinTable(t);
      });
      d.appendChild(b);
      d.addEventListener("click", function () { joinTable(t); });
    }
    frag.appendChild(d);
  });
  strip.appendChild(frag);
}

(function bindHallDrag() {
  var el = safeEl("hallStrip");
  if (!el) return;
  var down = false, dragged = false, x0 = 0, sl = 0;
  el.addEventListener("pointerdown", function (e) {
    if (e.target && e.target.closest && e.target.closest("button")) return;
    down = true; dragged = false; x0 = e.clientX; sl = el.scrollLeft;
  });
  el.addEventListener("pointermove", function (e) {
    if (!down) return;
    var dx = e.clientX - x0;
    if (Math.abs(dx) > 8) dragged = true;
    if (dragged) el.scrollLeft = sl - dx;
  });
  el.addEventListener("pointerup", function () { down = false; });
  el.addEventListener("click", function (e) {
    if (dragged) { e.preventDefault(); e.stopPropagation(); dragged = false; }
  }, true);
})();

function clientKey() {
  var id = sessionStorage.getItem("coupClient");
  if (!id) {
    id = "c" + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem("coupClient", id);
  }
  return "coupMe:" + id;
}

function loadMe() {
  try { return JSON.parse(sessionStorage.getItem(clientKey()) || localStorage.getItem(clientKey()) || "{}"); }
  catch (e) { return {}; }
}

function saveMe(me) {
  try {
    var raw = JSON.stringify(me);
    sessionStorage.setItem(clientKey(), raw);
    localStorage.setItem(clientKey(), raw);
  } catch (e) {}
}

function signedIn() { return !!(net.account || net.guest); }

function applyAuthUI() {
  var out = safeEl("btnLogout");
  var gate = safeEl("loginGate");
  var isAuth = signedIn();
  if (out) out.style.display = isAuth ? "inline-block" : "none";
  if (gate) gate.classList.toggle("show", !isAuth);

  var gameWrap = safeEl("gameWrap");
  var onGame = gameWrap && gameWrap.classList.contains("show");
  var homeEl = safeEl("home");
  var hubEl = safeEl("hub");

  if (isAuth) {
    if (!onGame && homeEl) homeEl.classList.add("show");
    if (gate) gate.classList.remove("show");
    if (hubEl) hubEl.classList.remove("show");
  } else {
    if (homeEl) homeEl.classList.add("show");
    if (gameWrap) gameWrap.classList.remove("show");
    if (hubEl) hubEl.classList.remove("show");
  }
  var hint = safeEl("homeHint");
  if (!hint) return;
  if (net.account) {
    hint.textContent = "Xin chào " + (net.account.name || "đạo hữu") + " · " + (net.account.provider || net.account.via || "tài khoản");
    var nma = safeEl("homeName");
    if (nma) {
      nma.classList.remove("guest-name");
      if (net.account.name) nma.value = net.account.name;
    }
  } else if (net.guest) {
    hint.textContent = "Đang vào với tư cách khách. Thành tích không lưu.";
    var nm = safeEl("homeName");
    if (nm) {
      nm.value = "KHÁCH";
      nm.classList.add("guest-name");
      nm.readOnly = true;
    }
  } else {
    hint.textContent = "Chọn cách vào sảnh cờ.";
  }
}

function mustLogin() {
  if (signedIn()) return true;
  applyAuthUI();
  safeText("homeHint", "Cần vào với tư cách khách hoặc đăng nhập Google/Facebook.");
  return false;
}

function openProfilePop() {
  var pop = safeEl("profilePop");
  if (pop) pop.classList.add("show");
}

function sendHello() {
  var nameInp = safeEl("homeName");
  var name = (nameInp && nameInp.value) || loadMe().name || "Đạo hữu";
  netSend({ type: "hello", name: name });
}

function renderFind(list) {
  var box = safeEl("findList");
  if (!box) return;
  box.innerHTML = "";
  if (!list.length) { box.textContent = "Không thấy đạo hữu khớp."; return; }
  var frag = document.createDocumentFragment();
  list.forEach(function (u) {
    var row = document.createElement("div");
    row.className = "find-row";
    var extra = u.via ? (" · " + u.via) : "";
    var st = u.online === false ? " · offline" : (u.busy ? " · đang đấu" : u.room ? " · trong bàn" : " · rảnh");
    row.innerHTML = "<span>" + escapeNetHtml(u.name) + escapeNetHtml(extra + st) + "</span>";
    var b = document.createElement("button");
    b.textContent = "Mời";
    b.disabled = !!u.busy;
    b.onclick = function () { netSend({ type: "invite", to: u.id }); };
    row.appendChild(b);
    frag.appendChild(row);
  });
  box.appendChild(frag);
}

function showInvite(msg) {
  safeText("inviteText", (msg.fromName || "Đạo hữu") + " mời bạn tỷ thí.");
  var invPop = safeEl("invitePop");
  if (invPop) invPop.classList.add("show");
  safeClick("btnInvYes", function () {
    if (invPop) invPop.classList.remove("show");
    netSend({ type: "invite-ok", fromId: msg.fromId });
    var home = safeEl("home");
    if (home) home.classList.remove("show");
    if (typeof goTable === "function") goTable();
  });
  safeClick("btnInvNo", function () {
    if (invPop) invPop.classList.remove("show");
    netSend({ type: "invite-no", fromId: msg.fromId });
  });
}

(function initHome() {
  var me = loadMe();
  var homeNameEl = safeEl("homeName");
  var homeAvEl = safeEl("homeAv");
  if (me.name && homeNameEl) homeNameEl.value = me.name;
  if (me.av && homeAvEl) homeAvEl.innerHTML = '<img alt="" src="' + me.av + '">';
  var hm = safeEl("btnHomeMusic");
  var hv = safeEl("volHome");
  if (hv) hv.value = Math.round((typeof homeVol !== "undefined" ? homeVol : 0.35) * 100);
  if (hm) {
    hm.onclick = function () {
      homeMusicOn = !homeMusicOn;
      hm.style.opacity = homeMusicOn ? "1" : "0.45";
      if (homeMusicOn) startHomeMusic();
      else stopHomeMusic();
    };
  }
  if (hv) {
    hv.oninput = function () {
      homeVol = Math.max(0, Math.min(1, (this.value | 0) / 100));
      var el = safeEl("audHome");
      if (el) el.volume = homeVol;
      if (homeMusicOn && (typeof homeTimer === "undefined" || !homeTimer)) startHomeMusic();
    };
  }
  var homeEl = safeEl("home");
  if (homeEl) {
    homeEl.addEventListener("click", function once() {
      if (homeMusicOn) startHomeMusic();
    }, { once: true });
  }

  var pendingAvatarData = null;
  var oldAvatarHtml = "";

  function saveAvatarConfirmed(dataUrl) {
    var el = safeEl("homeAv");
    if (el) el.innerHTML = '<img alt="" src="' + dataUrl + '">';

    var meLocal = loadMe();
    meLocal.av = dataUrl;
    meLocal.avatarAt = Date.now();
    saveMe(meLocal);

    if (typeof saveOwnAvatar === "function") saveOwnAvatar(dataUrl);
    if (net.account) netSend({ type: "profile-save", av: dataUrl });
    if (typeof shareMyProfile === "function") shareMyProfile();
  }

  function handleAvatarSelect(file) {
    compressAvatarFile(file, function (compressedData) {
      pendingAvatarData = compressedData;
      var el = safeEl("homeAv");
      oldAvatarHtml = el ? el.innerHTML : "";
      if (el) el.innerHTML = '<img alt="" src="' + pendingAvatarData + '">';

      safeText("authTitle", "Đổi hình đại diện");
      safeText("authText", "Đạo hữu có muốn chọn ảnh này làm hình đại diện không?");
      var authOtp = safeEl("authOtp");
      var authNewPass = safeEl("authNewPass");
      var authPop = safeEl("authPop");
      if (authOtp) authOtp.style.display = "none";
      if (authNewPass) authNewPass.style.display = "none";
      if (authPop) authPop.classList.add("show");
      pendingAuth = "avatar";
    });
  }

  safeClick("homeAv", function (ev) {
    ev.stopPropagation();
    var fileInput = safeEl("fileHome");
    if (fileInput) fileInput.click();
  });

  var fileHome = safeEl("fileHome");
  if (fileHome) {
    fileHome.onchange = function () {
      var f = this.files && this.files[0];
      handleAvatarSelect(f);
    };
  }

  var nameInp = safeEl("homeName");
  var btnSaveNm = safeEl("btnSaveName");

  function nameLocked() {
    var meLocal = loadMe();
    var at = (net.account && net.account.renamedAt) || meLocal.renamedAt || 0;
    var w = typeof daysLeft === "function" ? daysLeft(at) : 0;
    return !!(meLocal.name && w > 0);
  }
  function lockNameField() {
    if (!nameInp) return;
    nameInp.readOnly = true;
    nameInp.classList.remove("edit");
    nameInp.classList.toggle("locked", nameLocked());
  }

  if (nameInp) {
    nameInp.onclick = function () {
      if (nameLocked()) {
        var meLocal = loadMe();
        var at = (net.account && net.account.renamedAt) || meLocal.renamedAt || 0;
        safeText("homeHint", "Tên chỉ đổi 30 ngày/lần. Còn " + (typeof daysLeft === "function" ? daysLeft(at) : 0) + " ngày.");
        this.readOnly = true;
        this.classList.remove("edit");
        this.blur();
        return;
      }
      this.readOnly = false;
      this.classList.add("edit");
      this.focus();
    };
    nameInp.oninput = function () {
      var next = this.value.trim();
      var cur = loadMe().name || "";
      var ok = /^[A-Za-z0-9_]{6,24}$/.test(next) && next !== cur;
      if (btnSaveNm) btnSaveNm.hidden = !ok;
    };
    nameInp.onblur = function () {
      setTimeout(function () {
        if (btnSaveNm && btnSaveNm.hidden && nameInp) {
          nameInp.readOnly = true;
          nameInp.classList.remove("edit");
          nameInp.value = loadMe().name || nameInp.value;
        }
      }, 180);
    };
  }

  if (btnSaveNm) {
    btnSaveNm.onclick = function () {
      if (!nameInp) return;
      var name = nameInp.value;
      var ok = typeof saveOwnName === "function" ? saveOwnName(name) : true;
      if (!ok) return;
      connectNet(function () {
        sendHello();
        if (net.account) netSend({ type: "rename", name: name });
      });
      btnSaveNm.hidden = true;
      lockNameField();
    };
  }
  lockNameField();

  window.oauthWin = null;
  function openOAuth(kind) {
    oauthLoginPending = true;
    clearRoomState(true);
    goHub();
    connectNet(function () {
      sendHello();
      var url = "/auth/" + kind + "?sid=" + encodeURIComponent(sessionStorage.getItem("coupSess") || "");
      window.oauthWin = window.open(url, "oauth", "width=520,height=640");
      if (!window.oauthWin) location.href = url;
    });
  }

  window.addEventListener("message", function (ev) {
    if (ev.origin !== location.origin) return;
    if (!ev.data || ev.data.type !== "oauth") return;
    if (window.oauthWin && !window.oauthWin.closed) {
      try { window.oauthWin.close(); } catch (e) {}
      window.oauthWin = null;
    }
    window.focus();
    if (!ev.data.ok) {
      oauthLoginPending = false;
      safeText("oauthHint", "Đăng nhập không thành công hoặc chưa cấu hình OAuth.");
      return;
    }
    connectNet(function () {
      sendHello();
      netSend({
        type: "oauth-claim",
        sid: sessionStorage.getItem("coupSess") || "",
        claim: ev.data.claim || ""
      });
    });
  });

  if (/oauth=ok/.test(location.search)) {
    oauthLoginPending = true;
    var cl = "";
    try { cl = new URLSearchParams(location.search).get("claim") || ""; } catch (e) {}
    connectNet(function () {
      sendHello();
      netSend({ type: "oauth-claim", sid: sessionStorage.getItem("coupSess") || "", claim: cl });
    });
    history.replaceState({}, "", location.pathname);
  }

  safeClick("btnHallBack", function () {
    hideHall();
    goHome();
  });
  safeClick("btnLoginGuest", function () {
    oauthLoginPending = false;
    net.guest = true;
    net.account = null;
    clearRoomState(true);
    goHub();
    applyAuthUI();
  });
  safeClick("btnGoogle", function () { openOAuth("google"); });
  safeClick("btnFacebook", function () { openOAuth("facebook"); });
  safeClick("btnProfileOk", function () {
    var pInput = safeEl("newProfileName");
    var name = pInput ? pInput.value.trim() : "";
    if (!/^[A-Za-z0-9_]{6,24}$/.test(name)) {
      addLog("Tên 6-24 ký tự, chỉ chữ không dấu/số/gạch dưới, không khoảng trắng.");
      return;
    }
    connectNet(function () { netSend({ type: "profile-create", name: name }); });
  });
  safeClick("btnLogout", function () {
    safeText("authTitle", "Đăng xuất");
    safeText("authText", "Đồng ý đăng xuất?");
    var aPop = safeEl("authPop");
    if (aPop) aPop.classList.add("show");
    pendingAuth = "logout";
  });
  safeClick("btnAuthYes", function () {
    if (pendingAuth === "logout") {
      net.account = null;
      net.guest = false;
      netSend({ type: "logout" });
      applyAuthUI();
    } else if (pendingAuth === "avatar") {
      if (pendingAvatarData) saveAvatarConfirmed(pendingAvatarData);
      pendingAvatarData = null;
    }
    var aPop = safeEl("authPop");
    if (aPop) aPop.classList.remove("show");
    pendingAuth = null;
    var fH = safeEl("fileHome");
    if (fH) fH.value = "";
  });

  safeClick("btnAuthNo", function () {
    if (pendingAuth === "avatar") {
      var el = safeEl("homeAv");
      if (el && oldAvatarHtml) el.innerHTML = oldAvatarHtml;
      pendingAvatarData = null;
    }
    var aPop = safeEl("authPop");
    if (aPop) aPop.classList.remove("show");
    pendingAuth = null;
    var fH = safeEl("fileHome");
    if (fH) fH.value = "";
  });

  safeClick("btnFind", function () {
    var findInp = safeEl("findName");
    connectNet(function () {
      sendHello();
      netSend({ type: "search", q: findInp ? findInp.value : "" });
    });
  });

  var findInput = safeEl("findName");
  if (findInput) {
    findInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var bFind = safeEl("btnFind");
        if (bFind) bFind.click();
      }
    });
  }

  safeClick("btnPlayNow", function () {
    if (!mustLogin()) return;
    if (playPending) return;
    oauthLoginPending = false;
    net.vsBot = false;
    playPending = true;
    this.disabled = true;
    safeText("netHint", "Đang tìm phòng...");
    connectNet(function () {
      sendHello();
      netSend({ type: "play", variant: net.variant || "up" });
    });
  });

  safeClick("btnVsBot", function () {
    if (!mustLogin()) return;
    net.vsBot = true;
    net.room = "BOT";
    net.isHost = true;
    net.online = true;
    net.color = "red";
    net.count = 2;
    net.spectate = false;
    if (!net.profiles) net.profiles = {};
    net.profiles.black = { name: "Máy", av: "", games: 0, wins: 0, losses: 0, draws: 0, pts: 0 };
    goTable();
    if (typeof resetBoard === "function") resetBoard();
    started = false;
    var gate = safeEl("readyGate");
    var start = safeEl("btnStart");
    if (gate) gate.classList.add("show");
    if (start) { start.style.display = "inline-block"; start.textContent = "Bắt đầu"; }
    if (typeof updateReadyUI === "function") updateReadyUI();
    if (typeof renderModes === "function") renderModes();
    safeText("netHint", "Chơi với máy · bạn cầm Đỏ. Bấm Bắt đầu.");
  });

  safeClick("btnPickUp", function () { openMode("up"); });
  safeClick("btnPickTuong", function () { openMode("tuong"); });
  safeClick("btnBackHub", function () { goHub(); });
  safeClick("btnHubLogin", function () { goLogin(); });

  function reallyLeave(lost) {
    if (typeof playDoor === "function") playDoor();
    if (lost && started && state && !state.over && net.color) {
      if (net.online && !net.vsBot) {
        netSend({ type: "resign" });
      } else if (net.vsBot && typeof finish === "function") {
        const loser = net.color;
        finish(loser === "red" ? "black" : "red", (loser === "red" ? "Đỏ" : "Đen") + " xin thua");
      }
    }
    netSend({ type: "leave" });
    net.room = null;
    net.color = null;
    net.isHost = false;
    myReady = false;
    peerReady = false;
    var leavePop = safeEl("leavePop");
    if (leavePop) leavePop.classList.remove("show");
    net.spectate = false;
    net.vsBot = false;
    goHome();
  }

  safeClick("btnHome", function () {
    if (typeof playDoor === "function") playDoor();
    if (net.spectate) { reallyLeave(false); return; }
    if (started && state && !state.over) {
      var leavePop = safeEl("leavePop");
      if (leavePop) leavePop.classList.add("show");
      return;
    }
    reallyLeave(false);
  });
  safeClick("btnLeaveYes", function () { reallyLeave(true); });
  safeClick("btnLeaveNo", function () {
    var leavePop = safeEl("leavePop");
    if (leavePop) leavePop.classList.remove("show");
  });
  safeClick("btnOnline", function () {
    var pop = safeEl("onlinePop");
    if (pop) pop.classList.toggle("show");
    connectNet(function () { sendHello(); netSend({ type: "online" }); });
  });
  safeClick("btnBlockInv", function () {
    net.blockInvite = !net.blockInvite;
    this.classList.toggle("on", net.blockInvite);
    this.textContent = net.blockInvite ? "Đang chặn lời mời" : "Cho phép lời mời";
    netSend({ type: "prefs", blockInvite: net.blockInvite });
  });
  safeClick("btnHallHome", function () {
    if (!mustLogin()) return;
    var home = safeEl("home");
    if (home) home.classList.remove("show");
    connectNet(function () { sendHello(); showHall(); });
  });

  goLogin();
  applyAuthUI();
  if (typeof paintHomeProfile === "function") paintHomeProfile();
  connectNet(function () { sendHello(); });
})();