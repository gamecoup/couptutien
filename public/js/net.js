/* net.js — phòng chơi WebSocket */
var pendingAuth = null;
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
    board: g.board, turn: g.turn, over: g.over, winner: g.winner, ply: g.ply,
    reason: g.reason || null,
    captured: g.captured || { red: [], black: [] },
    quietPly: g.quietPly || 0,
    trace: g.trace || []
  };
  clocks = g.clocks;
  nextFirst = g.nextFirst;
  pendingDraw = g.pendingDraw || null;
  var tm = TIME_MODES.find(function (m) { return m.id === g.timeId; });
  if (tm) timeMode = tm;
  started = !!g.started;
  selected = null;
  hints = [];
  lastTick = performance.now();
  hideOverlay();
  hideDrawAsk();
  if (started) document.getElementById("readyGate").classList.remove("show");
  else if (typeof updateReadyUI === "function") updateReadyUI();
  paintCaptures(); paintClocks(); paintRanks(); setStatus(); draw();
  if (started && !state.over) startTick();
  else stopTick();
}
function handleRelay(p) {
  if (!p) return;
  if (p.kind === "sync") importGame(p.game);
  if (p.kind === "move") applyMove(p.mv, true);
  if (p.kind === "finish") finish(p.winner, p.reason, true);
  if (p.kind === "chat") showChat(p.who, p.text);
  if (p.kind === "draw-ask") onDrawAsked(p.from);
  if (p.kind === "draw-yes") acceptDraw(true);
  if (p.kind === "draw-no") declineDraw(true);
  if (p.kind === "draw-cancel") cancelDraw(true);
  if (p.kind === "profile") {
    if (p.color && net.color && p.color === net.color) return;
    if (!net.profiles) net.profiles = {};
    net.profiles[p.color] = p.profile || {};
    if (typeof paintSeats === "function") paintSeats();
    else if (p.profile && p.profile.av && typeof setAvatar === "function") setAvatar(p.color, p.profile.av);
  }
  if (p.kind === "lobby") {
    started = false;
    stopTick();
    hideOverlay();
    hideDrawAsk();
    if (typeof goTable === "function") goTable();
    document.getElementById("netHint").textContent =
      "Phòng " + net.room + " · bạn cầm " + (net.color === "red" ? "Đỏ" : "Đen") +
      ". Đợi chủ phòng bắt đầu ván mới.";
  }
}
function applySeat(msg) {
  net.room = msg.room;
  net.online = true;
  if (msg.color) net.color = msg.color;
  if (typeof msg.isHost === "boolean") net.isHost = msg.isHost;
  if (typeof msg.count === "number") net.count = msg.count;
  if (typeof applyViewLayout === "function") applyViewLayout();
  var side = net.color === "red" ? "Đỏ" : net.color === "black" ? "Đen" : "?";
  if (msg.count >= 2 && net.color) {
    document.getElementById("netHint").textContent =
      "Phòng " + net.room + " · bạn cầm " + side +
      (net.isHost ? ". Bấm Sẵn sàng để bắt đầu." : ". Đợi chủ phòng bấm Sẵn sàng.");
    addLog("Hai người đã vào phòng. Bạn cầm " + side + ".");
    hideHall();
    if (typeof updateReadyUI === "function") updateReadyUI();
    shareMyProfile();
    if (typeof paintSeats === "function") paintSeats();
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
  if (prof.av) setAvatar(net.color, prof.av);
  relay({kind:"profile", color: net.color, profile: prof});
}
function onNetMsg(ev) {
  var msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }
  if (msg.type === "hello-ok") {
    net.myId = msg.id;
    netSend({ type: "online" });
  }
  if (msg.type === "session") {
    if (msg.token) sessionStorage.setItem("coupSess", msg.token);
    if (msg.account) {
      net.account = msg.account;
      if (typeof applyAuthUI === "function") applyAuthUI();
    }
  }
  if (msg.type === "resume-game") {
    if (msg.clocks) clocks = msg.clocks;
    if (msg.timeId) {
      var tmg = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
      if (tmg) timeMode = tmg;
    }
    started = true;
    document.getElementById("readyGate").classList.remove("show");
    if (typeof startTick === "function") startTick();
    goTable();
  }
  if (msg.type === "peer-away") {
    addLog("Đối thủ mất kết nối. Đang chờ vào lại...");
  }
  if (msg.type === "error") {
    document.getElementById("netHint").textContent = msg.text;
    addLog(msg.text);
    return;
  }
  if (msg.type === "created") {
    net.room = msg.room;
    net.isHost = true;
    net.online = true;
    var lock = msg.password ? " (có mật khẩu)" : " (công khai)";
    var wait = msg.waiting ? " Chưa có phòng trống — đang ngồi chờ." : "";
    document.getElementById("netHint").textContent = "Phòng " + msg.room + lock + ". Ngồi chờ đối thủ." + wait;
    addLog("Vào phòng chờ " + msg.room + lock);
    net.count = 1;
    goTable();
  }
  if (msg.type === "joined") {
    net.room = msg.room;
    net.isHost = false;
    net.online = true;
    if (msg.color) net.color = msg.color;
    document.getElementById("netHint").textContent = "Đã vào " + msg.room + ".";
    addLog("Đã vào phòng " + msg.room);
    goTable();
    if (typeof applyViewLayout === "function") applyViewLayout();
    if (typeof updateReadyUI === "function") updateReadyUI();
  }
  if (msg.type === "spectate") {
    net.room = msg.room;
    net.online = true;
    net.spectate = true;
    net.color = null;
    net.isHost = false;
    net.specs = msg.specs || 0;
    if (typeof paintSpecBox === "function") paintSpecBox(net.specs);
    addLog("Đang xem bàn " + msg.room);
    hideHall();
    goTable();
    if (typeof updateReadyUI === "function") updateReadyUI();
  }
  if (msg.type === "spec-join") {
    if (!net.spectate && state) relay({kind:"sync", game: exportGame()});
  }
  if (msg.type === "presence") renderOnline(msg.list || [], msg.n || 0);
  if (msg.type === "tables") renderHall(msg.tables || []);
  if (msg.type === "seated") applySeat(msg);
  if (msg.type === "peer-left") {
    if (typeof playDoor === "function") playDoor();
    net.count = msg.count || 1;
    addLog("Đối thủ mất kết nối. Phòng còn " + (msg.count || 1) + " người.");
    peerReady = false;
    myReady = false;
    if (started) { started = false; stopTick(); }
    if (net.profiles && net.color) {
      const opp = net.color === "red" ? "black" : "red";
      delete net.profiles[opp];
    }
    if (typeof paintSeats === "function") paintSeats();
    if (typeof updateReadyUI === "function") updateReadyUI();
  }
  if (msg.type === "relay") handleRelay(msg.payload);
  if (msg.type === "search") renderFind(msg.list || []);
  if (msg.type === "invite") {
    if (!net.account || net.blockInvite) { netSend({ type: "invite-no", fromId: msg.fromId }); return; }
    showInvite(msg);
  }
  if (msg.type === "spec-count") {
    net.specs = msg.n || 0;
    if (typeof paintSpecBox === "function") paintSpecBox(net.specs);
  }
  if (msg.type === "otp") {
    document.getElementById("authTitle").textContent = "OTP lấy lại mật khẩu";
    document.getElementById("authText").textContent = msg.text;
    document.getElementById("authOtp").style.display = "inline-block";
    document.getElementById("authNewPass").style.display = "inline-block";
    document.getElementById("authPop").classList.add("show");
    pendingAuth = { kind: "reset", contact: msg.contact };
  }
  if (msg.type === "account") {
    net.account = msg.acc;
    document.getElementById("homeName").value = msg.acc.name;
    document.getElementById("homeName").classList.remove("guest-name");
    document.getElementById("homeHint").textContent = "Đã đăng ký: " + msg.acc.name + " · " + msg.acc.via;
    var me2 = loadMe();
    me2.name = msg.acc.name;
    me2.contact = msg.acc.contact;
    if (msg.acc.av) me2.av = msg.acc.av;
    saveMe(me2);
    if (typeof paintHomeProfile === "function") paintHomeProfile();
    else if (msg.acc.av) document.getElementById("homeAv").innerHTML = '<img alt="" src="' + msg.acc.av + '">';
    if (msg.acc.stats && typeof saveStats === "function") saveStats(msg.acc.stats);
    if (typeof msg.acc.pts === "number" && net.color) {
      scores[net.color] = msg.acc.pts;
      if (typeof paintRanks === "function") paintRanks();
    }
    if (typeof paintSeats === "function") paintSeats();
    net.guest = false;
    document.getElementById("loginGate").classList.remove("show");
    document.getElementById("authPop").classList.remove("show");
    if (window.oauthWin && !window.oauthWin.closed) {
      try { window.oauthWin.close(); } catch (e) {}
      window.oauthWin = null;
    }
    applyAuthUI();
    if (msg.needProfile && !(msg.acc && msg.acc.name)) openProfilePop();
    else document.getElementById("profilePop").classList.remove("show");
  }
  if (msg.type === "ready-state") {
    myReady = !!msg.mine;
    peerReady = !!msg.peer;
    if (msg.timeId) {
      var tm = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
      if (tm) { timeMode = tm; renderModes(); paintClocks(); }
    }
    if (typeof updateReadyUI === "function") updateReadyUI();
  }
  if (msg.type === "time") {
    var tm2 = TIME_MODES.find(function (m) { return m.id === msg.timeId; });
    if (tm2) {
      timeMode = tm2;
      clocks = {red: timeMode.gameMs, black: timeMode.gameMs, moveLeft: timeMode.moveMs};
      renderModes(); paintClocks();
    }
  }
  if (msg.type === "start") {
    if (net.isHost) startMatch(false);
    else {
      document.getElementById("readyGate").classList.remove("show");
      if (typeof playStartJingle === "function") playStartJingle();
    }
  }
}
function connectNet(cb) {
  document.getElementById("netHint").textContent = "Đang kết nối máy chủ...";
  if (net.ws && net.ws.readyState === 1) { if (cb) cb(); return; }
  try { net.ws = new WebSocket(netUrl()); }
  catch (e) {
    document.getElementById("netHint").textContent = "Không mở được WebSocket.";
    return;
  }
  net.ws.onopen = function () {
    document.getElementById("netHint").textContent = "Đã kết nối. Tạo hoặc vào phòng.";
    var tok = sessionStorage.getItem("coupSess");
    if (tok) netSend({ type: "resume", token: tok });
    sendHello();
    if (cb) cb();
  };
  net.ws.onmessage = onNetMsg;
  net.ws.onclose = function () {
    addLog("Mất kết nối máy chủ.");
    net.ws = null;
  };
  net.ws.onerror = function () {
    document.getElementById("netHint").textContent = "Lỗi kết nối. Chạy server rồi mở http://localhost:8080";
  };
}
function goLogin() {
  hideHall();
  document.getElementById("hub").classList.remove("show");
  document.getElementById("home").classList.remove("show");
  document.getElementById("gameWrap").classList.remove("show");
  document.getElementById("loginGate").classList.add("show");
}
function goHub() {
  hideHall();
  document.getElementById("home").classList.remove("show");
  document.getElementById("gameWrap").classList.remove("show");
  document.getElementById("hub").classList.add("show");
  net.vsBot = false;
}
function applyVariantUI() {
  var brand = document.getElementById("homeBrand");
  if (brand) brand.textContent = net.variant === "tuong" ? "CỜ TƯỚNG" : "CỜ ÚP TU TIÊN";
}
function openMode(variant) {
  net.variant = variant === "tuong" ? "tuong" : "up";
  net.vsBot = false;
  applyVariantUI();
  document.getElementById("hub").classList.remove("show");
  document.getElementById("home").classList.add("show");
}
function goHome() {
  hideHall();
  document.getElementById("hub").classList.remove("show");
  document.getElementById("home").classList.add("show");
  document.getElementById("gameWrap").classList.remove("show");
  applyVariantUI();
  if (typeof stopMusic === "function") stopMusic();
  if (typeof stopTracks === "function") stopTracks();
  if (typeof startHomeMusic === "function") startHomeMusic();
  if (net.room) {
    netSend({ type: "leave" });
    net.room = null;
    net.color = null;
    net.isHost = false;
  }
  net.spectate = false;
}
function goTable() {
  document.getElementById("home").classList.remove("show");
  hideHall();
  document.getElementById("gameWrap").classList.add("show");
  if (typeof clearChatLog === "function") clearChatLog();
  if (typeof stopHomeMusic === "function") stopHomeMusic();
  if (typeof startMusic === "function") startMusic();
  if (typeof layout === "function") layout();
  if (typeof draw === "function" && state) draw();
  if (typeof updateReadyUI === "function") updateReadyUI();
}
function showHall() {
  document.getElementById("hall").classList.add("show");
  netSend({ type: "list" });
}
function hideHall() {
  document.getElementById("hall").classList.remove("show");
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
  var btn = document.getElementById("btnOnline");
  if (btn) btn.textContent = (n || list.length || 0) + " người đang online";
  var box = document.getElementById("onlineList");
  if (!box) return;
  box.innerHTML = "";
  if (!list.length) {
    box.innerHTML = "<div class='on-row'>Chưa thấy đạo hữu khác.</div>";
    return;
  }
  list.forEach(function (u) {
    var row = document.createElement("div");
    row.className = "on-row";
    var st = u.busy ? "đang đấu" : (u.room ? "trong bàn" : "rảnh");
    row.innerHTML = "<span>" + (u.name || "Đạo hữu") + " · " + st + "</span>";
    if (u.id && u.id === net.myId) return;
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
    box.appendChild(row);
  });
}
function renderHall(tables) {
  var strip = document.getElementById("hallStrip");
  if (!strip) return;
  strip.innerHTML = "";
  tables = (tables || []).filter(function (t) {
    return (t.variant || "up") === (net.variant || "up");
  });
  if (!tables.length) {
    strip.innerHTML = "<div class='tbl'><div class='tid'>—</div><div class='st'>Chưa có bàn nào</div></div>";
    return;
  }
  tables.forEach(function (t) {
    var d = document.createElement("div");
    d.className = "tbl" + (t.id === net.room ? " mine" : "");
    var st = t.busy ? "Đang chơi" : (t.n < 2 ? "Đang chờ" : "Đủ 2 người");
    if (t.lock) st += " · có mật khẩu";
    d.innerHTML = "<div class='tid'>" + t.id + "</div><div class='st'>" + st +
      "</div><div class='st'>" + t.n + "/2 người" + (t.specs ? " · xem " + t.specs : "") + "</div>";
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
    strip.appendChild(d);
  });
}
(function bindHallDrag() {
  var el = document.getElementById("hallStrip");
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
document.getElementById("btnHallBack").onclick = function () {
  hideHall();
  goHome();
};

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
    sessionStorage.setItem(clientKey(), JSON.stringify(me));
    localStorage.setItem(clientKey(), JSON.stringify(me));
  } catch (e) {}
}
function signedIn() { return !!(net.account || net.guest); }
function applyAuthUI() {
  var out = document.getElementById("btnLogout");
  var gate = document.getElementById("loginGate");
  if (out) out.style.display = signedIn() ? "inline-block" : "none";
  if (gate) gate.classList.toggle("show", !signedIn());
  if (signedIn()) {
    var onGame = document.getElementById("gameWrap").classList.contains("show");
    var onHome = document.getElementById("home").classList.contains("show");
    if (!onGame && !onHome) document.getElementById("hub").classList.add("show");
  } else {
    document.getElementById("hub").classList.remove("show");
  }
  var hint = document.getElementById("homeHint");
  if (!hint) return;
  if (net.account) {
    hint.textContent = "Xin chào " + (net.account.name || "đạo hữu") + " · " + (net.account.provider || net.account.via || "tài khoản");
    var nma = document.getElementById("homeName");
    if (nma) {
      nma.classList.remove("guest-name");
      if (net.account.name) nma.value = net.account.name;
    }
  } else if (net.guest) {
    hint.textContent = "Đang vào với tư cách khách. Thành tích không lưu.";
    var nm = document.getElementById("homeName");
    nm.value = "KHÁCH";
    nm.classList.add("guest-name");
    nm.readOnly = true;
  } else hint.textContent = "Chọn cách vào sảnh cờ.";
}
function mustLogin() {
  if (signedIn()) return true;
  applyAuthUI();
  document.getElementById("homeHint").textContent = "Cần vào với tư cách khách hoặc đăng nhập Google/Facebook.";
  return false;
}
function openProfilePop() {
  var pop = document.getElementById("profilePop");
  if (pop) pop.classList.add("show");
}
function sendHello() {
  var name = document.getElementById("homeName").value || loadMe().name || "Đạo hữu";
  netSend({ type: "hello", name: name });
}
function renderFind(list) {
  var box = document.getElementById("findList");
  box.innerHTML = "";
  if (!list.length) { box.textContent = "Không thấy đạo hữu khớp."; return; }
  list.forEach(function (u) {
    var row = document.createElement("div");
    row.className = "find-row";
    var extra = u.via ? (" · " + u.via) : "";
    var st = u.online === false ? " · offline" : (u.busy ? " · đang đấu" : u.room ? " · trong bàn" : " · rảnh");
    row.innerHTML = "<span>" + u.name + extra + st + "</span>";
    var b = document.createElement("button");
    b.textContent = "Mời";
    b.disabled = !!u.busy;
    b.onclick = function () { netSend({ type: "invite", to: u.id }); };
    row.appendChild(b);
    box.appendChild(row);
  });
}
function showInvite(msg) {
  document.getElementById("inviteText").textContent = (msg.fromName || "Đạo hữu") + " mời bạn tỷ thí.";
  document.getElementById("invitePop").classList.add("show");
  document.getElementById("btnInvYes").onclick = function () {
    document.getElementById("invitePop").classList.remove("show");
    netSend({ type: "invite-ok", fromId: msg.fromId });
    document.getElementById("home").classList.remove("show");
    if (typeof goTable === "function") goTable();
  };
  document.getElementById("btnInvNo").onclick = function () {
    document.getElementById("invitePop").classList.remove("show");
    netSend({ type: "invite-no", fromId: msg.fromId });
  };
}
(function initHome() {
  var me = loadMe();
  if (me.name) document.getElementById("homeName").value = me.name;
  if (me.av) document.getElementById("homeAv").innerHTML = '<img alt="" src="' + me.av + '">';
  var hm = document.getElementById("btnHomeMusic");
  var hv = document.getElementById("volHome");
  if (hv) hv.value = Math.round((homeVol || 0.35) * 100);
  if (hm) hm.onclick = function () {
    homeMusicOn = !homeMusicOn;
    hm.style.opacity = homeMusicOn ? "1" : "0.45";
    if (homeMusicOn) startHomeMusic();
    else stopHomeMusic();
  };
  if (hv) hv.oninput = function () {
    homeVol = Math.max(0, Math.min(1, (this.value | 0) / 100));
    var el = document.getElementById("audHome");
    if (el) el.volume = homeVol;
    if (homeMusicOn && !homeTimer) startHomeMusic();
  };
  document.getElementById("home").addEventListener("click", function once() {
    if (homeMusicOn) startHomeMusic();
  }, { once: true });
  var pendingHomeAv = null;
  var avStage = 0;
  var btnSaveAv = document.getElementById("btnHomeSave");
  var btnBrowseAv = document.getElementById("btnHomeBrowse");
  var btnSaveNm = document.getElementById("btnSaveName");
  var nameInp = document.getElementById("homeName");
  function hideAvBtns() {
    btnSaveAv.hidden = true;
    btnBrowseAv.hidden = true;
    avStage = 0;
  }
  function showSavedHomeAv() {
    var cur = loadMe();
    var el = document.getElementById("homeAv");
    if (cur.av) el.innerHTML = '<img alt="" src="' + cur.av + '">';
    else el.innerHTML = '<span class="ph">🧙</span>';
  }
  function canChangeAv() {
    var me = loadMe();
    var at = (net.account && net.account.avatarAt) || me.avatarAt || 0;
    var w = typeof daysLeft === "function" ? daysLeft(at) : 0;
    if (w > 0) {
      document.getElementById("homeHint").textContent = "Ảnh chỉ đổi 30 ngày/lần. Còn " + w + " ngày.";
      return false;
    }
    return true;
  }
  function previewAv(data) {
    pendingHomeAv = data;
    document.getElementById("homeAv").innerHTML = '<img alt="" src="' + data + '">';
    btnSaveAv.hidden = false;
    btnBrowseAv.hidden = true;
    avStage = 1;
  }
  document.getElementById("homeAv").onclick = function (ev) {
    ev.stopPropagation();
    if (!canChangeAv()) return;
    document.getElementById("fileHome").click();
  };
  document.getElementById("homeAv").addEventListener("dragover", function (ev) {
    ev.preventDefault();
  });
  document.getElementById("homeAv").addEventListener("drop", function (ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!canChangeAv()) return;
    var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
    if (!f || !f.type.startsWith("image/")) return;
    var rd = new FileReader();
    rd.onload = function () { previewAv(rd.result); };
    rd.readAsDataURL(f);
  });
  document.getElementById("fileHome").onchange = function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () { previewAv(rd.result); };
    rd.readAsDataURL(f);
  };
  btnSaveAv.onclick = function (ev) {
    ev.stopPropagation();
    if (!pendingHomeAv) return;
    var ok = typeof saveOwnAvatar === "function" ? saveOwnAvatar(pendingHomeAv) : true;
    if (!ok) { showSavedHomeAv(); hideAvBtns(); return; }
    if (net.account) netSend({ type: "profile-save", av: pendingHomeAv });
    pendingHomeAv = null;
    btnSaveAv.hidden = true;
    btnBrowseAv.hidden = false;
    avStage = 2;
  };
  btnBrowseAv.onclick = function (ev) {
    ev.stopPropagation();
    hideAvBtns();
    document.getElementById("fileHome").value = "";
  };
  document.addEventListener("click", function (ev) {
    if (avStage !== 1 || !pendingHomeAv) return;
    if (ev.target.closest && (ev.target.closest("#homeAv") || ev.target.closest("#btnHomeSave") || ev.target.closest("#btnHomeBrowse") || ev.target.id === "fileHome")) return;
    pendingHomeAv = null;
    document.getElementById("fileHome").value = "";
    hideAvBtns();
    showSavedHomeAv();
  });
  function nameLocked() {
    var me = loadMe();
    var at = (net.account && net.account.renamedAt) || me.renamedAt || 0;
    var w = typeof daysLeft === "function" ? daysLeft(at) : 0;
    return !!(me.name && w > 0);
  }
  function lockNameField() {
    nameInp.readOnly = true;
    nameInp.classList.remove("edit");
    nameInp.classList.toggle("locked", nameLocked());
  }
  nameInp.onclick = function () {
    if (nameLocked()) {
      var me = loadMe();
      var at = (net.account && net.account.renamedAt) || me.renamedAt || 0;
      document.getElementById("homeHint").textContent = "Tên chỉ đổi 30 ngày/lần. Còn " + daysLeft(at) + " ngày.";
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
    var ok = next.length >= 2 && next !== cur;
    btnSaveNm.hidden = !ok;
  };
  nameInp.onblur = function () {
    setTimeout(function () {
      if (btnSaveNm.hidden) {
        nameInp.readOnly = true;
        nameInp.classList.remove("edit");
        nameInp.value = loadMe().name || nameInp.value;
      }
    }, 180);
  };
  btnSaveNm.onclick = function () {
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
  lockNameField();
  window.oauthWin = null;
  function openOAuth(kind) {
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
      document.getElementById("oauthHint").textContent = "Đăng nhập không thành công hoặc chưa cấu hình OAuth.";
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
    var cl = "";
    try { cl = new URLSearchParams(location.search).get("claim") || ""; } catch (e) {}
    connectNet(function () {
      sendHello();
      netSend({ type: "oauth-claim", sid: sessionStorage.getItem("coupSess") || "", claim: cl });
    });
    history.replaceState({}, "", location.pathname);
  }
  document.getElementById("btnLoginGuest").onclick = function () {
    net.guest = true;
    net.account = null;
    applyAuthUI();
  };
  document.getElementById("btnGoogle").onclick = function () { openOAuth("google"); };
  document.getElementById("btnFacebook").onclick = function () { openOAuth("facebook"); };
  document.getElementById("btnProfileOk").onclick = function () {
    var name = document.getElementById("newProfileName").value.trim();
    if (name.length < 2) { addLog("Tên từ 2 đến 16 ký tự."); return; }
    connectNet(function () { netSend({ type: "profile-create", name: name }); });
  };
  document.getElementById("btnLogout").onclick = function () {
    document.getElementById("authTitle").textContent = "Đăng xuất";
    document.getElementById("authText").textContent = "Đồng ý đăng xuất?";
    document.getElementById("authPop").classList.add("show");
    pendingAuth = "logout";
  };
  document.getElementById("btnAuthNo").onclick = function () {
    document.getElementById("authPop").classList.remove("show");
    pendingAuth = null;
  };
  document.getElementById("btnAuthYes").onclick = function () {
    if (pendingAuth === "logout") {
      net.account = null;
      net.guest = false;
      netSend({ type: "logout" });
      applyAuthUI();
    }
    document.getElementById("authPop").classList.remove("show");
  };
  document.getElementById("btnFind").onclick = function () {
    connectNet(function () {
      sendHello();
      netSend({ type: "search", q: document.getElementById("findName").value });
    });
  };
  document.getElementById("findName").addEventListener("keydown", function (e) {
    if (e.key === "Enter") document.getElementById("btnFind").click();
  });
  document.getElementById("btnPlayNow").onclick = function () {
    if (!mustLogin()) return;
    net.vsBot = false;
    connectNet(function () {
      sendHello();
      netSend({ type: "play", variant: net.variant || "up" });
    });
  };
  document.getElementById("btnVsBot").onclick = function () {
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
    var gate = document.getElementById("readyGate");
    var start = document.getElementById("btnStart");
    if (gate) gate.classList.add("show");
    if (start) { start.style.display = "inline-block"; start.textContent = "Bắt đầu"; }
    if (typeof updateReadyUI === "function") updateReadyUI();
    document.getElementById("netHint").textContent = "Chơi với máy · bạn cầm Đỏ. Bấm Bắt đầu.";
  };
  document.getElementById("btnPickUp").onclick = function () { openMode("up"); };
  document.getElementById("btnPickTuong").onclick = function () { openMode("tuong"); };
  document.getElementById("btnBackHub").onclick = function () { goHub(); };
  document.getElementById("btnHubLogin").onclick = function () { goLogin(); };
  function reallyLeave(lost) {
    if (typeof playDoor === "function") playDoor();
    if (lost && started && state && !state.over && net.color) {
      const loser = net.color;
      finish(loser === "red" ? "black" : "red", (loser === "red" ? "Đỏ" : "Đen") + " thoát phòng");
    }
    netSend({ type: "leave" });
    net.room = null;
    net.color = null;
    net.isHost = false;
    myReady = false;
    peerReady = false;
    document.getElementById("leavePop").classList.remove("show");
    net.spectate = false;
    net.vsBot = false;
    goHome();
  }
  document.getElementById("btnHome").onclick = function () {
    if (net.spectate) { reallyLeave(false); return; }
    if (started && state && !state.over) {
      document.getElementById("leavePop").classList.add("show");
      return;
    }
    reallyLeave(false);
  };
  document.getElementById("btnLeaveYes").onclick = function () { reallyLeave(true); };
  document.getElementById("btnLeaveNo").onclick = function () {
    document.getElementById("leavePop").classList.remove("show");
  };
  document.getElementById("btnOnline").onclick = function () {
    var pop = document.getElementById("onlinePop");
    pop.classList.toggle("show");
    connectNet(function () { sendHello(); netSend({ type: "online" }); });
  };
  document.getElementById("btnBlockInv").onclick = function () {
    net.blockInvite = !net.blockInvite;
    this.classList.toggle("on", net.blockInvite);
    this.textContent = net.blockInvite ? "Đang chặn lời mời" : "Cho phép lời mời";
    netSend({ type: "prefs", blockInvite: net.blockInvite });
  };
  document.getElementById("btnHallHome").onclick = function () {
    if (!mustLogin()) return;
    document.getElementById("home").classList.remove("show");
    connectNet(function () { sendHello(); showHall(); });
  };
  applyAuthUI();
  if (typeof paintHomeProfile === "function") paintHomeProfile();
  connectNet(function () { sendHello(); });
})();
