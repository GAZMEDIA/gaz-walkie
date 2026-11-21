// GAZ Walkie-Talkie relay for Cloudflare Workers (free plan).
// One Durable Object ("global") holds every live connection and relays
// push-to-talk audio to a channel or to one person.
// Uses the WebSocket Hibernation API so idle time costs nothing.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      return env.RELAY.getByName("global").fetch(request);
    }
    if (url.pathname.endsWith("/health")) {
      return env.RELAY.getByName("global").fetch(new Request(url.origin + "/health"));
    }
    // Also serve the web app over HTTPS, loaded from the main site (one copy of the page).
    const file = url.pathname.split("/").pop() || "index.html";
    if (!/^[\w.-]+$/.test(file)) return new Response("Not found", { status: 404 });
    const r = await fetch(ORIGIN + "/" + file, { cf: { cacheTtl: 60 } });
    return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "text/plain", "cache-control": "no-cache" } });
  },
};

const ORIGIN = "http://talk.gazgoc.com.ng";

const MAX_TALK_MS = 60_000;

export class Relay {
  constructor(ctx, env) {
    this.ctx = ctx;
    // Keep-alive pings are answered without waking the object (saves free-plan quota).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/health")) {
      return new Response("ok " + this.ctx.getWebSockets().length);
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name: "Guest", channel: null, talking: false, target: null, since: 0 });
    server.send(JSON.stringify({ t: "welcome", id }));
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- helpers
  all() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, s: ws.deserializeAttachment() || {} }));
  }
  save(c) { c.ws.serializeAttachment(c.s); }
  send(c, obj) { try { c.ws.send(JSON.stringify(obj)); } catch {} }
  find(ws) { return { ws, s: ws.deserializeAttachment() || {} }; }
  byId(id) { return this.all().find((x) => x.s.id === id); }
  membersOf(channel) { return this.all().filter((x) => x.s.channel === channel); }
  isTalking(c) { return c.s.talking && Date.now() - c.s.since < MAX_TALK_MS; }

  listeners(c) {
    if (c.s.target) { const t = this.byId(c.s.target); return t ? [t] : []; }
    return this.membersOf(c.s.channel).filter((x) => x.s.id !== c.s.id);
  }

  broadcastMembers(channel) {
    if (!channel) return;
    const members = this.membersOf(channel);
    const list = members.map((x) => ({ id: x.s.id, name: x.s.name, talking: this.isTalking(x) && !x.s.target }));
    for (const x of members) this.send(x, { t: "members", channel, list });
  }

  // ---------------------------------------------------------------- messages
  async webSocketMessage(ws, msg) {
    const c = this.find(ws);
    if (typeof msg !== "string") {                                   // audio chunk
      if (!this.isTalking(c) || msg.byteLength > 8000) return;
      for (const x of this.listeners(c)) { try { x.ws.send(msg); } catch {} }
      return;
    }
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (m.t === "join") this.join(c, String(m.channel || "general"), String(m.name || "Guest"));
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
    // getWebSockets() may still list the closing socket briefly; it has no channel now.
    this.broadcastMembers(channel);
  }

  join(c, channel, name) {
    this.stopTalk(c);
    const old = c.s.channel;
    c.s.channel = clean(channel, 30).toLowerCase() || "general";
    c.s.name = clean(name, 24) || "Guest";
    this.save(c);
    if (old && old !== c.s.channel) this.broadcastMembers(old);
    this.broadcastMembers(c.s.channel);
  }

  startTalk(c, to) {
    if (!c.s.channel) return;
    if (c.s.talking) this.stopTalk(c);
    if (to) {
      const t = this.byId(to);
      if (!t) return this.send(c, { t: "busy", by: "That person has left" });
      if (this.isTalking(t) || this.isHearingSomeone(t)) return this.send(c, { t: "busy", by: t.s.name });
    } else {
      const holder = this.membersOf(c.s.channel).find((x) => x.s.id !== c.s.id && this.isTalking(x) && !x.s.target);
      if (holder) return this.send(c, { t: "busy", by: holder.s.name });
    }
    c.s.talking = true; c.s.target = to; c.s.since = Date.now();
    this.save(c);
    this.send(c, { t: "granted", to });
    for (const x of this.listeners(c)) this.send(x, { t: "speaking", id: c.s.id, name: c.s.name, private: !!to });
    if (!to) this.broadcastMembers(c.s.channel);
  }

  isHearingSomeone(t) {
    return this.all().some((x) => x.s.id !== t.s.id && this.isTalking(x) &&
      (x.s.target === t.s.id || (!x.s.target && x.s.channel === t.s.channel)));
  }

  stopTalk(c) {
    if (!c.s.talking) return;
    for (const x of this.listeners(c)) this.send(x, { t: "quiet", id: c.s.id });
    const wasPublic = !c.s.target;
    c.s.talking = false; c.s.target = null; c.s.since = 0;
    this.save(c);
    this.send(c, { t: "stopped" });
    if (wasPublic) this.broadcastMembers(c.s.channel);
  }
}

function clean(s, n) { return s.replace(/[<>]/g, "").trim().slice(0, n); }
