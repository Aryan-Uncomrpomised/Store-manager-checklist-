// Dispatch SOP server — zero dependencies (Node 18+).
// Storage: Supabase (free tier) when SUPABASE_URL + SUPABASE_SERVICE_KEY are set,
// otherwise JSON files and videos under DATA_DIR.
// Env: TEAM_PASSWORD (required), SESSION_SECRET (recommended), SUPABASE_URL, SUPABASE_SERVICE_KEY, DATA_DIR, PORT.
"use strict";
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const PORT = +process.env.PORT || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const BLOB_DIR = path.join(DATA_DIR, "blobs");
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("sop:" + TEAM_PASSWORD).digest("hex");
const PUB = path.join(__dirname, "public");
const COLLECTIONS = new Set(["daylog", "stock", "products", "videos"]);
const MAX_DOC = 256 * 1024;
const MAX_BLOB = 20 * 1024 * 1024;
const VIDEO_TYPES = { "video/mp4": ".mp4", "video/webm": ".webm" };
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const SB = !!(SB_URL && SB_KEY);
const SB_TABLE = "sop_docs", SB_BUCKET = "sop-videos";
function sbHeaders(extra) { return Object.assign({ apikey: SB_KEY, Authorization: "Bearer " + SB_KEY }, extra || {}); }

if (!TEAM_PASSWORD) console.warn("WARNING: TEAM_PASSWORD is not set. Nobody can sign in until you set it.");
if (!SB) fs.mkdirSync(BLOB_DIR, { recursive: true });
console.log(SB ? "Storage: Supabase" : "Storage: local files in " + DATA_DIR);

/* ---------- JSON store (one file per collection, writes serialized) ---------- */
const cache = {};
const queues = {};
function colFile(c) { return path.join(DATA_DIR, c + ".json"); }
function load(c) {
  if (!cache[c]) {
    if (SB) cache[c] = {};
    else { try { cache[c] = JSON.parse(fs.readFileSync(colFile(c), "utf8")); } catch { cache[c] = {}; } }
  }
  return cache[c];
}
// Save one document (or delete it when it no longer exists in the cache).
function persist(c, id) {
  const run = SB ? async () => {
    const doc = cache[c] && cache[c][id];
    let r;
    if (doc === undefined) {
      r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?col=eq.${encodeURIComponent(c)}&id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: sbHeaders() });
    } else {
      r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?on_conflict=col,id`, { method: "POST", headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify({ col: c, id, data: doc }) });
    }
    if (!r.ok) throw new Error("Supabase write failed: " + r.status + " " + (await r.text()).slice(0, 200));
  } : async () => {
    const tmp = colFile(c) + "." + process.pid + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(cache[c]));
    await fsp.rename(tmp, colFile(c));
  };
  const key = SB ? c + "/" + id : c;
  queues[key] = (queues[key] || Promise.resolve()).then(run, run);
  return queues[key];
}
async function sbLoadAll() {
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${SB_TABLE}?select=col,id,data&order=col,id`, { headers: sbHeaders({ Range: `${from}-${from + 999}`, "Range-Unit": "items" }) });
    if (!r.ok) throw new Error("Could not read Supabase table " + SB_TABLE + ": " + r.status + " " + (await r.text()).slice(0, 300));
    const rows = await r.json();
    rows.forEach(x => { load(x.col)[x.id] = x.data; });
    if (rows.length < 1000) break;
  }
}
const USERS = "users";
function users() { return load(USERS); }

/* ---------- sessions ---------- */
function sign(v) { return crypto.createHmac("sha256", SECRET).update(v).digest("base64url"); }
function makeCookie(uid) {
  const v = Buffer.from(JSON.stringify({ uid, t: Date.now() })).toString("base64url");
  return v + "." + sign(v);
}
function readSession(req) {
  const m = /(?:^|;\s*)sop=([^;]+)/.exec(req.headers.cookie || "");
  if (!m) return null;
  const [v, s] = m[1].split(".");
  if (!v || !s) return null;
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(v, "base64url").toString()); return users()[o.uid] ? o : null; } catch { return null; }
}
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest(), y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const attempts = new Map();
function limited(ip) {
  const now = Date.now(), r = attempts.get(ip) || { n: 0, t: now };
  if (now - r.t > 15 * 60 * 1000) { r.n = 0; r.t = now; }
  r.n++; attempts.set(ip, r);
  return r.n > 20;
}

/* ---------- helpers ---------- */
function send(res, code, body, headers) {
  const isBuf = Buffer.isBuffer(body) || typeof body === "string";
  res.writeHead(code, Object.assign({ "Content-Type": isBuf ? "text/plain; charset=utf-8" : "application/json", "Cache-Control": "no-store" }, headers || {}));
  res.end(isBuf ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { reject(Object.assign(new Error("too_large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJSON(req) {
  const b = await readBody(req, MAX_DOC + 1024);
  try { return JSON.parse(b.toString("utf8") || "{}"); } catch { throw Object.assign(new Error("bad_json"), { code: 400 }); }
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
async function serveFile(res, file, cacheCtl) {
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": cacheCtl || "no-cache" });
    res.end(buf);
  } catch { send(res, 404, "Not found"); }
}
async function serveBlob(req, res, id) {
  const meta = load("blobs")[id];
  if (!meta) return send(res, 404, "Not found");
  if (SB) {
    const h = sbHeaders(); if (req.headers.range) h.Range = req.headers.range;
    const r = await fetch(`${SB_URL}/storage/v1/object/authenticated/${SB_BUCKET}/${id}${VIDEO_TYPES[meta.type]}`, { headers: h });
    if (!r.ok && r.status !== 206) return send(res, r.status === 416 ? 416 : 404, "Not found");
    const out = { "Content-Type": meta.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable" };
    ["content-length", "content-range"].forEach(k => { const v = r.headers.get(k); if (v) out[k] = v; });
    res.writeHead(r.status, out);
    const reader = r.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (!res.write(value)) await new Promise(ok => res.once("drain", ok)); }
    return res.end();
  }
  const file = path.join(BLOB_DIR, id + VIDEO_TYPES[meta.type]);
  let st; try { st = await fsp.stat(file); } catch { return send(res, 404, "Not found"); }
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  const base = { "Content-Type": meta.type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable" };
  if (range) {
    let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? +range[2] : st.size - 1;
    if (!range[1]) end = st.size - 1;
    if (start >= st.size || start < 0 || end < start) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
    end = Math.min(end, st.size - 1);
    res.writeHead(206, Object.assign(base, { "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 }));
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, Object.assign(base, { "Content-Length": st.size }));
  fs.createReadStream(file).pipe(res);
}

/* ---------- routes ---------- */
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;

  if (p === "/healthz") return send(res, 200, "ok");

  if (p === "/api/login" && req.method === "POST") {
    if (limited(ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const b = await readJSON(req);
    const name = String(b.name || "").trim().slice(0, 60);
    if (!TEAM_PASSWORD || !safeEq(b.password || "", TEAM_PASSWORD)) return send(res, 401, { error: "Wrong team password." });
    if (!name) return send(res, 400, { error: "Enter your name." });
    const key = name.toLowerCase();
    const u = users();
    let uid = Object.keys(u).find(id => u[id].key === key);
    if (!uid) { uid = "u_" + crypto.randomBytes(11).toString("hex"); u[uid] = { name, key, created: Date.now() }; await persist(USERS, uid); }
    const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
    return send(res, 200, { ok: true }, { "Set-Cookie": `sop=${makeCookie(uid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${secure}` });
  }
  if (p === "/api/logout") return send(res, 200, { ok: true }, { "Set-Cookie": "sop=; Path=/; Max-Age=0" });

  if (p === "/login" || p === "/login.html") return serveFile(res, path.join(PUB, "login.html"));

  const sess = readSession(req);
  if (!sess) {
    if (p.startsWith("/api/") || p.startsWith("/_blob/")) return send(res, 401, { error: "Sign in first." });
    res.writeHead(302, { Location: "/login" }); return res.end();
  }

  if (p === "/" || p === "/index.html") return serveFile(res, path.join(PUB, "index.html"));
  if (p === "/shim.js") return serveFile(res, path.join(PUB, "shim.js"));
  if (p.startsWith("/_blob/")) { const id = p.slice(7); if (!/^[a-f0-9]{32}$/.test(id)) return send(res, 404, "Not found"); return serveBlob(req, res, id); }

  if (p === "/api/me") { const u = users()[sess.uid]; return send(res, 200, { id: sess.uid, name: u.name }); }
  if (p === "/api/profiles") {
    const u = users(), out = {};
    (url.searchParams.get("ids") || "").split(",").filter(Boolean).slice(0, 200).forEach(id => { out[id] = { id, name: (u[id] && u[id].name) || "" }; });
    return send(res, 200, out);
  }

  let m = /^\/api\/col\/([a-z]+)$/.exec(p);
  if (m && req.method === "GET") {
    if (!COLLECTIONS.has(m[1])) return send(res, 404, { error: "Unknown collection" });
    const c = load(m[1]);
    return send(res, 200, Object.keys(c).map(id => ({ id, data: c[id] })));
  }
  m = /^\/api\/doc\/([a-z]+)\/([^/]+)$/.exec(p);
  if (m) {
    const col = m[1], id = decodeURIComponent(m[2]);
    if (!COLLECTIONS.has(col) || !ID_RE.test(id)) return send(res, 400, { code: "invalid_argument" });
    const c = load(col);
    if (req.method === "GET") return send(res, 200, c[id] ? { exists: true, data: c[id] } : { exists: false });
    if (req.method === "PUT") {
      const body = await readJSON(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, { code: "invalid_argument" });
      c[id] = body; await persist(col, id); return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE") { delete c[id]; await persist(col, id); return send(res, 200, { ok: true }); }
  }

  if (p === "/api/upload" && req.method === "POST") {
    const type = String(req.headers["content-type"] || "").split(";")[0].trim();
    if (!VIDEO_TYPES[type]) return send(res, 415, { code: "unsupported_type" });
    if (+req.headers["content-length"] > MAX_BLOB) return send(res, 413, { code: "too_large" });
    const buf = await readBody(req, MAX_BLOB);
    if (!buf.length) return send(res, 400, { code: "invalid_request" });
    const id = crypto.randomBytes(16).toString("hex");
    if (SB) {
      const r = await fetch(`${SB_URL}/storage/v1/object/${SB_BUCKET}/${id}${VIDEO_TYPES[type]}`, { method: "POST", headers: sbHeaders({ "Content-Type": type }), body: buf });
      if (!r.ok) { console.error("Supabase upload failed", r.status, (await r.text()).slice(0, 200)); return send(res, 502, { code: "store_unavailable", error: "Upload failed" }); }
    } else await fsp.writeFile(path.join(BLOB_DIR, id + VIDEO_TYPES[type]), buf);
    load("blobs")[id] = { type, size: buf.length, by: sess.uid, at: Date.now() }; await persist("blobs", id);
    return send(res, 200, { id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: type });
  }
  m = /^\/api\/blob\/([a-f0-9]{32})$/.exec(p);
  if (m && req.method === "DELETE") {
    const b = load("blobs"), meta = b[m[1]];
    if (!meta) return send(res, 200, { deleted: false });
    try {
      if (SB) await fetch(`${SB_URL}/storage/v1/object/${SB_BUCKET}/${m[1]}${VIDEO_TYPES[meta.type]}`, { method: "DELETE", headers: sbHeaders() });
      else await fsp.unlink(path.join(BLOB_DIR, m[1] + VIDEO_TYPES[meta.type]));
    } catch {}
    delete b[m[1]]; await persist("blobs", m[1]);
    return send(res, 200, { deleted: true });
  }

  send(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(e => {
    if (!res.headersSent) send(res, e.code === 413 ? 413 : e.code === 400 ? 400 : 500, { code: e.code === 413 ? "too_large" : "error", error: e.message });
    else res.end();
  });
});
(SB ? sbLoadAll() : Promise.resolve()).then(() => {
  server.listen(PORT, () => console.log(`Dispatch SOP running on port ${PORT}`));
}).catch(e => { console.error(e.message); console.error("Did you run supabase-setup.sql in the Supabase SQL editor?"); process.exit(1); });
