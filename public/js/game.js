const COLS = 9, ROWS = 10;
const NAMES = {K:"Tướng", A:"Sĩ", E:"Tượng", H:"Mã", R:"Xe", C:"Pháo", P:"Tốt"};
const GLYPH = {
  red:   {K:"帥", A:"仕", E:"相", H:"傌", R:"俥", C:"炮", P:"兵"},
  black: {K:"將", A:"士", E:"象", H:"馬", R:"車", C:"砲", P:"卒"}
};
const START_SLOTS = [
  {c:0,r:0,t:"R"},{c:1,r:0,t:"H"},{c:2,r:0,t:"E"},{c:3,r:0,t:"A"},
  {c:5,r:0,t:"A"},{c:6,r:0,t:"E"},{c:7,r:0,t:"H"},{c:8,r:0,t:"R"},
  {c:1,r:2,t:"C"},{c:7,r:2,t:"C"},
  {c:0,r:3,t:"P"},{c:2,r:3,t:"P"},{c:4,r:3,t:"P"},{c:6,r:3,t:"P"},{c:8,r:3,t:"P"}
];
const BAG = ["A","A","E","E","H","H","R","R","C","C","P","P","P","P","P"];
const TIME_MODES = [
  {id:3,  label:"3 phút",  gameMs: 3*60*1000,  moveMs: 15*1000},
  {id:5,  label:"5 phút",  gameMs: 5*60*1000,  moveMs: 20*1000},
  {id:10, label:"10 phút", gameMs:10*60*1000,  moveMs: 30*1000},
  {id:15, label:"15 phút", gameMs:15*60*1000,  moveMs: 40*1000}
];

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
var myReady = false;
var peerReady = false;
const overlay = document.getElementById("overlay");

let W, H, MARGIN, CELL;
function isMobileUI() {
  return window.matchMedia && window.matchMedia("(max-width: 768px)").matches;
}
function layout() {
  let maxW;
  if (isMobileUI()) {
    const byW = window.innerWidth - 12;
    const byH = (window.innerHeight - 210) * 640 / 720;
    maxW = Math.max(220, Math.min(byW, byH));
  } else {
    const side = 420;
    const byW = window.innerWidth - side;
    const byH = (window.innerHeight - 48) * 640 / 720;
    maxW = Math.max(260, Math.min(500, byW, byH));
  }
  canvas.width = maxW;
  canvas.height = maxW * 720 / 640;
  W = canvas.width; H = canvas.height;
  MARGIN = W * 0.065;
  CELL = (W - 2 * MARGIN) / 8;
}
layout();

let state, selected, hints, history = [];
let timeMode = TIME_MODES[0];
let clocks = null;
let lastTick = 0;
let tickId = 0;
let started = false;
let nextFirst = null;
let pendingDraw = null;
var net = {ws:null, room:null, color:null, isHost:false, online:true, spectate:false, blockInvite:false};
var drawUsedPly = -1;
function relay(payload) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify({type:"relay", payload:payload}));
}
function exportGame() {
  return {
    board: state.board, turn: state.turn, over: state.over, winner: state.winner,
    ply: state.ply, reason: state.reason, captured: state.captured,
    quietPly: state.quietPly || 0, trace: state.trace || [],
    clocks: clocks, timeId: timeMode.id, nextFirst: nextFirst, started: started,
    pendingDraw: pendingDraw
  };
}
const REALMS = ["Tu tiên", "Trúc cơ", "Kim đan", "Hóa thần", "Độ kiếp", "Chân tiên"];
const STAR_PTS = 80;
const MAX_PTS = REALMS.length * 5 * STAR_PTS;
const QUICK = ["Hay quá", "Nước hay", "Nhanh lên", "Từ từ", "Cầu hòa đi", "Xin lỗi", "Gà quá", "OK"];
function loadScores() {
  try {
    const raw = JSON.parse(localStorage.getItem("coupRanks") || "{}");
    return {
      red: Math.max(0, raw.red | 0),
      black: Math.max(0, raw.black | 0)
    };
  } catch (e) { return {red:0, black:0}; }
}
function saveScores(s) {
  localStorage.setItem("coupRanks", JSON.stringify(s));
}
let scores = loadScores();
function rankFromPts(pts) {
  pts = Math.max(0, Math.min(MAX_PTS - 1, pts));
  const step = Math.floor(pts / STAR_PTS);
  const realm = REALMS[Math.min(REALMS.length - 1, Math.floor(step / 5))];
  const star = (step % 5) + 1;
  return {realm, star, pts, step};
}
function rankText(color) {
  const r = rankFromPts(scores[color]);
  return r.realm + " " + "★".repeat(r.star) + "☆".repeat(5 - r.star);
}
function paintSpecBox(n) {
  const el = document.getElementById("specBox");
  if (!el) return;
  el.innerHTML = (n || 0) + "<span class='spec-lab'>xem cờ</span>";
}
function paintHomeProfile() {
  const box = document.getElementById("homeStats");
  const av = document.getElementById("homeAv");
  if (!box) return;
  const acc = net.account;
  const me = typeof loadMe === "function" ? loadMe() : {};
  const src = (acc && acc.av) || me.av || "";
  if (av && src && !src.startsWith("data:,") ) {
    const img = new Image();
    img.onload = function () { av.innerHTML = '<img alt="" src="' + src + '">'; };
    img.onerror = function () {};
    img.src = src;
  }
  if (!acc) {
    box.textContent = net.guest ? "Khách — chưa lưu thành tích." : "Đăng nhập để xem cấp bậc và thành tích.";
    return;
  }
  const st = acc.stats || (typeof myStats === "function" ? myStats() : {games:0,wins:0,losses:0,draws:0});
  const games = st.games || 0;
  const wr = games ? Math.round(1000 * (st.wins || 0) / games) / 10 : 0;
  const rk = rankFromPts(acc.pts || 0);
  box.innerHTML = rk.realm + " " + "★".repeat(rk.star) +
    "<br>" + games + " ván · " + (st.wins||0) + " thắng · " + (st.losses||0) + " thua · " + (st.draws||0) + " hòa" +
    "<br>Tỷ lệ thắng " + wr + "%";
}
function paintRanks() {
  const rr = rankFromPts(scores.red);
  const bb = rankFromPts(scores.black);
  document.getElementById("rankRed").innerHTML =
    rr.realm + "<div class=\"stars\">" + "★".repeat(rr.star) + "☆".repeat(5 - rr.star) + "</div><div>" + rr.pts + " điểm</div>";
  document.getElementById("rankBlack").innerHTML =
    bb.realm + "<div class=\"stars\">" + "★".repeat(bb.star) + "☆".repeat(5 - bb.star) + "</div><div>" + bb.pts + " điểm</div>";
}
function applyScore(winner) {
  if (net.spectate || !net.color) {
    paintRanks();
    return "";
  }
  if (net.account && net.color) {
    netSend({ type: "profile-save", pts: scores[net.color] || 0 });
  }
  if (!net.account) {
    paintRanks();
    return "<div>Chơi khách — không lưu thành tích. Đăng ký để giữ cấp bậc.</div>";
  }
  const before = {red: rankFromPts(scores.red), black: rankFromPts(scores.black)};
  if (winner === "draw") {
    scores.red = Math.min(MAX_PTS - 1, scores.red + 4);
    scores.black = Math.min(MAX_PTS - 1, scores.black + 4);
  } else if (winner === "red") {
    scores.red = Math.min(MAX_PTS - 1, scores.red + 25);
    scores.black = Math.max(0, scores.black - 12);
  } else if (winner === "black") {
    scores.black = Math.min(MAX_PTS - 1, scores.black + 25);
    scores.red = Math.max(0, scores.red - 12);
  }
  saveScores(scores);
  paintRanks();
  const after = {red: rankFromPts(scores.red), black: rankFromPts(scores.black)};
  function line(color) {
    const a = before[color], b = after[color];
    const name = color === "red" ? "Đỏ" : "Đen";
    let s = name + ": " + b.realm + " " + b.star + " sao (" + b.pts + "đ)";
    if (b.step > a.step) s += " ↑";
    if (b.step < a.step) s += " ↓";
    return s;
  }
  return line("red") + "<br>" + line("black");
}

function emptyBoard() {
  return Array.from({length: ROWS}, () => Array(COLS).fill(null));
}
function clonePiece(p) { return p ? Object.assign({}, p) : null; }
function cloneClocks(c) {
  if (!c) return null;
  return {red: c.red, black: c.black, moveLeft: c.moveLeft};
}
function cloneState(s) {
  return {
    board: s.board.map(row => row.map(clonePiece)),
    turn: s.turn, over: s.over, winner: s.winner, ply: s.ply,
    reason: s.reason || null,
    captured: {
      red: (s.captured && s.captured.red || []).map(clonePiece),
      black: (s.captured && s.captured.black || []).map(clonePiece)
    }
  };
}
function inBoard(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
function palace(color, c, r) {
  if (c < 3 || c > 5) return false;
  return color === "red" ? (r >= 0 && r <= 2) : (r >= 7 && r <= 9);
}
function crossedRiver(color, r) {
  return color === "red" ? r >= 5 : r <= 4;
}
function at(board, c, r) { return inBoard(c, r) ? board[r][c] : null; }
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function fmtMs(ms) {
  ms = Math.max(0, Math.ceil(ms / 100) * 100);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return (m < 10 ? "0" : "") + m + ":" + (r < 10 ? "0" : "") + r;
}

function renderModes() {
  const box = document.getElementById("modes");
  if (!box) return;
  box.innerHTML = "";
  const lock = !net.isHost || myReady || peerReady || started;
  TIME_MODES.forEach(mode => {
    const b = document.createElement("button");
    b.className = "mode" + (mode.id === timeMode.id ? " on" : "");
    b.textContent = mode.label;
    if (lock && !net.vsBot) b.disabled = true;
    if (net.vsBot && started && state && !state.over) b.disabled = true;
    b.onclick = function (ev) {
      ev.stopPropagation();
      if (!net.vsBot && !net.isHost) { addLog("Chỉ chủ phòng được đổi giờ."); return; }
      if (!net.vsBot && lock) { addLog("Hủy sẵn sàng trước khi đổi giờ."); return; }
      if (net.vsBot && started && state && !state.over) { addLog("Đang chơi với máy, không đổi giờ."); return; }
      timeMode = mode;
      clocks = {red: timeMode.gameMs, black: timeMode.gameMs, moveLeft: timeMode.moveMs};
      renderModes();
      paintClocks();
      document.getElementById("timeWrap").classList.add("open");
      netSend({ type: "time", timeId: timeMode.id });
    };
    box.appendChild(b);
  });
  const lab = document.getElementById("btnTime");
  if (lab) {
    lab.textContent = "⏱";
    lab.title = timeMode.label + (net.isHost ? "" : " · chỉ chủ phòng đổi");
  }
}

function resetBoard() {
  hideOverlay();
  stopTick();
  const board = emptyBoard();
  function place(color, flipR) {
    const bag = shuffle(BAG);
    board[flipR(0)][4] = {color, type:"K", revealed:true, slot:"K"};
    bag.forEach((trueType, i) => {
      const sl = START_SLOTS[i];
      const open = (typeof net !== "undefined" && net.variant === "tuong");
      board[flipR(sl.r)][sl.c] = {
        color,
        type: open ? sl.t : trueType,
        revealed: !!open,
        slot: sl.t
      };
    });
  }
  place("red", r => r);
  place("black", r => 9 - r);
  state = {board, turn: nextFirst || "red", over:false, winner:null, ply:0, reason:null, captured:{red:[], black:[]}, quietPly:0, trace:[]};
  selected = null; hints = []; history = [];
  clocks = {red: timeMode.gameMs, black: timeMode.gameMs, moveLeft: timeMode.moveMs};
  lastTick = performance.now();
  paintCaptures();
}

function showLobby() {
  started = false;
  stopTick();
  hideOverlay();
  hideDrawAsk();
  if (typeof clearChatLog === "function") clearChatLog();
  pendingDraw = null;
  if (!state) resetBoard();
  myReady = false;
  peerReady = false;
  if (typeof updateReadyUI === "function") updateReadyUI();
  if (net.room && net.color) {
    document.getElementById("netHint").textContent =
      "Phòng " + net.room + " · bạn cầm " + (net.color === "red" ? "Đỏ" : "Đen") +
      (net.isHost ? ". Bấm Sẵn sàng cho ván mới." : ". Đợi chủ phòng bắt đầu ván mới.");
  }
  setStatus();
  paintClocks();
  draw();
  netSend({ type: "busy", on: false });
  if (net.room && net.isHost) relay({kind:"lobby"});
}

function startMatch(fromNet) {
  if (!net.room && !net.vsBot) return;
  ensureAudio();
  if (musicOn) startMusic();
  if (nextFirst == null) nextFirst = Math.random() < 0.5 ? "red" : "black";
  if (!fromNet) resetBoard();
  if (typeof playStartJingle === "function") playStartJingle();
  if (typeof clearChatLog === "function") clearChatLog();
  started = true;
  myReady = false;
  peerReady = false;
  pendingDraw = null;
  drawUsedPly = -1;
  hideDrawAsk();
  document.getElementById("btnDraw").textContent = "Cầu hòa";
  document.getElementById("readyGate").classList.remove("show");
  paintRanks();
  const who = state.turn === "red" ? "Đỏ" : "Đen";
  addLog(timeMode.label + " · " + who + " đi trước.");
  setStatus();
  paintClocks();
  draw();
  applyViewLayout();
  startTick();
  hideHall();
  netSend({ type: "busy", on: true });
  if (!fromNet && net.isHost) relay({kind:"sync", game: exportGame()});
  if (typeof updateReadyUI === "function") updateReadyUI();
  if (net.vsBot && state && !state.over && state.turn !== net.color) setTimeout(botPlay, 500);
}

function walkAs(p) { return p.revealed ? p.type : p.slot; }
function isTuongMode() {
  return typeof net !== "undefined" && net.variant === "tuong";
}
function movesAdvisorTuong(color, c, r, push) {
  const steps = [[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let i = 0; i < steps.length; i++) {
    const nc = c + steps[i][0], nr = r + steps[i][1];
    if (!palace(color, nc, nr)) continue;
    push(nc, nr);
  }
}
function movesAdvisorUp(piece, color, c, r, push) {
  const steps = [[1,1],[1,-1],[-1,1],[-1,-1]];
  for (let i = 0; i < steps.length; i++) {
    const nc = c + steps[i][0], nr = r + steps[i][1];
    if (!piece.revealed && !palace(color, nc, nr)) continue;
    push(nc, nr);
  }
}
function movesElephantTuong(board, color, c, r, push) {
  const steps = [[2,2],[2,-2],[-2,2],[-2,-2]];
  for (let i = 0; i < steps.length; i++) {
    const dc = steps[i][0], dr = steps[i][1];
    if (at(board, c + dc / 2, r + dr / 2)) continue;
    const nc = c + dc, nr = r + dr;
    if (!inBoard(nc, nr)) continue;
    const home = color === "red" ? nr <= 4 : nr >= 5;
    if (!home) continue;
    push(nc, nr);
  }
}
function movesElephantUp(board, color, c, r, push) {
  const steps = [[2,2],[2,-2],[-2,2],[-2,-2]];
  for (let i = 0; i < steps.length; i++) {
    const dc = steps[i][0], dr = steps[i][1];
    if (at(board, c + dc / 2, r + dr / 2)) continue;
    push(c + dc, r + dr);
  }
}

function rawMoves(board, c, r) {
  const p = board[r][c];
  if (!p) return [];
  const kind = walkAs(p);
  const color = p.color;
  const out = [];
  function push(nc, nr) {
    if (!inBoard(nc, nr)) return;
    const q = board[nr][nc];
    if (q && q.color === color) return;
    out.push({c: nc, r: nr, capture: !!q});
  }
  if (kind === "K") {
    const steps = [[1,0],[-1,0],[0,1],[0,-1]];
    for (let i = 0; i < steps.length; i++) {
      const nc = c + steps[i][0], nr = r + steps[i][1];
      if (palace(color, nc, nr)) push(nc, nr);
    }
    const dir = color === "red" ? 1 : -1;
    for (let nr = r + dir; inBoard(c, nr); nr += dir) {
      const q = board[nr][c];
      if (q) {
        if (q.type === "K" && q.color !== color) out.push({c: c, r: nr, capture: true});
        break;
      }
    }
    return out;
  }
  if (kind === "A") {
    if (isTuongMode()) movesAdvisorTuong(color, c, r, push);
    else movesAdvisorUp(p, color, c, r, push);
    return out;
  }
  if (kind === "E") {
    if (isTuongMode()) movesElephantTuong(board, color, c, r, push);
    else movesElephantUp(board, color, c, r, push);
    return out;
  }
  if (kind === "H") {
    const hops = [
      {bc:1, br:0, dc:2, dr:1}, {bc:1, br:0, dc:2, dr:-1},
      {bc:-1, br:0, dc:-2, dr:1}, {bc:-1, br:0, dc:-2, dr:-1},
      {bc:0, br:1, dc:1, dr:2}, {bc:0, br:1, dc:-1, dr:2},
      {bc:0, br:-1, dc:1, dr:-2}, {bc:0, br:-1, dc:-1, dr:-2}
    ];
    for (let i = 0; i < hops.length; i++) {
      const h = hops[i];
      if (at(board, c + h.bc, r + h.br)) continue;
      push(c + h.dc, r + h.dr);
    }
    return out;
  }
  if (kind === "R" || kind === "C") {
    const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
    for (let d = 0; d < 4; d++) {
      const dc = dirs[d][0], dr = dirs[d][1];
      let nc = c + dc, nr = r + dr, jumped = 0;
      while (inBoard(nc, nr)) {
        const q = board[nr][nc];
        if (kind === "R") {
          if (!q) out.push({c:nc, r:nr, capture:false});
          else { if (q.color !== color) out.push({c:nc, r:nr, capture:true}); break; }
        } else {
          if (!q) { if (jumped === 0) out.push({c:nc, r:nr, capture:false}); }
          else {
            jumped += 1;
            if (jumped === 2) { if (q.color !== color) out.push({c:nc, r:nr, capture:true}); break; }
          }
        }
        nc += dc; nr += dr;
      }
    }
    return out;
  }
  if (kind === "P") {
    const fwd = color === "red" ? 1 : -1;
    push(c, r + fwd);
    if (crossedRiver(color, r)) { push(c + 1, r); push(c - 1, r); }
    return out;
  }
  return out;
}

function findKing(board, color) {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && p.type === "K" && p.color === color) return {c, r};
    }
  return null;
}
function generalsFace(board) {
  const rk = findKing(board, "red"), bk = findKing(board, "black");
  if (!rk || !bk || rk.c !== bk.c) return false;
  const lo = Math.min(rk.r, bk.r), hi = Math.max(rk.r, bk.r);
  for (let r = lo + 1; r < hi; r++) if (board[r][rk.c]) return false;
  return true;
}
function applyMoveBoard(board, mv) {
  const nb = board.map(row => row.map(clonePiece));
  const p = nb[mv.fromR][mv.fromC];
  nb[mv.fromR][mv.fromC] = null;
  const np = Object.assign({}, p);
  np.revealed = true;
  nb[mv.toR][mv.toC] = np;
  return nb;
}
function attacksKing(board, attackerColor, kingPos) {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (!p || p.color !== attackerColor) continue;
      const ms = rawMoves(board, c, r);
      for (let i = 0; i < ms.length; i++)
        if (ms[i].c === kingPos.c && ms[i].r === kingPos.r) return true;
    }
  return false;
}
function inCheck(board, color) {
  const k = findKing(board, color);
  if (!k) return true;
  return attacksKing(board, color === "red" ? "black" : "red", k);
}
function boardKey(board, turn) {
  let s = turn + "|";
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (!p) continue;
      s += c + "," + r + p.color + p.type + (p.revealed ? "1" : "0") + p.slot + ";";
    }
  return s;
}
function allRevealed(board) {
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (p && !p.revealed) return false;
    }
  return true;
}
function sideCanCheck(board, color) {
  const k = findKing(board, color === "red" ? "black" : "red");
  if (!k) return false;
  return attacksKing(board, color, k);
}
function cycleTriple(keys) {
  for (let p = 2; p <= 8; p += 2) {
    if (keys.length < p * 3) continue;
    const sl = keys.slice(-p * 3);
    const a = sl.slice(0, p).join("#");
    const b = sl.slice(p, p * 2).join("#");
    const c = sl.slice(p * 2).join("#");
    if (a && a === b && b === c) return true;
  }
  return false;
}
function consecFlag(trace, color, flag) {
  let n = 0;
  for (let i = (trace || []).length - 1; i >= 0; i--) {
    const t = trace[i];
    if (t.color !== color) continue;
    if (!t[flag]) break;
    n++;
  }
  return n;
}
function isChaseMove(board, fromC, fromR, toC, toR, color, trace) {
  const last = (trace || []).filter(t => t.color !== color).pop();
  if (!last) return false;
  const nb = applyMoveBoard(board, {fromC: fromC, fromR: fromR, toC: toC, toR: toR});
  const hits = rawMoves(nb, toC, toR);
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].c === last.toC && hits[i].r === last.toR && hits[i].capture) return true;
  }
  return false;
}
function bannedRepeat(board, fromC, fromR, toC, toR, color) {
  const nb = applyMoveBoard(board, {fromC: fromC, fromR: fromR, toC: toC, toR: toR});
  const opp = color === "red" ? "black" : "red";
  const chk = inCheck(nb, opp);
  const chase = isChaseMove(board, fromC, fromR, toC, toR, color, state && state.trace);
  const keys = ((state && state.trace) || []).map(t => t.key).concat([boardKey(nb, opp)]);
  if (chk && consecFlag(state && state.trace, color, "check") >= 3) return true;
  if (chase && consecFlag(state && state.trace, color, "chase") >= 3) return true;
  if ((chk || chase) && cycleTriple(keys)) return true;
  return false;
}
function legalMoves(board, c, r) {
  const p = board[r][c];
  if (!p) return [];
  return rawMoves(board, c, r).filter(m => {
    const nb = applyMoveBoard(board, {fromC:c, fromR:r, toC:m.c, toR:m.r});
    if (inCheck(nb, p.color) || generalsFace(nb)) return false;
    if (state && !state.over && bannedRepeat(board, c, r, m.c, m.r, p.color)) return false;
    return true;
  });
}
function allLegal(board, color) {
  const list = [];
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      const p = board[r][c];
      if (!p || p.color !== color) continue;
      const ms = legalMoves(board, c, r);
      for (let i = 0; i < ms.length; i++)
        list.push({fromC:c, fromR:r, toC:ms[i].c, toR:ms[i].r, capture:ms[i].capture});
    }
  return list;
}
function sqName(c, r) { return String.fromCharCode(97 + c) + (r + 1); }
function addLog(t) {
  if (!logEl) {
    if (statusEl && t) statusEl.title = t;
    return;
  }
  const d = document.createElement("div");
  d.textContent = t;
  logEl.prepend(d);
}

function paintClocks() {
  if (!clocks) return;
  document.getElementById("tRed").textContent = fmtMs(clocks.red);
  document.getElementById("tBlack").textContent = fmtMs(clocks.black);
  const redTurn = started && state && !state.over && state.turn === "red";
  const blackTurn = started && state && !state.over && state.turn === "black";
  const cr = document.getElementById("clkRed");
  const cb = document.getElementById("clkBlack");
  cr.className = "clock" + (redTurn ? " active" : "") + ((redTurn && clocks.moveLeft < 5000) || clocks.red < 15000 ? " low" : "");
  cb.className = "clock" + (blackTurn ? " active" : "") + ((blackTurn && clocks.moveLeft < 5000) || clocks.black < 15000 ? " low" : "");
  const C = 2 * Math.PI * 32;
  const max = timeMode.moveMs || 1;
  function ring(side, on) {
    const wrap = document.getElementById(side === "red" ? "wrapRed" : "wrapBlack");
    const circ = document.getElementById(side === "red" ? "ringRed" : "ringBlack");
    const num = document.getElementById(side === "red" ? "mvRed" : "mvBlack");
    const left = on ? Math.max(0, clocks.moveLeft) : max;
    const ratio = Math.max(0, Math.min(1, left / max));
    circ.style.strokeDasharray = String(C);
    circ.style.strokeDashoffset = String(C * (1 - ratio));
    wrap.className = "av-wrap" + (on ? " on" : "") + (on && left <= 5000 ? " warn" : "");
    num.textContent = on ? String(Math.ceil(left / 1000)) : "—";
  }
  ring("red", redTurn);
  ring("black", blackTurn);
}

function setStatus() {
  if (!started) {
    statusEl.textContent = net.room ? ("Phòng " + net.room + " · đang chờ") : "Ngồi chờ đối thủ.";
    return;
  }
  if (state.over) {
    statusEl.textContent = state.winner === "draw" ? "Hòa cờ." :
      ((state.winner === "red" ? "Đỏ" : "Đen") + " thắng!");
    return;
  }
  const side = state.turn === "red" ? "Đỏ" : "Đen";
  const chk = inCheck(state.board, state.turn) ? " — đang bị chiếu!" : "";
  statusEl.textContent = side + " đi" + chk;
}

function startTick() {
  stopTick();
  lastTick = performance.now();
  tickId = requestAnimationFrame(onTick);
}
function stopTick() {
  if (tickId) cancelAnimationFrame(tickId);
  tickId = 0;
}
function onTick(now) {
  tickId = requestAnimationFrame(onTick);
  if (!state || state.over || !clocks || !started) return;
  const dt = now - lastTick;
  lastTick = now;
  const side = state.turn;
  clocks[side] -= dt;
  clocks.moveLeft -= dt;
  if (clocks[side] <= 0) {
    clocks[side] = 0;
    finish(side === "red" ? "black" : "red", "Hết giờ ván (" + timeMode.label + ")");
    return;
  }
  if (clocks.moveLeft <= 0) {
    clocks.moveLeft = 0;
    finish(side === "red" ? "black" : "red", "Hết giờ nước (" + (timeMode.moveMs/1000) + " giây)");
    return;
  }
  paintClocks();
  if (started && !state.over && inCheck(state.board, state.turn)) draw();
}

function finish(winner, reason, fromNet) {
  if (state.over) return;
  state.over = true;
  state.winner = winner;
  state.reason = reason;
  selected = null; hints = [];
  stopTick();
  if (typeof clearChatLog === "function") clearChatLog();
  paintClocks();
  setStatus();
  draw();
  addLog((winner === "draw" ? "Hòa" : ((winner === "red" ? "Đỏ" : "Đen") + " thắng")) + " — " + reason);
  if (nextFirst) nextFirst = nextFirst === "red" ? "black" : "red";
  pendingDraw = null;
  hideDrawAsk();
  const rankHtml = applyScore(winner);
  showOverlay(winner, reason, rankHtml);
  playEndMusic(winner, reason);
  netSend({ type: "busy", on: false });
  if (net.online && !fromNet) relay({kind:"finish", winner: winner, reason: reason});
}

function applyMove(mv, fromNet) {
  history.push({state: cloneState(state), clocks: cloneClocks(clocks)});
  const p = state.board[mv.fromR][mv.fromC];
  const wasHidden = !p.revealed;
  const cap = state.board[mv.toR][mv.toC];
  const asWhat = walkAs(p);
  state.board = applyMoveBoard(state.board, mv);
  const nowP = state.board[mv.toR][mv.toC];
  let msg = (p.color === "red" ? "Đỏ" : "Đen") + " " + sqName(mv.fromC, mv.fromR) + "→" + sqName(mv.toC, mv.toR);
  msg += " (" + (wasHidden ? "úp như " + NAMES[asWhat] : NAMES[asWhat]) + ")";
  if (wasHidden) msg += " → lật " + NAMES[nowP.type];
  if (cap) {
    msg += cap.revealed ? " ăn " + NAMES[cap.type] : " ăn quân úp";
    if (!state.captured) state.captured = {red:[], black:[]};
    state.captured[p.color].push(clonePiece(cap));
    paintCaptures();
  }
  addLog(msg);
  if (cap) playCaptureSound();
  else playMoveSound();
  if (pendingDraw) cancelDraw(fromNet);
  document.getElementById("btnDraw").textContent = "Cầu hòa";
  state.ply++;
  state.quietPly = cap ? 0 : (state.quietPly || 0) + 1;
  const opp = state.turn === "red" ? "black" : "red";
  const chk = inCheck(state.board, opp);
  const chase = !cap && isChaseMove(
    history.length ? history[history.length - 1].state.board : state.board,
    mv.fromC, mv.fromR, mv.toC, mv.toR, p.color, state.trace || []
  );
  state.trace = (state.trace || []).concat([{
    color: p.color,
    fromC: mv.fromC, fromR: mv.fromR, toC: mv.toC, toR: mv.toR,
    check: chk, chase: chase,
    key: boardKey(state.board, opp)
  }]).slice(-36);
  if (!findKing(state.board, opp)) {
    finish(state.turn, "Ăn Tướng");
    return;
  }
  if (state.quietPly >= 100) {
    finish("draw", "Hòa 50 nước không ăn quân");
    return;
  }
  const oppMoves = allLegal(state.board, opp);
  if (!oppMoves.length) {
    if (inCheck(state.board, opp)) finish(state.turn, "Chiếu bí");
    else finish(state.turn, "Hết nước đi");
    return;
  }
  state.turn = opp;
  clocks.moveLeft = timeMode.moveMs;
  lastTick = performance.now();
  selected = null; hints = [];
  setStatus();
  paintClocks();
  draw();
  if (inCheck(state.board, state.turn)) playCheckTune();
  if (net.online && !fromNet && !net.vsBot) relay({kind:"move", mv: mv});
  if (net.vsBot && !state.over && state.turn !== net.color) {
    setTimeout(botPlay, 380);
  }
}
const BOT_VAL = {K:1000, R:90, C:45, H:40, E:22, A:20, P:10};
function botPlay() {
  if (!net.vsBot || !state || state.over) return;
  const color = state.turn;
  if (net.color && color === net.color) return;
  const moves = allLegal(state.board, color);
  if (!moves.length) return;
  let best = [];
  let bestS = -1e9;
  moves.forEach(function (m) {
    const cap = state.board[m.toR][m.toC];
    let s = Math.random() * 6;
    if (cap) s += (BOT_VAL[cap.type] || 12) + 20;
    const nb = applyMoveBoard(state.board, m);
    if (inCheck(nb, color === "red" ? "black" : "red")) s += 18;
    if (inCheck(nb, color)) s -= 80;
    if (s > bestS) { bestS = s; best = [m]; }
    else if (Math.abs(s - bestS) < 0.01) best.push(m);
  });
  const pick = best[Math.floor(Math.random() * best.length)] || moves[0];
  applyMove(pick, true);
}

function mySide() {
  return (typeof net !== "undefined" && net.online && net.color) ? net.color : null;
}
function showOverlay(winner, reason, rankHtml) {
  const isMate = reason === "Chiếu bí";
  const title = document.getElementById("ovTitle");
  const box = overlay.querySelector(".ov-box");
  title.textContent = winner === "draw" ? (reason === "Hòa nhau rồi" ? "Hòa nhau rồi" : "Hòa cờ") :
    (isMate ? "CHIẾU BÍ!" : ((winner === "red" ? "Đỏ" : "Đen") + " thắng"));
  title.className = "ov-title" + (isMate ? " mate" : "");
  box.className = "ov-box" + (isMate ? " mate" : "");
  document.getElementById("ovReason").textContent = reason || "";
  document.getElementById("ovRank").innerHTML = rankHtml || "";
  const faces = document.getElementById("ovFaces");
  faces.innerHTML = "";
  function card(color, kind) {
    const d = document.createElement("div");
    d.className = "face " + kind;
    d.innerHTML = '<div class="emo">' + (kind === "win" ? "😄" : kind === "lose" ? "😭" : "😐") +
      '</div><div class="lab">' + (color === "red" ? "Đỏ" : "Đen") + "</div>";
    faces.appendChild(d);
  }
  const mine = mySide();
  if (winner === "draw") {
    const smile = reason === "Hòa nhau rồi";
    if (mine) card(mine, smile ? "win" : "draw");
    else { card("red", smile ? "win" : "draw"); card("black", smile ? "win" : "draw"); }
  } else if (mine) {
    card(mine, mine === winner ? "win" : "lose");
  } else {
    card(winner, "win");
    card(winner === "red" ? "black" : "red", "lose");
  }
  overlay.classList.add("show");
}
function hideOverlay() { overlay.classList.remove("show"); }

let audioCtx = null;
let sfxOn = true;
let musicOn = true;
let sfxVol = 0.8;
let musicVol = 0.4;
let musicTimer = 0;
let musicStep = 0;
function loadAudioPref() {
  try {
    const a = JSON.parse(localStorage.getItem("coupAudio") || "{}");
    if (typeof a.sfxOn === "boolean") sfxOn = a.sfxOn;
    if (typeof a.musicOn === "boolean") musicOn = a.musicOn;
    if (typeof a.sfxVol === "number") sfxVol = a.sfxVol;
    if (typeof a.musicVol === "number") musicVol = a.musicVol;
  } catch (e) {}
}
function saveAudioPref() {
  try {
    localStorage.setItem("coupAudio", JSON.stringify({sfxOn: sfxOn, musicOn: musicOn, sfxVol: sfxVol, musicVol: musicVol}));
  } catch (e) {}
}
loadAudioPref();
function ensureAudio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!audioCtx) audioCtx = new AC();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}
function beep(ctx, freq, start, dur, type, gain, volMul) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type || "triangle";
  o.frequency.setValueAtTime(freq, start);
  const v = Math.max(0.0001, (gain || 0.12) * (volMul == null ? sfxVol : volMul));
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(v, start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(start); o.stop(start + dur + 0.02);
}
function playClick() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  beep(ctx, 920, ctx.currentTime, 0.035, "triangle", 0.045);
}
function playStartJingle() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  [523, 659, 784, 1046, 784, 1174].forEach(function (f, i) {
    beep(ctx, f, t0 + i * 0.09, 0.14, "triangle", 0.1);
    beep(ctx, f / 2, t0 + i * 0.09, 0.14, "sine", 0.04);
  });
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("Cờ úp tu tiên bắt đầu");
    u.lang = "vi-VN";
    u.pitch = 1.85;
    u.rate = 1.12;
    u.volume = 1;
    const vs = window.speechSynthesis.getVoices() || [];
    const baby = vs.find(function (v) { return /child|kid|female|vi/i.test(v.name + v.lang); });
    if (baby) u.voice = baby;
    setTimeout(function () { window.speechSynthesis.speak(u); }, 280);
  } catch (e) {}
}
function playKnock() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  beep(ctx, 180, t0, 0.07, "sine", 0.16);
  beep(ctx, 140, t0, 0.08, "triangle", 0.1);
  beep(ctx, 170, t0 + 0.16, 0.07, "sine", 0.16);
  beep(ctx, 130, t0 + 0.16, 0.08, "triangle", 0.1);
}
function playDoor() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  beep(ctx, 220, t0, 0.18, "sawtooth", 0.06);
  beep(ctx, 160, t0 + 0.05, 0.28, "triangle", 0.08);
  beep(ctx, 90, t0 + 0.12, 0.35, "sine", 0.07);
}
function noiseBurst(ctx, start, dur, gain, decay) {
  try {
    const n = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = n.getChannelData(0);
    const dcy = decay || 0.03;
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * dcy));
    }
    const src = ctx.createBufferSource();
    src.buffer = n;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, gain * sfxVol), start);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(g); g.connect(ctx.destination);
    src.start(start);
  } catch (e) {}
}
function playMoveSound() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  noiseBurst(ctx, t0, 0.14, 0.7, 0.018);
  beep(ctx, 120, t0, 0.12, "sine", 0.28);
  beep(ctx, 70, t0, 0.16, "triangle", 0.22);
  beep(ctx, 48, t0 + 0.02, 0.18, "sine", 0.16);
}
function playCaptureSound() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime;
  noiseBurst(ctx, t0, 0.09, 0.38, 0.012);
  beep(ctx, 1400, t0, 0.06, "sawtooth", 0.1);
  beep(ctx, 900, t0 + 0.02, 0.07, "triangle", 0.08);
  noiseBurst(ctx, t0 + 0.11, 0.09, 0.34, 0.012);
  beep(ctx, 1200, t0 + 0.11, 0.06, "sawtooth", 0.09);
  beep(ctx, 720, t0 + 0.14, 0.07, "triangle", 0.07);
  beep(ctx, 220, t0 + 0.24, 0.22, "sawtooth", 0.1);
  beep(ctx, 140, t0 + 0.28, 0.28, "sine", 0.12);
  beep(ctx, 90, t0 + 0.34, 0.32, "triangle", 0.1);
  beep(ctx, 60, t0 + 0.4, 0.36, "sine", 0.08);
}
function playCheckTune() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  const notes = [880, 698, 587, 440, 349];
  notes.forEach((f, i) => {
    beep(ctx, f, t0 + i * 0.09, 0.12, "square", 0.07);
    beep(ctx, f * 1.5, t0 + i * 0.09, 0.08, "sawtooth", 0.03);
  });
}
const BG_NOTES = [
  294, 330, 392, 440, 392, 330, 294, 262,
  294, 392, 440, 523, 440, 392, 330, 294,
  262, 294, 330, 392, 349, 330, 262, 220
];
function pauseTrack(id) {
  const el = document.getElementById(id);
  if (!el) return;
  try { el.pause(); } catch (e) {}
}
function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = 0; }
  pauseTrack("audGame");
}
const HOME_NOTES = [
  440, 494, 587, 659, 587, 494, 440, 392,
  370, 392, 440, 494, 440, 392, 330, 294,
  262, 294, 330, 392, 440, 392, 330, 262
];
let homeMusicOn = true;
let homeVol = 0.35;
let homeTimer = 0;
let homeStep = 0;
function stopHomeMusic() {
  if (homeTimer) { clearInterval(homeTimer); homeTimer = 0; }
  pauseTrack("audHome");
}
function stopTracks() {
  ["audGame", "audHome"].forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    try { el.pause(); el.currentTime = 0; } catch (e) {}
  });
}
function playFile(id, vol, onFail) {
  const el = document.getElementById(id);
  if (!el || !el.getAttribute("src")) return false;
  el.volume = Math.max(0, Math.min(1, vol == null ? 0.4 : vol));
  el.loop = true;
  const fail = function () { if (typeof onFail === "function") onFail(); };
  el.onerror = fail;
  const p = el.play();
  if (p && p.catch) p.catch(fail);
  return true;
}
function startHomeMusic() {
  stopHomeMusic();
  stopTracks();
  if (!homeMusicOn) return;
  if (playFile("audHome", homeVol, function () { startHomeMusicProc(); })) return;
}
function startHomeMusicProc() {
  const ctx = ensureAudio();
  if (!ctx) return;
  homeStep = 0;
  homeTimer = setInterval(function () {
    if (!homeMusicOn || !audioCtx) return;
    const f = HOME_NOTES[homeStep % HOME_NOTES.length];
    const t0 = audioCtx.currentTime;
    beep(audioCtx, f, t0, 1.6, "sine", 0.055, homeVol);
    beep(audioCtx, f * 2.01, t0 + 0.05, 1.2, "sine", 0.018, homeVol);
    beep(audioCtx, f * 3.02, t0 + 0.08, 0.7, "triangle", 0.008, homeVol);
    if (homeStep % 4 === 0) beep(audioCtx, f / 2, t0, 1.8, "sine", 0.02, homeVol);
    homeStep++;
  }, 900);
}
function startMusic() {
  stopMusic();
  stopTracks();
  if (!musicOn) return;
  if (playFile("audGame", musicVol, function () { startMusicProc(); })) return;
}
function startMusicProc() {
  const ctx = ensureAudio();
  if (!ctx) return;
  musicStep = 0;
  musicTimer = setInterval(function () {
    if (!musicOn || !audioCtx) return;
    const f = BG_NOTES[musicStep % BG_NOTES.length];
    const t0 = audioCtx.currentTime;
    beep(audioCtx, f, t0, 0.95, "sine", 0.028, musicVol);
    beep(audioCtx, f * 1.5, t0, 0.9, "sine", 0.012, musicVol);
    beep(audioCtx, f / 2, t0, 1.05, "triangle", 0.014, musicVol);
    musicStep++;
  }, 720);
}
function playWinTune() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.02;
  const notes = [523, 659, 784, 1047, 784, 1047, 1319];
  notes.forEach((f, i) => {
    beep(ctx, f, t0 + i * 0.16, 0.22, "triangle", 0.11);
    beep(ctx, f / 2, t0 + i * 0.16, 0.22, "sine", 0.04);
  });
}
function playLoseTune() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.02;
  const notes = [392, 370, 330, 294, 262, 247, 196];
  notes.forEach((f, i) => {
    beep(ctx, f, t0 + i * 0.14, 0.18, "square", 0.07);
    beep(ctx, f * 1.01, t0 + i * 0.14 + 0.04, 0.12, "sawtooth", 0.03);
  });
}
function playMateTune() {
  if (!sfxOn) return;
  const ctx = ensureAudio();
  if (!ctx) return;
  const t0 = ctx.currentTime + 0.01;
  [880, 880, 660, 990, 1320].forEach((f, i) => {
    beep(ctx, f, t0 + i * 0.12, 0.16, "square", 0.1);
    beep(ctx, f / 2, t0 + i * 0.12, 0.18, "triangle", 0.05);
  });
}
function playEndMusic(winner, reason) {
  if (reason === "Chiếu bí") playMateTune();
  if (winner === "draw") {
    if (reason === "Hòa nhau rồi") playWinTune();
    return;
  }
  const mine = mySide();
  const delay = reason === "Chiếu bí" ? 700 : 0;
  setTimeout(function () {
    if (mine) {
      if (mine === winner) playWinTune();
      else playLoseTune();
    } else {
      playWinTune();
      setTimeout(playLoseTune, 900);
    }
  }, delay);
}

function boardFlipped() { return !!(net && net.color === "red"); }
function viewC(c) { return boardFlipped() ? 8 - c : c; }
function viewR(r) { return boardFlipped() ? 9 - r : r; }
function applyViewLayout() {
  const sc = document.querySelector(".side-clocks");
  if (sc) sc.classList.toggle("flip", boardFlipped());
  const lc = document.querySelector(".left-col");
  if (lc) lc.classList.toggle("flip", boardFlipped());
}
function cellFromEvent(ev) {
  const rect = canvas.getBoundingClientRect();
  const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
  let c = Math.round((x - MARGIN) / CELL);
  let r = Math.round((y - MARGIN) / CELL);
  c = viewC(c); r = viewR(r);
  return inBoard(c, r) ? {c, r} : null;
}

canvas.addEventListener("pointerdown", ev => {
  ensureAudio();
  if (net.spectate) return;
  if (!started || state.over) return;
  const sq = cellFromEvent(ev);
  if (!sq) return;
  const p = state.board[sq.r][sq.c];
  if (selected) {
    for (let i = 0; i < hints.length; i++) {
      if (hints[i].c === sq.c && hints[i].r === sq.r) {
        applyMove({fromC: selected.c, fromR: selected.r, toC: sq.c, toR: sq.r});
        return;
      }
    }
  }
  if (net.online && net.color && p && p.color !== net.color) return;
  if (p && p.color === state.turn) {
    selected = sq;
    hints = legalMoves(state.board, sq.c, sq.r);
    const how = walkAs(p);
    statusEl.textContent = (p.revealed ? NAMES[p.type] : ("Úp — nước này đi như " + NAMES[how])) +
      " · " + hints.length + " nước";
    draw();
  } else {
    selected = null; hints = []; setStatus(); draw();
  }
});

function drawBoard() {
  ctx.fillStyle = "#e8c992";
  ctx.fillRect(0, 0, W, H);
  const x0 = MARGIN, y0 = MARGIN;
  ctx.strokeStyle = "#5c3317";
  ctx.lineWidth = 1.4;
  for (let r = 0; r < ROWS; r++) {
    ctx.beginPath();
    ctx.moveTo(x0, y0 + r * CELL);
    ctx.lineTo(x0 + 8 * CELL, y0 + r * CELL);
    ctx.stroke();
  }
  for (let c = 0; c < COLS; c++) {
    ctx.beginPath(); ctx.moveTo(x0 + c * CELL, y0); ctx.lineTo(x0 + c * CELL, y0 + 4 * CELL); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x0 + c * CELL, y0 + 5 * CELL); ctx.lineTo(x0 + c * CELL, y0 + 9 * CELL); ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0 + 4 * CELL); ctx.lineTo(x0, y0 + 5 * CELL);
  ctx.moveTo(x0 + 8 * CELL, y0 + 4 * CELL); ctx.lineTo(x0 + 8 * CELL, y0 + 5 * CELL);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x0 + 3 * CELL, y0); ctx.lineTo(x0 + 5 * CELL, y0 + 2 * CELL);
  ctx.moveTo(x0 + 5 * CELL, y0); ctx.lineTo(x0 + 3 * CELL, y0 + 2 * CELL);
  ctx.moveTo(x0 + 3 * CELL, y0 + 7 * CELL); ctx.lineTo(x0 + 5 * CELL, y0 + 9 * CELL);
  ctx.moveTo(x0 + 5 * CELL, y0 + 7 * CELL); ctx.lineTo(x0 + 3 * CELL, y0 + 9 * CELL);
  ctx.stroke();
  ctx.fillStyle = "#8b4513";
  ctx.font = Math.max(12, CELL * 0.22) + "px serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("SÔNG", x0 + 4 * CELL, y0 + 4.5 * CELL);
}
function drawPiece(p, c, r, checkedKing) {
  const x = MARGIN + viewC(c) * CELL, y = MARGIN + viewR(r) * CELL, rad = CELL * 0.407;
  const isCheckKing = checkedKing && p.type === "K" && p.color === checkedKing;
  if (isCheckKing) {
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 180);
    ctx.beginPath();
    ctx.arc(x, y, rad + 4, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(200,30,30," + pulse + ")";
    ctx.lineWidth = 3;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, rad, 0, Math.PI * 2);
  ctx.fillStyle = p.revealed ? "#f7ecd0" : "#5a3514";
  ctx.fill();
  if (p.revealed) {
    ctx.font = "400 " + (rad * 1.28) + 'px "KaiTi","STKaiti","FangSong","Songti SC",serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const ch = GLYPH[p.color][p.type];
    ctx.fillStyle = p.color === "red" ? "#c4161c" : "#111";
    ctx.fillText(ch, x, y + 0.4);
  }
}
function draw() {
  if (!state) return;
  drawBoard();
  if (selected) {
    const x = MARGIN + viewC(selected.c) * CELL, y = MARGIN + viewR(selected.r) * CELL;
    ctx.beginPath(); ctx.arc(x, y, CELL * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = "#2e7d32"; ctx.lineWidth = 3; ctx.stroke();
  }
  for (let i = 0; i < hints.length; i++) {
    const h = hints[i];
    const x = MARGIN + viewC(h.c) * CELL, y = MARGIN + viewR(h.r) * CELL;
    ctx.beginPath();
    ctx.arc(x, y, h.capture ? CELL * 0.36 : CELL * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = h.capture ? "rgba(198,40,40,.32)" : "rgba(46,125,50,.45)";
    ctx.fill();
    if (h.capture) { ctx.strokeStyle = "#c62828"; ctx.lineWidth = 2; ctx.stroke(); }
  }
  const checkedKing = (started && !state.over && inCheck(state.board, state.turn)) ? state.turn : null;
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (state.board[r][c]) drawPiece(state.board[r][c], c, r, checkedKing);
}

function paintCaptures() {
  function fill(id, list, owner) {
    const box = document.getElementById(id);
    box.innerHTML = "";
    const mine = net.color === owner;
    (list || []).forEach(function (p) {
      const show = mine || !!p.revealed;
      const d = document.createElement("div");
      d.className = "mini" + (show ? (p.color === "red" ? " red" : "") : " hid");
      d.textContent = show ? GLYPH[p.color][p.type] : "";
      box.appendChild(d);
    });
  }
  if (!state || !state.captured) {
    fill("capRed", [], "red"); fill("capBlack", [], "black"); return;
  }
  fill("capRed", state.captured.red, "red");
  fill("capBlack", state.captured.black, "black");
}
function refreshSoundButtons() {
  const sp = document.getElementById("btnSpeaker");
  document.getElementById("chkMusic").checked = musicOn;
  document.getElementById("chkSfx").checked = sfxOn;
  const vm = document.getElementById("volMusic");
  const vs = document.getElementById("volSfx");
  if (vm) vm.value = Math.round(musicVol * 100);
  if (vs) vs.value = Math.round(sfxVol * 100);
  sp.textContent = (musicOn || sfxOn) ? "🔊" : "🔇";
}
document.getElementById("btnSpeaker").onclick = function (ev) {
  ev.stopPropagation();
  document.getElementById("soundWrap").classList.toggle("open");
  document.getElementById("chatWrap").classList.remove("open");
};
document.getElementById("chkMusic").onchange = function () {
  musicOn = this.checked;
  saveAudioPref();
  refreshSoundButtons();
  if (musicOn) startMusic();
  else stopMusic();
};
document.getElementById("chkSfx").onchange = function () {
  sfxOn = this.checked;
  saveAudioPref();
  refreshSoundButtons();
};
document.getElementById("volMusic").oninput = function () {
  musicVol = Math.max(0, Math.min(1, (this.value | 0) / 100));
  var el = document.getElementById("audGame");
  if (el) el.volume = musicVol;
  saveAudioPref();
};
document.getElementById("volSfx").oninput = function () {
  sfxVol = Math.max(0, Math.min(1, (this.value | 0) / 100));
  saveAudioPref();
};
const EMO = ["😄","😂","😎","😮","😡","😭","👍","👏","🔥","🐔","❤️","🤝"];
let chatHideTimer = 0;
let chatLogHideTimer = 0;
function clearChatLog() {
  const log = document.getElementById("chatLog");
  if (log) {
    log.innerHTML = "";
    log.classList.remove("show-log");
  }
  const toast = document.getElementById("chatToast");
  if (toast) { toast.classList.remove("show"); toast.textContent = ""; }
}
function showChat(who, txt) {
  addLog(who + ": " + txt);
  const toast = document.getElementById("chatToast");
  toast.textContent = who + " " + txt;
  toast.classList.add("show");
  clearTimeout(chatHideTimer);
  chatHideTimer = setTimeout(function () { toast.classList.remove("show"); }, 8000);
  const log = document.getElementById("chatLog");
  if (log) {
    const line = document.createElement("div");
    line.className = "line";
    line.innerHTML = "<span class='who'>" + who + ":</span> " + txt;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    if (isMobileUI()) {
      log.classList.add("show-log");
      clearTimeout(chatLogHideTimer);
      chatLogHideTimer = setTimeout(function () { log.classList.remove("show-log"); }, 6000);
    }
  }
}
function sendChat(txt) {
  txt = String(txt || "").trim();
  if (!txt) return;
  const who = net.online && net.color ? (net.color === "red" ? "Đỏ" : "Đen") :
    (state && state.turn === "red" ? "Đỏ" : "Đen");
  showChat(who, txt);
  document.getElementById("chatWrap").classList.remove("open");
  document.getElementById("quickWrap").classList.remove("open");
  if (net.online && !net.vsBot) relay({kind:"chat", who: who, text: txt});
}
(function buildQuickChat() {
  const box = document.getElementById("quickPop");
  QUICK.forEach(function (txt) {
    const b = document.createElement("button");
    b.textContent = txt;
    b.onclick = function () { sendChat(txt); };
    box.appendChild(b);
  });
  EMO.forEach(function (e) {
    const b = document.createElement("button");
    b.textContent = e;
    b.onclick = function () { sendChat(e); };
    box.appendChild(b);
  });
})();
document.getElementById("btnChat").onclick = function (ev) {
  ev.stopPropagation();
  document.getElementById("chatWrap").classList.toggle("open");
  document.getElementById("quickWrap").classList.remove("open");
  document.getElementById("soundWrap").classList.remove("open");
  const t = document.getElementById("chatText");
  if (t) setTimeout(function () { t.focus(); }, 0);
};
document.getElementById("btnQuick").onclick = function (ev) {
  ev.stopPropagation();
  document.getElementById("quickWrap").classList.toggle("open");
  document.getElementById("chatWrap").classList.remove("open");
};
document.getElementById("btnChatSend").onclick = function (ev) {
  ev.stopPropagation();
  sendChat(document.getElementById("chatText").value);
  document.getElementById("chatText").value = "";
};
document.getElementById("chatText").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("btnChatSend").click();
  }
});
document.getElementById("chatPop").addEventListener("click", function (e) { e.stopPropagation(); });
document.getElementById("quickPop").addEventListener("click", function (e) { e.stopPropagation(); });
document.addEventListener("click", function () {
  document.getElementById("chatWrap").classList.remove("open");
  document.getElementById("quickWrap").classList.remove("open");
  document.getElementById("soundWrap").classList.remove("open");
});
function hideDrawAsk() {
  const el = document.getElementById("drawAsk");
  if (el) el.classList.remove("show");
}
function showDrawAsk() {
  document.getElementById("drawAsk").classList.add("show");
}
function myTurnNow() {
  if (!state || state.over) return false;
  if (!net.color) return false;
  return net.color === state.turn;
}
function offerDraw() {
  if (!started || !state || state.over) return;
  if (!myTurnNow()) { addLog("Chỉ cầu hòa khi đang tới lượt mình."); return; }
  if (pendingDraw) { addLog("Đang chờ đối thủ trả lời hòa."); return; }
  if (drawUsedPly === state.ply) { addLog("Mỗi nước chỉ được cầu hòa 1 lần."); return; }
  pendingDraw = net.color || state.turn;
  drawUsedPly = state.ply;
  addLog((pendingDraw === "red" ? "Đỏ" : "Đen") + " cầu hòa. Chờ đối thủ...");
  document.getElementById("btnDraw").textContent = "Đang chờ hòa";
  relay({kind:"draw-ask", from: pendingDraw});
}
function onDrawAsked(from) {
  pendingDraw = from;
  if (net.color && from === net.color) return;
  showDrawAsk();
}
function acceptDraw(fromNet) {
  if (!pendingDraw && !fromNet) return;
  hideDrawAsk();
  document.getElementById("btnDraw").textContent = "Cầu hòa";
  if (!fromNet) relay({kind:"draw-yes"});
  finish("draw", "Hòa nhau rồi", fromNet);
}
function declineDraw(fromNet) {
  hideDrawAsk();
  pendingDraw = null;
  document.getElementById("btnDraw").textContent = "Cầu hòa";
  addLog("Từ chối hòa. Ván tiếp tục.");
  if (!fromNet) relay({kind:"draw-no"});
}
function cancelDraw(fromNet) {
  hideDrawAsk();
  pendingDraw = null;
  document.getElementById("btnDraw").textContent = "Cầu hòa";
  if (!fromNet) relay({kind:"draw-cancel"});
}
document.getElementById("btnDraw").onclick = function () {
  if (net.spectate) return;
  offerDraw();
};
document.getElementById("btnDrawYes").onclick = function () { acceptDraw(false); };
document.getElementById("btnDrawNo").onclick = function () { declineDraw(false); };
document.getElementById("btnResign").onclick = function () {
  if (net.spectate) return;
  if (!started || !state || state.over) return;
  const loser = net.color || state.turn;
  finish(loser === "red" ? "black" : "red", (loser === "red" ? "Đỏ" : "Đen") + " xin thua");
};
function updateReadyUI() {
  const gate = document.getElementById("readyGate");
  const btn = document.getElementById("btnReady");
  const start = document.getElementById("btnStart");
  const hint = document.getElementById("waitHint");
  if (net.vsBot) {
    if (started && state && !state.over) {
      gate.classList.remove("show");
      return;
    }
    gate.classList.add("show");
    hint.textContent = "Bạn là chủ bàn. Có thể đổi giờ, rồi bấm Bắt đầu.";
    btn.style.display = "none";
    start.style.display = "inline-block";
    start.textContent = "Bắt đầu";
    return;
  }
  if (net.spectate) {
    gate.classList.add("show");
    hint.textContent = "Bạn đang xem bàn " + (net.room || "") + ". Chỉ chat, không đi cờ.";
    btn.style.display = "none";
    start.style.display = "none";
    return;
  }
  if (started && state && !state.over) {
    gate.classList.remove("show");
    return;
  }
  gate.classList.add("show");
  const hasOpp = !!net.color && (net.count || 0) >= 2;
  start.style.display = "none";
  if (!hasOpp) {
    hint.textContent = "Đang ngồi chờ đối thủ vào bàn " + (net.room || "") + "...";
    btn.style.display = "none";
  } else if (net.isHost) {
    hint.textContent = myReady ? "Đã khóa giờ. Đợi đối thủ bấm Bắt đầu." : "Đủ 2 người. Bấm Sẵn sàng để khóa giờ.";
    btn.style.display = "inline-block";
    btn.textContent = myReady ? "Hủy sẵn sàng" : "Sẵn sàng";
  } else {
    btn.style.display = "none";
    if (peerReady) {
      hint.textContent = "Chủ phòng đã sẵn sàng. Bấm Bắt đầu.";
      start.style.display = "inline-block";
    } else {
      hint.textContent = "Đợi chủ phòng bấm Sẵn sàng.";
    }
  }
  renderModes();
}
document.getElementById("btnReady").onclick = function () {
  if (started && state && !state.over) return;
  if (!net.isHost) return;
  if (!net.color) { addLog("Chờ đối thủ vào bàn."); return; }
  myReady = !myReady;
  if (myReady) netSend({ type: "time", timeId: timeMode.id });
  netSend({ type: "ready", on: myReady });
  updateReadyUI();
};
document.getElementById("btnStart").onclick = function () {
  if (net.vsBot) {
    startMatch(false);
    return;
  }
  if (!peerReady || net.isHost) return;
  netSend({ type: "begin" });
  this.style.display = "none";
};
document.getElementById("btnTime").onclick = function (ev) {
  ev.preventDefault();
  ev.stopPropagation();
  document.getElementById("timeWrap").classList.toggle("open");
};
document.addEventListener("click", function (ev) {
  const tw = document.getElementById("timeWrap");
  if (tw && !ev.target.closest("#timeWrap")) tw.classList.remove("open");
});
function backToRoom() {
  if (started && state && !state.over) return;
  showLobby();
}
function loadAvatars() {
  try { return JSON.parse(localStorage.getItem("coupAvatars") || "{}"); }
  catch (e) { return {}; }
}
function meStore() {
  if (typeof loadMe === "function") return loadMe();
  try { return JSON.parse(sessionStorage.getItem("coupMe") || "{}"); }
  catch (e) { return {}; }
}
function ownAvatarSrc() {
  const me = meStore();
  return me.av || "";
}
function ownName() {
  const me = meStore();
  return me.name || (net.account && net.account.name) || "Đạo hữu";
}
function daysLeft(ts) {
  if (!ts) return 0;
  const left = 30 * 24 * 60 * 60 * 1000 - (Date.now() - ts);
  return left > 0 ? Math.ceil(left / 86400000) : 0;
}
function saveOwnName(name) {
  name = String(name || "").trim().slice(0, 16);
  if (!name) return false;
  const me = meStore();
  const accAt = net.account && net.account.renamedAt;
  const wait = daysLeft(accAt || me.renamedAt || 0);
  if (wait > 0 && name !== me.name) {
    addLog("Tên chỉ đổi 30 ngày/lần. Còn " + wait + " ngày.");
    return false;
  }
  me.name = name;
  me.renamedAt = Date.now();
  if (typeof saveMe === "function") saveMe(me);
  const inp = document.getElementById("homeName");
  if (inp) inp.value = name;
  if (net.profiles && net.color) {
    net.profiles[net.color] = Object.assign({}, net.profiles[net.color], {name: name});
    relay({kind:"profile", color: net.color, profile: net.profiles[net.color]});
  }
  paintSeats();
  return true;
}
function saveOwnAvatar(src) {
  const me = meStore();
  const accAt = net.account && net.account.avatarAt;
  const wait = daysLeft(accAt || me.avatarAt || 0);
  if (wait > 0) {
    addLog("Ảnh đại diện chỉ đổi 30 ngày/lần. Còn " + wait + " ngày.");
    return false;
  }
  me.av = src;
  me.avatarAt = Date.now();
  if (typeof saveMe === "function") saveMe(me);
  if (net.profiles && net.color) {
    net.profiles[net.color] = Object.assign({}, net.profiles[net.color], {av: src});
    relay({kind:"profile", color: net.color, profile: net.profiles[net.color]});
  }
  const home = document.getElementById("homeAv");
  if (home && src) home.innerHTML = '<img alt="" src="' + src + '">';
  paintSeats();
  return true;
}
function setAvatar(color, src) {
  const btn = document.getElementById(color === "red" ? "avRed" : "avBlack");
  if (!btn) return;
  if (src) btn.innerHTML = '<img alt="" src="' + src + '">';
  else btn.innerHTML = color === "red" ? '<span class="ph">🔴</span>' : '<span class="ph">⚫</span>';
}
function paintSeats() {
  ["red", "black"].forEach(function (color) {
    const mine = net.color === color;
    const p = (net.profiles && net.profiles[color]) || {};
    const empty = !mine && !p.name;
    const lab = document.getElementById(color === "red" ? "whoRed" : "whoBlack");
    if (lab) lab.textContent = empty ? "Ghế trống" : (mine ? ownName() : (p.name || (color === "red" ? "Đỏ" : "Đen")));
    if (mine) setAvatar(color, ownAvatarSrc() || p.av || "");
    else setAvatar(color, empty ? "" : (p.av || ""));
    if (empty) {
      const rk = document.getElementById(color === "red" ? "rankRed" : "rankBlack");
      if (rk) rk.innerHTML = "—";
    }
  });
}
function statsKey() {
  const id = net.account && (net.account.id || net.account.contact);
  return id ? "coupStats:" + id : "coupStats:none";
}
function myStats() {
  if (!net.account) return {games:0,wins:0,losses:0,draws:0};
  try {
    const raw = localStorage.getItem(statsKey());
    if (raw) return JSON.parse(raw);
    if (net.account.stats) return net.account.stats;
    return {games:0,wins:0,losses:0,draws:0};
  } catch (e) { return {games:0,wins:0,losses:0,draws:0}; }
}
function saveStats(s) {
  if (!net.account) return;
  try { localStorage.setItem(statsKey(), JSON.stringify(s)); } catch (e) {}
}
function openProfile(color) {
  const mine = net.color === color;
  const p = (net.profiles && net.profiles[color]) || {};
  const name = mine ? ownName() : (p.name || (color === "red" ? "Đỏ" : "Đen"));
  const st = mine ? myStats() : {games: p.games || 0, wins: p.wins || 0, losses: p.losses || 0, draws: p.draws || 0};
  const games = st.games || 0;
  const wr = games ? Math.round(1000 * (st.wins || 0) / games) / 10 : 0;
  const rk = rankFromPts(mine ? (net.account ? scores[color] : 0) : (p.pts || 0));
  document.getElementById("profName").textContent = name;
  const av = document.getElementById("profAv");
  const src = mine ? (ownAvatarSrc() || p.av) : p.av;
  av.innerHTML = src ? '<img alt="" src="' + src + '">' : (color === "red" ? "🔴" : "⚫");
  document.getElementById("profStats").innerHTML =
    "Cấp: " + rk.realm + " " + "★".repeat(rk.star) +
    "<br>Thắng: " + wr + "% · " + games + " ván (" + (st.wins||0) + " thắng)";
  const up = document.getElementById("btnProfUpload");
  const save = document.getElementById("btnProfSave");
  up.style.display = "none";
  save.style.display = "none";
  save.disabled = true;
  let pending = null;
  up.onclick = function () { document.getElementById("fileProf").click(); };
  document.getElementById("fileProf").onchange = function () {
    const f = this.files && this.files[0];
    if (!f || !mine) return;
    const rd = new FileReader();
    rd.onload = function () {
      pending = rd.result;
      av.innerHTML = '<img alt="" src="' + pending + '">';
      save.disabled = false;
    };
    rd.readAsDataURL(f);
  };
  save.onclick = function () {
    if (!pending || !mine) return;
    saveOwnAvatar(pending);
    if (!net.profiles) net.profiles = {};
    net.profiles[color] = Object.assign(p, {av: pending});
    relay({kind:"profile", color: color, profile: net.profiles[color]});
    save.disabled = true;
    addLog("Đã lưu ảnh đại diện.");
  };
  document.getElementById("profPop").classList.add("show");
}
document.getElementById("avRed").onclick = function () { openProfile("red"); };
document.getElementById("avBlack").onclick = function () { openProfile("black"); };
document.getElementById("btnProfClose").onclick = function () {
  document.getElementById("profPop").classList.remove("show");
};
(function initAvatars() {
  const src = ownAvatarSrc();
  const home = document.getElementById("homeAv");
  if (home && src) home.innerHTML = '<img alt="" src="' + src + '">';
})();
document.getElementById("btnAgain").onclick = function () {
  hideOverlay();
  if (net.vsBot) {
    started = false;
    stopTick();
    resetBoard();
    myReady = false;
    peerReady = false;
    if (typeof updateReadyUI === "function") updateReadyUI();
    document.getElementById("netHint").textContent = "Chơi với máy · chỉnh giờ rồi bấm Bắt đầu.";
    return;
  }
  backToRoom();
};
window.addEventListener("resize", function () { layout(); if (state) draw(); });
renderModes();
refreshSoundButtons();
resetBoard();
paintRanks();
showLobby();
