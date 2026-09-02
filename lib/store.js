const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function pickDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const cands = ["/data", "/var/lib/coup", path.join(__dirname, "..", "data")];
  for (let i = 0; i < cands.length; i++) {
    const p = cands[i];
    try {
      if (fs.existsSync(path.join(p, "accounts.json"))) return p;
    } catch (e) {}
  }
  for (let i = 0; i < cands.length; i++) {
    try {
      fs.mkdirSync(cands[i], { recursive: true });
      return cands[i];
    } catch (e) {}
  }
  return path.join(__dirname, "..", "data");
}
const DATA = pickDataDir();
const ACC_FILE = path.join(DATA, "accounts.json");
const LOG_FILE = path.join(DATA, "matches.jsonl");
const AV_DIR = path.join(DATA, "avatars");
const LOCAL_ACC = path.join(__dirname, "..", "data", "accounts.json");

function readAccFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { return []; }
}
function mergeAcc(a, b) {
  const map = new Map();
  (a || []).concat(b || []).forEach(function (acc) {
    if (!acc) return;
    const k = acc.id || acc.contact;
    if (!k) return;
    const old = map.get(k);
    if (!old) map.set(k, acc);
    else {
      const ag = (old.stats && old.stats.games) || 0;
      const bg = (acc.stats && acc.stats.games) || 0;
      map.set(k, bg >= ag ? acc : old);
    }
  });
  return Array.from(map.values());
}
function ensureDir() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(AV_DIR, { recursive: true });
  if (!fs.existsSync(ACC_FILE)) {
    const seeded = fs.existsSync(LOCAL_ACC) ? readAccFile(LOCAL_ACC) : [];
    fs.writeFileSync(ACC_FILE, JSON.stringify(seeded, null, 2));
  }
}

function loadAcc() {
  ensureDir();
  let main = [];
  try { main = JSON.parse(fs.readFileSync(ACC_FILE, "utf8")); } catch (e) { main = []; }
  if ((!main || !main.length) && fs.existsSync(LOCAL_ACC) && path.resolve(ACC_FILE) !== path.resolve(LOCAL_ACC)) {
    const extra = readAccFile(LOCAL_ACC);
    if (extra.length) {
      main = mergeAcc(main, extra);
      try { writeAtomic(ACC_FILE, JSON.stringify(main, null, 2)); } catch (e) {}
    }
  }
  return main || [];
}

function writeAtomic(file, raw) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, file);
}
function saveAcc(list) {
  ensureDir();
  const raw = JSON.stringify(list, null, 2);
  writeAtomic(ACC_FILE, raw);
  try {
    const localDir = path.join(__dirname, "..", "data");
    fs.mkdirSync(localDir, { recursive: true });
    if (path.resolve(ACC_FILE) !== path.resolve(LOCAL_ACC)) writeAtomic(LOCAL_ACC, raw);
  } catch (e) {}
}

function hashPass(pass, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(pass || ""), salt, 32).toString("hex");
  return { salt, hash };
}

function checkPass(pass, acc) {
  if (!acc) return false;
  if (acc.salt && acc.hash) {
    const h = crypto.scryptSync(String(pass || ""), acc.salt, 32).toString("hex");
    return h === acc.hash;
  }
  if (acc.pass) {
    const old = crypto.createHash("sha256").update(String(pass || "")).digest("hex");
    return old === acc.pass;
  }
  return false;
}

function saveAvatar(accId, dataUrl) {
  ensureDir();
  if (!dataUrl || typeof dataUrl !== "string") return "";
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) return dataUrl.startsWith("/uploads/") ? dataUrl : "";
  const ext = m[1].includes("png") ? "png" : m[1].includes("webp") ? "webp" : "jpg";
  let buf;
  try { buf = Buffer.from(m[2], "base64"); } catch (e) { return ""; }
  if (buf.length > 400000) return "";
  const name = accId + "." + ext;
  fs.writeFileSync(path.join(AV_DIR, name), buf);
  return "/uploads/avatars/" + name + "?t=" + Date.now();
}

function pubAcc(acc) {
  if (!acc) return null;
  return {
    id: acc.id,
    name: acc.name,
    contact: acc.contact,
    via: acc.via,
    pts: acc.pts || 0,
    renamedAt: acc.renamedAt || 0,
    avatarAt: acc.avatarAt || 0,
    av: acc.av || "",
    stats: acc.stats || { games: 0, wins: 0, losses: 0, draws: 0 },
    createdAt: acc.createdAt || 0,
    provider: acc.provider || acc.via || "",
    nameSet: !!acc.nameSet
  };
}

function logMatch(row) {
  ensureDir();
  fs.appendFileSync(LOG_FILE, JSON.stringify(Object.assign({ at: Date.now() }, row)) + "\n");
}

function token() {
  return crypto.randomBytes(24).toString("hex");
}

module.exports = {
  DATA, AV_DIR, ensureDir, loadAcc, saveAcc, hashPass, checkPass,
  saveAvatar, pubAcc, logMatch, token
};
