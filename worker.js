// GAZ Walkie-Talkie: accounts, groups with access codes, and push-to-talk relay.
// Runs free on Cloudflare Workers + one SQLite-backed Durable Object ("global").
//
// HTTP API (JSON, CORS-enabled so the page can live on another domain):
//   POST /api/register {username,password}      -> {token,user}
//   POST /api/login    {username,password}      -> {token,user}
//   POST /api/logout
//   GET  /api/me                                -> {user, groups:[...]}
//   POST /api/groups {name}                     -> create group (you become owner)
//   GET  /api/groups/search?q=                  -> find groups by name
//   GET  /api/groups/:id                        -> details (owner also sees code + requests)
//   POST /api/groups/:id/join {code}            -> join with the access code
//   POST /api/groups/:id/request                -> ask the owner to let you in
//   POST /api/groups/:id/approve {userId}       -> owner: accept a request
//   POST /api/groups/:id/reject  {userId}       -> owner: decline a request
//   POST /api/groups/:id/remove  {userId}       -> owner: remove a member
//   POST /api/groups/:id/code                   -> owner: new access code
//   POST /api/groups/:id/leave                  -> leave a group
//   POST /api/groups/:id/delete                 -> owner: delete the group
// WebSocket /ws?token=... then {t:"join", group:id}; talk protocol as before.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (url.pathname.endsWith("/ws") || url.pathname.startsWith("/api/") || url.pathname.endsWith("/health")) {
      if (url.pathname.endsWith("/ws") && request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return env.RELAY.getByName("global").fetch(request);
    }
    // The web app itself (public/) is served by Cloudflare static assets before this code runs.
    return new Response("Not found", { status: 404 });
  },
};
const MAX_TALK_MS = 60_000;

export class Relay {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.attempts = new Map(); // throttle wrong passwords / codes
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, uname_lc TEXT UNIQUE, hash TEXT, salt TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, name_lc TEXT, owner_id TEXT, code TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS members (group_id TEXT, user_id TEXT, role TEXT, joined INTEGER, PRIMARY KEY (group_id, user_id));
      CREATE TABLE IF NOT EXISTS requests (group_id TEXT, user_id TEXT, created INTEGER, PRIMARY KEY (group_id, user_id));
    `);
  }

  // ================================================================ HTTP
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/health")) return new Response("ok " + this.ctx.getWebSockets().length);
    if (url.pathname.endsWith("/ws")) return this.openSocket(url);
    try {
      const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
      const user = this.userFromToken((request.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
      return json(await this.api(request.method, url, body, user, request));
    } catch (e) {
      if (e instanceof ApiError) return json({ error: e.message }, e.status);
      return json({ error: "Server error" }, 500);
    }
  }

  async api(method, url, b, user, request) {
    const p = url.pathname.replace(/^\/api/, "");
    if (method === "POST" && p === "/register") return this.register(b);
    if (method === "POST" && p === "/login") return this.login(b, request);
    if (!user) throw new ApiError(401, "Please log in again.");
    if (method === "POST" && p === "/logout") {
      this.sql.exec("DELETE FROM sessions WHERE token = ?", user.token); return { ok: true };
    }
    if (method === "GET" && p === "/me") return { user: pub(user), groups: this.myGroups(user.id) };
    if (method === "POST" && p === "/groups") return this.createGroup(user, b);
    if (method === "GET" && p === "/groups/search") return { groups: this.search(user, url.searchParams.get("q") || "") };
    const m = p.match(/^\/groups\/([\w-]+)(?:\/(\w+))?$/);
    if (!m) throw new ApiError(404, "Not found");
    const g = this.group(m[1]);
    if (!g) throw new ApiError(404, "Group not found.");
    const action = m[2] || "";
    const isOwner = g.owner_id === user.id;
    const ownerOnly = () => { if (!isOwner) throw new ApiError(403, "Only the group owner can do that."); };

    if (method === "GET" && !action) return this.groupDetails(g, user);
    if (method !== "POST") throw new ApiError(405, "Not allowed");
    switch (action) {
      case "join": {
        if (this.isMember(g.id, user.id)) return { ok: true };
        this.throttle("code:" + user.id + ":" + g.id, 8);
        if (String(b.code || "").trim() !== g.code) throw new ApiError(403, "Wrong access code. Ask the group owner for the code.");
        this.addMember(g.id, user.id, "member");
        this.notifyGroup(g.id);
        return { ok: true };
      }
      case "request": {
        if (this.isMember(g.id, user.id)) return { ok: true, member: true };
        this.sql.exec("INSERT OR IGNORE INTO requests VALUES (?,?,?)", g.id, user.id, Date.now());
        this.notifyUser(g.owner_id, { t: "request", group: g.id, groupName: g.name, from: user.username });
        return { ok: true, requested: true };
      }
      case "approve": case "reject": {
        ownerOnly();
        const uid = String(b.userId || "");
        this.sql.exec("DELETE FROM requests WHERE group_id = ? AND user_id = ?", g.id, uid);
        if (action === "approve" && this.userById(uid)) {
          this.addMember(g.id, uid, "member");
          this.notifyUser(uid, { t: "approved", group: g.id, groupName: g.name });
          this.notifyGroup(g.id);
        }
        return this.groupDetails(g, user);
      }
      case "remove": {
        ownerOnly();
        const uid = String(b.userId || "");
        if (uid === g.owner_id) throw new ApiError(400, "The owner can't be removed.");
        this.sql.exec("DELETE FROM members WHERE group_id = ? AND user_id = ?", g.id, uid);
        this.kick(g.id, uid, "You were removed from " + g.name + ".");
        this.notifyGroup(g.id);
        return this.groupDetails(g, user);
      }
      case "code": {
        ownerOnly();
        this.sql.exec("UPDATE groups SET code = ? WHERE id = ?", newCode(), g.id);
        return this.groupDetails(this.group(g.id), user);
      }
      case "leave": {
        if (isOwner) throw new ApiError(400, "You own this group. Delete it instead.");
        this.sql.exec("DELETE FROM members WHERE group_id = ? AND user_id = ?", g.id, user.id);
        this.kick(g.id, user.id, null);
        this.notifyGroup(g.id);
        return { ok: true };
      }
      case "delete": {
        ownerOnly();
        for (const r of this.sql.exec("SELECT user_id FROM members WHERE group_id = ?", g.id).toArray()) {
          this.kick(g.id, r.user_id, r.user_id === user.id ? null : g.name + " was deleted by the owner.");
        }
        this.sql.exec("DELETE FROM members WHERE group_id = ?", g.id);
        this.sql.exec("DELETE FROM requests WHERE group_id = ?", g.id);
        this.sql.exec("DELETE FROM groups WHERE id = ?", g.id);
        return { ok: true };
      }
    }
    throw new ApiError(404, "Not found");
  }

  // ---------------------------------------------------------------- accounts
  async register(b) {
    const username = String(b.username || "").trim();
    const password = String(b.password || "");
    if (!/^[A-Za-z0-9_.]{3,20}$/.test(username)) throw new ApiError(400, "Username: 3–20 letters, numbers, _ or .");
    if (password.length < 6) throw new ApiError(400, "Password must be at least 6 characters.");
    if (this.sql.exec("SELECT 1 FROM users WHERE uname_lc = ?", username.toLowerCase()).toArray().length) {
      throw new ApiError(409, "That username is taken.");
    }
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    const id = rid();
    this.sql.exec("INSERT INTO users VALUES (?,?,?,?,?,?)", id, username, username.toLowerCase(), await hashPw(password, salt), salt, Date.now());
    return this.newSession(id);
  }

  async login(b) {
    const uname = String(b.username || "").trim().toLowerCase();
    this.throttle("login:" + uname, 10);
    const u = this.sql.exec("SELECT * FROM users WHERE uname_lc = ?", uname).toArray()[0];
    if (!u || (await hashPw(String(b.password || ""), u.salt)) !== u.hash) {
      throw new ApiError(401, "Wrong username or password.");
    }
    this.attempts.delete("login:" + uname);
    return this.newSession(u.id);
  }

  newSession(userId) {
    const token = hex(crypto.getRandomValues(new Uint8Array(24)));
    this.sql.exec("INSERT INTO sessions VALUES (?,?,?)", token, userId, Date.now());
    return { token, user: pub(this.userById(userId)) };
  }

  userFromToken(token) {
    if (!token || token.length < 20) return null;
    const r = this.sql.exec(
      "SELECT u.id, u.username, s.token FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?", token
    ).toArray()[0];
    return r || null;
  }
  userById(id) { return this.sql.exec("SELECT id, username FROM users WHERE id = ?", id).toArray()[0] || null; }

  throttle(key, max) {
    const now = Date.now(), a = this.attempts.get(key) || { n: 0, since: now };
    if (now - a.since > 10 * 60_000) { a.n = 0; a.since = now; }
    a.n++; this.attempts.set(key, a);
    if (a.n > max) throw new ApiError(429, "Too many tries. Wait 10 minutes and try again.");
  }

  // ---------------------------------------------------------------- groups
  createGroup(user, b) {
    const name = clean(String(b.name || ""), 30);
    if (name.length < 3) throw new ApiError(400, "Group name must be at least 3 characters.");
    if (this.sql.exec("SELECT COUNT(*) AS n FROM groups WHERE owner_id = ?", user.id).one().n >= 10) {
      throw new ApiError(400, "You can own up to 10 groups.");
    }
    const id = rid();
    this.sql.exec("INSERT INTO groups VALUES (?,?,?,?,?,?)", id, name, name.toLowerCase(), user.id, newCode(), Date.now());
    this.addMember(id, user.id, "owner");
    return this.groupDetails(this.group(id), user);
  }

  group(id) { return this.sql.exec("SELECT * FROM groups WHERE id = ?", id).toArray()[0] || null; }
  isMember(gid, uid) { return this.sql.exec("SELECT 1 FROM members WHERE group_id = ? AND user_id = ?", gid, uid).toArray().length > 0; }
  addMember(gid, uid, role) {
    this.sql.exec("INSERT OR IGNORE INTO members VALUES (?,?,?,?)", gid, uid, role, Date.now());
    this.sql.exec("DELETE FROM requests WHERE group_id = ? AND user_id = ?", gid, uid);
  }

  myGroups(uid) {
    return this.sql.exec(`
      SELECT g.id, g.name, m.role, (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS members,
             (SELECT COUNT(*) FROM requests WHERE group_id = g.id) AS pending
      FROM members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ? ORDER BY g.name_lc`, uid
    ).toArray().map((g) => ({ ...g, online: this.onlineIn(g.id).size, pending: g.role === "owner" ? g.pending : 0 }));
  }

  search(user, q) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    return this.sql.exec(`
      SELECT g.id, g.name, u.username AS owner, (SELECT COUNT(*) FROM members WHERE group_id = g.id) AS members,
             EXISTS(SELECT 1 FROM members WHERE group_id = g.id AND user_id = ?) AS member,
             EXISTS(SELECT 1 FROM requests WHERE group_id = g.id AND user_id = ?) AS requested
      FROM groups g JOIN users u ON u.id = g.owner_id WHERE g.name_lc LIKE ? ESCAPE '\\' ORDER BY g.name_lc LIMIT 20`,
      user.id, user.id, "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%"
    ).toArray().map((g) => ({ ...g, member: !!g.member, requested: !!g.requested }));
  }

  groupDetails(g, user) {
    const isOwner = g.owner_id === user.id, member = this.isMember(g.id, user.id);
    const online = this.onlineIn(g.id);
    const out = {
      id: g.id, name: g.name, isOwner, member,
      owner: this.userById(g.owner_id)?.username,
      members: member ? this.sql.exec(
        "SELECT u.id, u.username, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.role DESC, u.uname_lc", g.id
      ).toArray().map((x) => ({ ...x, online: online.has(x.id) })) : [],
    };
    if (isOwner) {
      out.code = g.code;
      out.requests = this.sql.exec(
        "SELECT u.id, u.username FROM requests r JOIN users u ON u.id = r.user_id WHERE r.group_id = ? ORDER BY r.created", g.id
      ).toArray();
    }
    return out;
  }

  // ================================================================ WebSocket
  openSocket(url) {
    const user = this.userFromToken(url.searchParams.get("token") || "");
    if (!user) return new Response("Please log in", { status: 401 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: rid(8), uid: user.id, name: user.username, channel: null, talking: false, target: null, since: 0 });
    server.send(JSON.stringify({ t: "welcome", id: user.id }));
    return new Response(null, { status: 101, webSocket: client });
  }

  all() { return this.ctx.getWebSockets().map((ws) => ({ ws, s: ws.deserializeAttachment() || {} })); }
  save(c) { c.ws.serializeAttachment(c.s); }
  send(c, obj) { try { c.ws.send(JSON.stringify(obj)); } catch {} }
  find(ws) { return { ws, s: ws.deserializeAttachment() || {} }; }
  membersOf(channel) { return this.all().filter((x) => x.s.channel === channel); }
  onlineIn(gid) { return new Set(this.membersOf(gid).map((x) => x.s.uid)); }
  isTalking(c) { return c.s.talking && Date.now() - c.s.since < MAX_TALK_MS; }
  byUid(channel, uid) { return this.membersOf(channel).filter((x) => x.s.uid === uid); }

  listeners(c) {
    if (c.s.target) return this.byUid(c.s.channel, c.s.target);
    return this.membersOf(c.s.channel).filter((x) => x.s.id !== c.s.id);
  }

  broadcastMembers(channel) {
    if (!channel) return;
    const conns = this.membersOf(channel), seen = new Map();
    for (const x of conns) {
      const talking = this.isTalking(x) && !x.s.target;
      const prev = seen.get(x.s.uid);
      seen.set(x.s.uid, { id: x.s.uid, name: x.s.name, talking: talking || !!prev?.talking });
    }
    const list = [...seen.values()];
    for (const x of conns) this.send(x, { t: "members", channel, list });
  }

  notifyUser(uid, obj) { for (const x of this.all()) if (x.s.uid === uid) this.send(x, obj); }
  notifyGroup(gid) {
    this.broadcastMembers(gid);
    for (const r of this.sql.exec("SELECT user_id FROM members WHERE group_id = ?", gid).toArray()) {
      this.notifyUser(r.user_id, { t: "groups-changed" });
    }
  }
  kick(gid, uid, message) {
    for (const x of this.byUid(gid, uid)) {
      this.stopTalk(x);
      x.s.channel = null; this.save(x);
      this.send(x, { t: "kicked", group: gid, message });
    }
    this.notifyUser(uid, { t: "groups-changed" });
    this.broadcastMembers(gid);
  }

  async webSocketMessage(ws, msg) {
    const c = this.find(ws);
    if (typeof msg !== "string") {                                   // audio chunk
      if (!this.isTalking(c) || msg.byteLength > 8000) return;
      for (const x of this.listeners(c)) { try { x.ws.send(msg); } catch {} }
      return;
    }
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m.t === "join") this.join(c, String(m.group || ""));
    else if (m.t === "talk") this.startTalk(c, m.to ? String(m.to) : null);
    else if (m.t === "stop") this.stopTalk(c);
    else if (m.t === "ping") this.send(c, { t: "pong" });
  }
  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }

  leave(ws) {
    const c = this.find(ws);
    this.stopTalk(c);
    const channel = c.s.channel;
    c.s.channel = null; this.save(c);
    try { ws.close(1000, "bye"); } catch {}
    this.broadcastMembers(channel);
  }

  join(c, gid) {
    this.stopTalk(c);
    if (!gid) {                                   // left the group screen
      const old = c.s.channel; c.s.channel = null; this.save(c); this.broadcastMembers(old); return;
    }
    if (!this.group(gid) || !this.isMember(gid, c.s.uid)) {
      return this.send(c, { t: "kicked", group: gid, message: "You're not a member of that group." });
    }
    const old = c.s.channel;
    c.s.channel = gid; this.save(c);
    if (old && old !== gid) this.broadcastMembers(old);
    this.broadcastMembers(gid);
  }

  startTalk(c, to) {
    if (!c.s.channel) return;
    if (c.s.talking) this.stopTalk(c);
    if (to) {
      const t = this.byUid(c.s.channel, to);
      if (!t.length) return this.send(c, { t: "busy", by: "That person is offline" });
      if (t.some((x) => this.isTalking(x) || this.isHearingSomeone(x))) return this.send(c, { t: "busy", by: t[0].s.name });
    } else {
      const holder = this.membersOf(c.s.channel).find((x) => x.s.id !== c.s.id && this.isTalking(x) && !x.s.target);
      if (holder) return this.send(c, { t: "busy", by: holder.s.name });
    }
    c.s.talking = true; c.s.target = to; c.s.since = Date.now();
    this.save(c);
    this.send(c, { t: "granted", to });
    for (const x of this.listeners(c)) this.send(x, { t: "speaking", id: c.s.uid, name: c.s.name, private: !!to });
    if (!to) this.broadcastMembers(c.s.channel);
  }

  isHearingSomeone(t) {
    return this.all().some((x) => x.s.id !== t.s.id && this.isTalking(x) && x.s.channel === t.s.channel &&
      (x.s.target === t.s.uid || !x.s.target));
  }

  stopTalk(c) {
    if (!c.s.talking) return;
    for (const x of this.listeners(c)) this.send(x, { t: "quiet", id: c.s.uid });
    const wasPublic = !c.s.target;
    c.s.talking = false; c.s.target = null; c.s.since = 0;
    this.save(c);
    this.send(c, { t: "stopped" });
    if (wasPublic) this.broadcastMembers(c.s.channel);
  }
}

// ================================================================ helpers
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...CORS } });
}
function pub(u) { return { id: u.id, username: u.username }; }
function clean(s, n) { return s.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, n); }
function hex(a) { return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function rid(n = 10) { return hex(crypto.getRandomValues(new Uint8Array(n))).slice(0, n); }
function newCode() {
  const v = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return String(v).padStart(6, "0");
}
async function hashPw(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 50_000 }, key, 256
  );
  return hex(new Uint8Array(bits));
}
