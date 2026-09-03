const crypto = require("crypto");
const pending = new Map();
const claims = new Map();

function publicBase(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, "");
  const forwarded = req.headers["x-forwarded-proto"];
  const proto = (forwarded ? forwarded.split(",")[0].trim() : (req.socket && req.socket.encrypted ? "https" : "http"));
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:8080";
  return proto + "://" + host;
}

function cfg() {
  return {
    googleId: process.env.GOOGLE_CLIENT_ID || "",
    googleSecret: process.env.GOOGLE_CLIENT_SECRET || "",
    fbId: process.env.FACEBOOK_APP_ID || "",
    fbSecret: process.env.FACEBOOK_APP_SECRET || ""
  };
}

function putState(data) {
  const st = crypto.randomBytes(16).toString("hex");
  pending.set(st, Object.assign({ exp: Date.now() + 10 * 60 * 1000 }, data));
  return st;
}
function takeState(st) {
  const rec = pending.get(st);
  pending.delete(st);
  if (!rec || rec.exp < Date.now()) return null;
  return rec;
}
function putClaim(sid, payload) {
  claims.set(sid, Object.assign({ exp: Date.now() + 10 * 60 * 1000 }, payload));
}
function takeClaim(sid) {
  const rec = claims.get(sid);
  claims.delete(sid);
  if (!rec || rec.exp < Date.now()) return null;
  return rec;
}

function form(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");
}

async function postForm(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form(body)
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) {
    text.split("&").forEach((p) => {
      const i = p.indexOf("=");
      if (i > 0) json[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1));
    });
  }
  if (!res.ok) throw new Error(json.error || ("http " + res.status));
  return json;
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: token ? { Authorization: "Bearer " + token } : {} });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error && json.error.message ? json.error.message : ("http " + res.status));
  return json;
}

function googleAuthUrl(req, sid) {
  const c = cfg();
  if (!c.googleId) throw new Error("Chưa cấu hình GOOGLE_CLIENT_ID trên server.");
  const state = putState({ provider: "google", sid: sid || "" });
  const redirect = publicBase(req) + "/auth/google/callback";
  return "https://accounts.google.com/o/oauth2/v2/auth?" + form({
    client_id: c.googleId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state: state
  });
}

function facebookAuthUrl(req, sid) {
  const c = cfg();
  if (!c.fbId) throw new Error("Chưa cấu hình FACEBOOK_APP_ID trên server.");
  const state = putState({ provider: "facebook", sid: sid || "" });
  const redirect = publicBase(req) + "/auth/facebook/callback";
  return "https://www.facebook.com/v19.0/dialog/oauth?" + form({
    client_id: c.fbId,
    redirect_uri: redirect,
    response_type: "code",
    scope: "email,public_profile",
    state: state
  });
}

async function googleUser(req, code) {
  const c = cfg();
  const redirect = publicBase(req) + "/auth/google/callback";
  const tok = await postForm("https://oauth2.googleapis.com/token", {
    code: code,
    client_id: c.googleId,
    client_secret: c.googleSecret,
    redirect_uri: redirect,
    grant_type: "authorization_code"
  });
  const u = await getJson("https://www.googleapis.com/oauth2/v3/userinfo", tok.access_token);
  return {
    provider: "google",
    providerId: String(u.sub || ""),
    email: String(u.email || "").toLowerCase(),
    name: String(u.name || "").slice(0, 16),
    picture: u.picture || ""
  };
}

async function facebookUser(req, code) {
  const c = cfg();
  const redirect = publicBase(req) + "/auth/facebook/callback";
  const tok = await postForm("https://graph.facebook.com/v19.0/oauth/access_token", {
    client_id: c.fbId,
    client_secret: c.fbSecret,
    redirect_uri: redirect,
    code: code
  });
  const u = await getJson("https://graph.facebook.com/me?fields=id,name,email,picture.type(large)&access_token=" + encodeURIComponent(tok.access_token));
  return {
    provider: "facebook",
    providerId: String(u.id || ""),
    email: String(u.email || "").toLowerCase(),
    name: String(u.name || "").slice(0, 16),
    picture: u.picture && u.picture.data ? u.picture.data.url : ""
  };
}

module.exports = {
  cfg, googleAuthUrl, facebookAuthUrl, googleUser, facebookUser,
  takeState, putClaim, takeClaim, publicBase
};
