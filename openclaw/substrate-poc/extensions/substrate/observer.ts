// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
/**
 * Demo observer: records what the gateway knows about each conversation
 * (who it belongs to, the messages, turn timings, idle clock) and serves it as
 * JSON on a small in-cluster HTTP port, so the demo dashboard can render the
 * per-user chat channel next to the actor's Substrate lifecycle.
 *
 * It also accepts POST /substrate/chat, which drives a turn through the same
 * ACP runtime the Feishu channel uses (so idle-suspend and auto-resume apply
 * exactly as they do for Feishu traffic). The dashboard uses it to simulate
 * extra end users on stage.
 */
import http from "node:http";

export type ChatMessage = {
  at: number;
  role: "user" | "assistant" | "system";
  text: string;
  source?: string;
  latencyMs?: number;
  firstByteMs?: number;
  status?: string;
};

export type ConversationState = {
  actor: string;
  sessionKey: string;
  channel: string;
  peer: string;
  displayName?: string;
  messages: ChatMessage[];
  turns: number;
  lastActivity: number;
  inflight: number;
  phase: "idle" | "resuming" | "streaming" | "suspending" | "suspended";
  lastFirstByteMs?: number;
  lastSuspendAt?: number;
  lastSuspendMs?: number;
};

const MAX_MESSAGES = 200;

export type Observer = ReturnType<typeof createObserver>;

/** Best-effort parse of channel / peer out of an OpenClaw session key. */
export function describeSessionKey(sessionKey: string): { channel: string; peer: string } {
  const parts = sessionKey.split(":");
  const known = ["feishu", "lark", "whatsapp", "telegram", "slack", "web"];
  if (sessionKey.includes(":group:")) {
    const ch = parts.find((p) => known.includes(p)) ?? "unknown";
    return { channel: ch, peer: sessionKey.split(":group:")[1] ?? sessionKey };
  }
  const idx = parts.findIndex((p) => known.includes(p));
  const channel = idx >= 0 ? parts[idx] : "unknown";
  const peer =
    parts.find((p) => /^(ou|on|oc|u)_[A-Za-z0-9]+$/.test(p)) ??
    (idx >= 0 ? parts[parts.length - 1] : sessionKey);
  return { channel, peer };
}

/** Strip channel envelope lines (message ids, sender prefixes) for display. */
function cleanText(text: string): string {
  const lines = text.split("\n").filter((l) => !/^\s*\[(message_id|msg_id|reply_to)[^\]]*\]\s*$/i.test(l));
  let t = lines.join("\n").trim();
  t = t.replace(/^(?:ou|on|u)_[A-Za-z0-9]+(?:\s*\([^)]*\))?\s*[:：]\s*/, "");
  return t || text;
}

export function createObserver(opts: { idleTimeoutSeconds: number }) {
  const convs = new Map<string, ConversationState>();
  const turnStart = new Map<string, number>();
  const firstByte = new Map<string, number>();
  const pendingText = new Map<string, string>();
  const events: { at: number; actor: string; kind: string; detail: string }[] = [];

  const conv = (actor: string, sessionKey?: string): ConversationState => {
    let c = convs.get(actor);
    if (!c) {
      const d = describeSessionKey(sessionKey ?? actor);
      c = {
        actor,
        sessionKey: sessionKey ?? "",
        channel: d.channel,
        peer: d.peer,
        messages: [],
        turns: 0,
        lastActivity: Date.now(),
        inflight: 0,
        phase: "idle",
      };
      convs.set(actor, c);
    } else if (sessionKey && !c.sessionKey) {
      const d = describeSessionKey(sessionKey);
      c.sessionKey = sessionKey;
      c.channel = d.channel;
      c.peer = d.peer;
    }
    return c;
  };
  const push = (c: ConversationState, m: ChatMessage) => {
    c.messages.push(m);
    if (c.messages.length > MAX_MESSAGES) c.messages.shift();
  };
  const event = (actor: string, kind: string, detail: string) => {
    events.unshift({ at: Date.now(), actor, kind, detail });
    if (events.length > 300) events.pop();
  };

  return {
    session(actor: string, sessionKey: string, displayName?: string) {
      const c = conv(actor, sessionKey);
      if (displayName) c.displayName = displayName;
      c.lastActivity = Date.now();
    },
    userMessage(actor: string, sessionKey: string, text: string, source = "feishu") {
      const c = conv(actor, sessionKey);
      push(c, { at: Date.now(), role: "user", text: cleanText(text), source });
      c.turns++;
      c.inflight++;
      c.phase = "resuming";
      c.lastActivity = Date.now();
      turnStart.set(actor, Date.now());
      firstByte.delete(actor);
      pendingText.set(actor, "");
      event(actor, "turn", `message from ${c.displayName ?? c.peer} (${source})`);
    },
    assistantDelta(actor: string, text: string) {
      const c = conv(actor);
      if (!firstByte.has(actor)) {
        const fb = Date.now() - (turnStart.get(actor) ?? Date.now());
        firstByte.set(actor, fb);
        c.lastFirstByteMs = fb;
        c.phase = "streaming";
        event(actor, "first-byte", `actor answered after ${(fb / 1000).toFixed(1)}s`);
      }
      pendingText.set(actor, (pendingText.get(actor) ?? "") + text);
      c.lastActivity = Date.now();
    },
    turnDone(actor: string, status: string, error?: string) {
      const c = conv(actor);
      const start = turnStart.get(actor) ?? Date.now();
      const text = pendingText.get(actor) ?? "";
      push(c, {
        at: Date.now(),
        role: error ? "system" : "assistant",
        text: error ? `⚠️ ${error}` : text,
        latencyMs: Date.now() - start,
        firstByteMs: firstByte.get(actor),
        status,
      });
      pendingText.delete(actor);
      c.inflight = Math.max(0, c.inflight - 1);
      c.phase = c.inflight > 0 ? "streaming" : "idle";
      c.lastActivity = Date.now();
      event(actor, "turn-done", `${status} in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    },
    suspendStart(actor: string) {
      const c = conv(actor);
      c.phase = "suspending";
      c.lastSuspendAt = Date.now();
      event(actor, "suspend", `idle ${opts.idleTimeoutSeconds}s, suspending`);
    },
    suspendDone(actor: string, ok: boolean, detail?: string) {
      const c = conv(actor);
      c.lastSuspendMs = Date.now() - (c.lastSuspendAt ?? Date.now());
      c.phase = ok ? "suspended" : "idle";
      event(actor, ok ? "suspended" : "suspend-failed", detail ?? "");
    },
    snapshot() {
      return {
        now: Date.now(),
        idleTimeoutSeconds: opts.idleTimeoutSeconds,
        conversations: [...convs.values()],
        events: events.slice(0, 100),
      };
    },
  };
}

export function serveObserver(opts: {
  port: number;
  observer: Observer;
  chat: (user: string, text: string, displayName?: string) => Promise<{ ok: boolean; reply?: string; error?: string }>;
  logger?: { info: (m: string) => void; warn?: (m: string) => void };
}) {
  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url?.startsWith("/substrate/state")) {
        return send(200, opts.observer.snapshot());
      }
      if (req.method === "POST" && req.url?.startsWith("/substrate/chat")) {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        if (!body.user || !body.text) return send(400, { ok: false, error: "user and text required" });
        // Respond as soon as the turn finishes; the UI also polls /state.
        const r = await opts.chat(String(body.user), String(body.text), body.displayName);
        return send(r.ok ? 200 : 502, r);
      }
      if (req.url === "/healthz") return send(200, { ok: true });
      send(404, { error: "not found" });
    } catch (e) {
      send(500, { ok: false, error: (e as Error)?.message ?? String(e) });
    }
  });
  server.listen(opts.port, "0.0.0.0", () =>
    opts.logger?.info(`substrate: demo observer listening on :${opts.port}`),
  );
  server.unref?.();
  return server;
}
