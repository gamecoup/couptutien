const COLS = 9;
const ROWS = 10;
const BAG = ["A", "A", "E", "E", "H", "H", "R", "R", "C", "C", "P", "P", "P", "P", "P"];
const START_SLOTS = [
  {c:0,r:0,t:"R"},{c:1,r:0,t:"H"},{c:2,r:0,t:"E"},{c:3,r:0,t:"A"},
  {c:5,r:0,t:"A"},{c:6,r:0,t:"E"},{c:7,r:0,t:"H"},{c:8,r:0,t:"R"},
  {c:1,r:2,t:"C"},{c:7,r:2,t:"C"},
  {c:0,r:3,t:"P"},{c:2,r:3,t:"P"},{c:4,r:3,t:"P"},{c:6,r:3,t:"P"},{c:8,r:3,t:"P"}
];
function makeInitialBoard(variant) {
  const board = Array.from({length: ROWS}, () => Array(COLS).fill(null));
  function place(color, flipR) {
    board[flipR(0)][4] = {color, type:"K", revealed:true, slot:"K"};
    START_SLOTS.forEach((sl) => {
      const open = variant === "tuong";
      board[flipR(sl.r)][sl.c] = {
        color,
        type: sl.t,
        revealed: !!open,
        slot: sl.t
      };
    });
  }
  place("red", (r) => r);
  place("black", (r) => 9 - r);
  return board;
}

function inside(c, r) { return c >= 0 && c < COLS && r >= 0 && r < ROWS; }
function palace(color, c, r) {
  return c >= 3 && c <= 5 && (color === "red" ? r <= 2 : r >= 7);
}
function river(color, r) { return color === "red" ? r >= 5 : r <= 4; }
function clonePiece(p) { return p ? Object.assign({}, p) : null; }
function at(board, c, r) { return inside(c, r) ? board[r][c] : null; }
function kind(piece) { return piece.revealed ? piece.type : piece.slot; }
function opposite(color) { return color === "red" ? "black" : "red"; }

function rawMoves(board, c, r, variant) {
  const piece = at(board, c, r);
  if (!piece) return [];
  const color = piece.color;
  const type = kind(piece);
  const moves = [];
  function push(toC, toR) {
    if (!inside(toC, toR)) return;
    const target = board[toR][toC];
    if (!target || target.color !== color) moves.push({ c: toC, r: toR });
  }
  if (type === "K") {
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      if (palace(color, nc, nr)) push(nc, nr);
    });
    const dr = color === "red" ? 1 : -1;
    for (let nr = r + dr; inside(c, nr); nr += dr) {
      const target = board[nr][c];
      if (!target) continue;
      if (target.color !== color && target.type === "K") moves.push({ c, r: nr });
      break;
    }
    return moves;
  }
  if (type === "A") {
    [[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      if (!piece.revealed && !palace(color, nc, nr)) return;
      if (piece.revealed && variant === "tuong" && !palace(color, nc, nr)) return;
      push(nc, nr);
    });
    return moves;
  }
  if (type === "E") {
    [[2,2],[2,-2],[-2,2],[-2,-2]].forEach(([dc, dr]) => {
      const nc = c + dc, nr = r + dr;
      if (at(board, c + dc / 2, r + dr / 2)) return;
      if (!inside(nc, nr)) return;
      if (variant === "tuong" && (color === "red" ? nr > 4 : nr < 5)) return;
      push(nc, nr);
    });
    return moves;
  }
  if (type === "H") {
    [[1,0,2,1],[1,0,2,-1],[-1,0,-2,1],[-1,0,-2,-1],
      [0,1,1,2],[0,1,-1,2],[0,-1,1,-2],[0,-1,-1,-2]].forEach(([bc, br, dc, dr]) => {
      if (!at(board, c + bc, r + br)) push(c + dc, r + dr);
    });
    return moves;
  }
  if (type === "R" || type === "C") {
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dc, dr]) => {
      let nc = c + dc, nr = r + dr, jumped = 0;
      while (inside(nc, nr)) {
        const target = board[nr][nc];
        if (type === "R") {
          if (!target) moves.push({ c: nc, r: nr });
          else { if (target.color !== color) moves.push({ c: nc, r: nr }); break; }
        } else if (!target) {
          if (!jumped) moves.push({ c: nc, r: nr });
        } else {
          jumped++;
          if (jumped === 2) { if (target.color !== color) moves.push({ c: nc, r: nr }); break; }
        }
        nc += dc; nr += dr;
      }
    });
    return moves;
  }
  if (type === "P") {
    const dr = color === "red" ? 1 : -1;
    push(c, r + dr);
    if (river(color, r)) { push(c - 1, r); push(c + 1, r); }
  }
  return moves;
}

function findKing(board, color) {
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = board[r][c];
    if (p && p.color === color && p.type === "K") return { c, r };
  }
  return null;
}
function inCheck(board, color, variant) {
  const king = findKing(board, color);
  if (!king) return true;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = board[r][c];
    if (p && p.color === opposite(color) && rawMoves(board, c, r, variant).some(m => m.c === king.c && m.r === king.r)) return true;
  }
  return false;
}
function facing(board) {
  const red = findKing(board, "red"), black = findKing(board, "black");
  if (!red || !black || red.c !== black.c) return false;
  for (let r = Math.min(red.r, black.r) + 1; r < Math.max(red.r, black.r); r++) if (board[r][red.c]) return false;
  return true;
}
function copyBoard(board) { return board.map(row => row.map(clonePiece)); }
function shuffled(values) {
  const out = values.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = out[i]; out[i] = out[j]; out[j] = temp;
  }
  return out;
}
function createSecretGame(board, variant, turn) {
  const next = copyBoard(board);
  for (const color of ["red", "black"]) {
    const bag = shuffled(BAG);
    let index = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const piece = next[r][c];
      if (!piece || piece.color !== color || piece.type === "K") continue;
      piece.type = variant === "tuong" ? piece.slot : bag[index++];
      piece.revealed = variant === "tuong";
    }
  }
  return { board: next, turn: turn === "black" ? "black" : "red", over: false };
}
function applyMove(game, mv) {
  const board = copyBoard(game.board);
  const piece = board[mv.fromR][mv.fromC];
  const captured = board[mv.toR][mv.toC];
  board[mv.fromR][mv.fromC] = null;
  piece.revealed = true;
  board[mv.toR][mv.toC] = piece;
  game.board = board;
  game.turn = opposite(game.turn);
  return captured;
}
function validBoard(board) {
  return Array.isArray(board) && board.length === ROWS && board.every(row => Array.isArray(row) && row.length === COLS);
}
function validInitialBoard(board, variant) {
  if (!validBoard(board)) return false;
  const slots = ["R", "H", "E", "A", "A", "E", "H", "R", "C", "C", "P", "P", "P", "P", "P"];
  const counts = { red: {}, black: {} };
  let total = 0;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = board[r][c];
    if (!p) continue;
    if (p.color !== "red" && p.color !== "black") return false;
    if (!p.type || !p.slot || (p.revealed !== true && p.revealed !== false)) return false;
    if (p.type === "K") {
      if (p.slot !== "K" || !p.revealed || c !== 4 || (p.color === "red" ? r !== 0 : r !== 9)) return false;
    } else {
      if (!slots.includes(p.slot)) return false;
      if (variant === "tuong" && (!p.revealed || p.type !== p.slot)) return false;
      if (variant !== "tuong" && p.revealed) return false;
    }
    counts[p.color][p.slot] = (counts[p.color][p.slot] || 0) + 1;
    total++;
  }
  if (total !== 32) return false;
  for (const color of ["red", "black"]) {
    if (counts[color].K !== 1) return false;
    if (counts[color].P !== 5 || counts[color].A !== 2 || counts[color].E !== 2 || counts[color].H !== 2 || counts[color].R !== 2 || counts[color].C !== 2) return false;
  }
  return true;
}
function validateMove(game, mv, color, variant) {
  if (!game || game.over || !validBoard(game.board) || !mv) return { ok: false, reason: "Trạng thái ván không hợp lệ." };
  if (game.turn !== color) return { ok: false, reason: "Chưa tới lượt." };
  const nums = [mv.fromC, mv.fromR, mv.toC, mv.toR];
  if (!nums.every(Number.isInteger) || !inside(mv.fromC, mv.fromR) || !inside(mv.toC, mv.toR)) return { ok: false, reason: "Nước đi không hợp lệ." };
  const piece = game.board[mv.fromR][mv.fromC];
  if (!piece || piece.color !== color) return { ok: false, reason: "Không phải quân của bạn." };
  if (!rawMoves(game.board, mv.fromC, mv.fromR, variant).some(m => m.c === mv.toC && m.r === mv.toR)) return { ok: false, reason: "Nước đi không hợp lệ." };
  const next = { board: copyBoard(game.board), turn: game.turn, over: false };
  applyMove(next, mv);
  if (inCheck(next.board, color, variant) || facing(next.board)) return { ok: false, reason: "Nước đi làm lộ Tướng." };
  return { ok: true };
}

function hasLegalMove(game, color, variant) {
  if (!game || !validBoard(game.board)) return false;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const p = game.board[r][c];
    if (!p || p.color !== color) continue;
    for (const move of rawMoves(game.board, c, r, variant)) {
      const next = { board: copyBoard(game.board), turn: color, over: false };
      const candidate = { fromC: c, fromR: r, toC: move.c, toR: move.r };
      applyMove(next, candidate);
      if (!inCheck(next.board, color, variant) && !facing(next.board)) return true;
    }
  }
  return false;
}

module.exports = { validateMove, applyMove, createSecretGame, makeInitialBoard, hasLegalMove, inCheck, facing, validBoard, validInitialBoard };
