// OpenClaw × Agent Substrate demo dashboard.
//
//   /       界面一：OpenClaw 全局管理控制台 (fleet, workers, storage, snapshots, timeline)
//   /chat   界面二：终端用户飞书对话通道 (per-user conversation + actor lifecycle)
//
// Data sources (all in-cluster):
//   - ate-api-server via kubectl-ate (--endpoint + projected SA token)
//   - the gateway's substrate observer (http://openclaw-gateway.openclaw:18790)
import http from "node:http";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createWorkerAutoscaler } from "./autoscaler.mjs";

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);
const ATESPACE = process.env.ATESPACE || "openclaw-demo";
const TEMPLATE = process.env.TEMPLATE || "openclaw-agent";
// Churn actors are synthetic load: keep them on the local-storage template so a run
// does not provision a Filestore share per churn actor.
const CHURN_TEMPLATE = process.env.CHURN_TEMPLATE || "openclaw-agent-warm";
const KUBECTL_ATE = process.env.KUBECTL_ATE || "kubectl-ate";
const ATE_ENDPOINT = process.env.ATE_ENDPOINT || "api.ate-system.svc:443";
const ATE_TOKEN_FILE = process.env.ATE_TOKEN_FILE || "/var/run/ate/token";
const OBSERVER_URL = process.env.OBSERVER_URL || "http://openclaw-gateway.openclaw.svc:18790";
const ate = (args, timeout = 30000) =>
  pexec(KUBECTL_ATE, ["--endpoint", ATE_ENDPOINT, "--token-file", ATE_TOKEN_FILE, "--preview", ...args], {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });

const autoscaler = createWorkerAutoscaler({
  enabled: process.env.AUTOSCALE !== "false",
  namespace: process.env.WORKER_NAMESPACE,
  pool: process.env.WORKER_POOL,
  min: process.env.AUTOSCALE_MIN,
  max: process.env.AUTOSCALE_MAX,
  spare: process.env.AUTOSCALE_SPARE,
  scaleDownCooldownMs: process.env.AUTOSCALE_COOLDOWN_MS,
  buffer: process.env.CAPACITY_BUFFER,
  activeBuffer: process.env.ACTIVE_CAPACITY_BUFFER,
  warmup: process.env.WARMUP !== "false",
  ate: (args, timeout) => ate(args, timeout),
  atespace: ATESPACE,
  template: TEMPLATE,
});

const state = {
  timings: {}, // actor -> [{at, op:"restore"|"checkpoint", kind, phases:{name:sec}, total}]
  actors: [],
  workers: [],
  observer: { conversations: [], events: [], idleTimeoutSeconds: 0 },
  timeline: [],
  stats: { resumes: 0, suspends: 0, resumeMs: [], since: Date.now() },
  errors: {},
  lastSync: 0,
};
const prev = {};
const resumingSince = {};

function addTimeline(actor, kind, detail) {
  state.timeline.unshift({ at: Date.now(), actor, kind, detail });
  if (state.timeline.length > 600) state.timeline.pop();
}

function parseJSON(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function shapeActor(a) {
  const st = a.status || {};
  const wa = st.workerAssignment || {};
  const snaps = (st.snapshots || []).map((s) => ({
    generation: Number(s.generation || 0),
    fidelity: String(s.fidelity || "").replace("SNAPSHOT_FIDELITY_", ""),
    locality: s.locality || "",
    durable: String(s.durableSnapshot?.state || "").replace("SNAPSHOT_STORAGE_STATE_", ""),
    uri: s.durableSnapshot?.object?.snapshotUri || "",
    owner: String(s.owner || "").replace("SNAPSHOT_OWNER_", ""),
  }));
  snaps.sort((x, y) => y.generation - x.generation);
  const status = String(st.state || "UNKNOWN").replace("ACTOR_STATE_", "");
  const vols = (st.externalVolumes?.volumes || []).map((v) => ({
    name: v.name,
    id: v.storageVolumeId || "",
    type: v.volumeType || "",
    provisioned: Boolean(v.storageVolumeId),
  }));
  const attached = ["RUNNING", "RESUMING", "SUSPENDING"].includes(status) && vols.some((v) => v.provisioned);
  return {
    name: a.metadata?.name,
    uid: a.metadata?.uid,
    created: a.metadata?.createTime,
    status,
    worker: wa.worker?.name || "",
    workerPod: wa.workerPod || "",
    workerIp: (wa.workerPodIps || [])[0] || "",
    node: wa.nodeName || st.assignedNode || "",
    volumes: vols,
    attached,
    snapshot: snaps[0] || null,
    snapshotCount: snaps.length,
    generation: Number(st.lastAssignedGeneration || 0),
    crash: st.crash?.message || "",
  };
}

async function sync() {
  const [actorsR, workersR, obsR] = await Promise.allSettled([
    ate(["get", "actors", "-a", ATESPACE, "-o", "json"]),
    ate(["get", "workers", "-o", "json"]),
    fetch(`${OBSERVER_URL}/substrate/state`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json()),
  ]);
  if (actorsR.status === "fulfilled") {
    const j = parseJSON(actorsR.value.stdout, {});
    state.actors = (j.actors || (Array.isArray(j) ? j : [])).map(shapeActor);
    delete state.errors.actors;
  } else state.errors.actors = String(actorsR.reason?.stderr || actorsR.reason?.message || actorsR.reason).slice(0, 400);
  if (workersR.status === "fulfilled") {
    const j = parseJSON(workersR.value.stdout, {});
    state.workers = (j.workers || (Array.isArray(j) ? j : [])).map((w) => ({
      name: w.metadata?.name,
      pod: w.workerPod || w.metadata?.name,
      pool: w.workerPool || "",
      node: w.nodeName || "",
      state: String(w.status?.state || "").replace("WORKER_STATE_", ""),
    }));
    delete state.errors.workers;
  } else state.errors.workers = String(workersR.reason?.stderr || workersR.reason?.message || workersR.reason).slice(0, 400);
  if (obsR.status === "fulfilled") {
    state.observer = obsR.value;
    delete state.errors.observer;
  } else state.errors.observer = String(obsR.reason?.message || obsR.reason).slice(0, 200);

  // Map workers -> actor currently on them.
  for (const w of state.workers) {
    const a = state.actors.find((x) => x.worker === w.name && ["RUNNING", "RESUMING", "SUSPENDING"].includes(x.status));
    w.actor = a?.name || "";
    w.actorStatus = a?.status || "";
  }
  // Lifecycle transitions -> timeline + stats.
  for (const a of state.actors) {
    const p = prev[a.name];
    if (p && p !== a.status) {
      if (a.status === "RESUMING") {
        resumingSince[a.name] = Date.now();
        addTimeline(a.name, "resume", `正在恢复：挂载 Filestore 卷 + 恢复快照 Gen#${a.snapshot?.generation ?? 0}`);
      } else if (a.status === "RUNNING") {
        state.stats.resumes++;
        addTimeline(a.name, "active", `已在 ${a.workerPod || a.worker} 运行（节点 ${a.node}）`);
      } else if (a.status === "SUSPENDING") {
        addTimeline(a.name, "suspending", "空闲超时，正在 checkpoint 并卸载存储卷");
      } else if (a.status === "SUSPENDED") {
        state.stats.suspends++;
        addTimeline(a.name, "suspend", `快照 Gen#${a.snapshot?.generation ?? "?"} 已保存，存储卷已 Detach，Worker 已释放`);
      } else if (a.status === "CRASHED") {
        addTimeline(a.name, "crash", a.crash || "actor crashed");
      }
    } else if (!p) {
      addTimeline(a.name, "create", `Actor 已创建（${a.status}）`);
    }
    prev[a.name] = a.status;
  }
  state.lastSync = Date.now();
  await autoscaler.tick({
    actors: state.actors,
    workers: state.workers,
    conversations: state.observer?.conversations || [],
    // Churn actors queued for a worker count as waiting demand, so churn scales the pool.
    extraWaiting: churn.running
      ? state.actors.filter((a) => a.name.startsWith("churn-") && !["RUNNING", "RESUMING", "SUSPENDING"].includes(a.status)).length
      : 0,
  });
  state.autoscaler = autoscaler.state();
}

// ---- atelet timing breakdowns (per actor, per restore/checkpoint) ----
const K8S_SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const K8S_API = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;
async function k8sText(p) {
  const token = readFileSync(`${K8S_SA}/token`, "utf8").trim();
  const r = await fetch(K8S_API + p, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`k8s ${p}: HTTP ${r.status}`);
  return r.text();
}
const seenTimings = new Set();
async function syncTimings() {
  const pods = JSON.parse(await k8sText("/api/v1/namespaces/ate-system/pods")).items
    .filter((p) => p.metadata.name.startsWith("atelet") && p.status?.phase === "Running");
  for (const p of pods) {
    const txt = await k8sText(`/api/v1/namespaces/ate-system/pods/${p.metadata.name}/log?container=atelet&sinceSeconds=900`).catch(() => "");
    for (const line of txt.split("\n")) {
      if (!line.includes("timing breakdown")) continue;
      const j = parseJSON(line, null);
      if (!j || !/timing breakdown/.test(j.msg || "")) continue;
      const actor = j["ate.actor.name"];
      if (!actor) continue;
      const key = `${actor}|${j.time}|${j.msg}`;
      if (seenTimings.has(key)) continue;
      seenTimings.add(key);
      const op = j.msg.startsWith("Restore") ? "restore" : "checkpoint";
      const prefix = `ate.actor.${op}.duration.`;
      const phases = {};
      for (const [k, v] of Object.entries(j)) if (k.startsWith(prefix) && k !== prefix + "total") phases[k.slice(prefix.length)] = Number(v);
      const list = (state.timings[actor] ||= []);
      list.push({ at: Date.parse(j.time), op, kind: j["ate.snapshot.kind"] || "", node: p.spec?.nodeName || "", phases, total: Number(j[prefix + "total"] || 0) });
      list.sort((a, b) => a.at - b.at);
      if (list.length > 40) list.splice(0, list.length - 40);
    }
  }
  delete state.errors.timings;
}
async function timingsLoop() {
  try { await syncTimings(); } catch (e) { state.errors.timings = String(e?.message || e); }
  setTimeout(timingsLoop, 5000);
}
timingsLoop();

async function loop() {
  try {
    await sync();
  } catch (e) {
    state.errors.sync = String(e?.message || e);
  }
  setTimeout(loop, 1500);
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return parseJSON(raw || "{}", {});
}

const safeName = (s) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(s || "");

async function action(kind, body) {
  const name = body.name;
  switch (kind) {
    case "resume":
      if (!safeName(name)) throw new Error("bad name");
      return ate(["resume", "actor", name, "-a", ATESPACE], 120000);
    case "suspend":
      if (!safeName(name)) throw new Error("bad name");
      return ate(["suspend", "actor", name, "-a", ATESPACE], 120000);
    case "delete":
      if (!safeName(name)) throw new Error("bad name");
      return ate(["delete", "actor", name, "-a", ATESPACE], 120000);
    case "logs":
      if (!safeName(name)) throw new Error("bad name");
      return ate(["logs", "actor", name, "-a", ATESPACE], 30000).then((r) => ({
        stdout: r.stdout.split("\n").slice(-300).join("\n"),
      }));
    case "suspend-all": {
      const running = state.actors.filter((a) => a.status === "RUNNING");
      await Promise.allSettled(running.map((a) => ate(["suspend", "actor", a.name, "-a", ATESPACE], 120000)));
      return { stdout: `suspended ${running.length}` };
    }
    default:
      throw new Error("unknown action");
  }
}


// ---- Churn: N synthetic actors cycling wake -> hold -> park on the worker pool ----
// Same idea as the always-on-agent demo's "Churn 10 agents": every actor runs its
// own jittered loop (resume, hold the worker briefly, suspend, pause, again), so
// the pool stays full while the occupants keep changing. Resumes that find no free
// worker are refused and retried. Queued churn actors count as waiting demand for
// the autoscaler, so a churn run also exercises scale-up (and the standby buffer).
const churn = { running: false, stop: false, until: 0, count: 0, seconds: 0, cycles: 0, refused: 0, failed: 0, startedAt: 0, lastError: "", log: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function churnLog(msg) { churn.log.unshift({ at: Date.now(), msg }); if (churn.log.length > 30) churn.log.pop(); }
async function churnActor(name, hold) {
  await sleep(Math.random() * hold * 2);
  while (!churn.stop && Date.now() < churn.until) {
    try {
      await ate(["resume", "actor", name, "-a", ATESPACE], 60000);
    } catch (e) {
      const msg = String(e?.stderr || e?.message || e);
      if (/no worker|room|capacity|Unavailable|ResourceExhausted/i.test(msg)) churn.refused++;
      else { churn.failed++; churn.lastError = msg.split("\n").find((l) => /rror/.test(l)) || msg.slice(0, 160); }
      await sleep(300 + Math.random() * 700);
      continue;
    }
    await sleep(hold);
    await ate(["suspend", "actor", name, "-a", ATESPACE], 60000).catch(() => {});
    churn.cycles++;
    await sleep(200 + Math.random() * 500);
  }
}
async function deleteChurnActors(names) {
  for (let pass = 0; pass < 2; pass++) {
    const left = [];
    for (const n of names) {
      try { await ate(["delete", "actor", n, "-a", ATESPACE], 120000); }
      catch (e) { if (!/not found|NotFound/i.test(String(e?.stderr || e?.message))) left.push(n); }
    }
    if (!left.length) return;
    names = left;
    await sleep(5000);
  }
  churnLog(`有 ${names.length} 个 Churn Actor 删除失败：${names.join(", ")}`);
}
// Clean up churn actors left behind by an earlier run (e.g. the dashboard restarted mid-run).
async function cleanupStaleChurn() {
  try {
    const out = await ate(["get", "actors", "-a", ATESPACE, "-o", "json"], 30000);
    const j = parseJSON(out.stdout, {});
    const list = (j.actors || j.items || (Array.isArray(j) ? j : [])).map((a) => a?.metadata?.name).filter((n) => /^churn-\d+$/.test(n || ""));
    if (list.length && !churn.running) { churnLog(`清理上次遗留的 ${list.length} 个 Churn Actor`); await deleteChurnActors(list); }
  } catch {}
}
setTimeout(cleanupStaleChurn, 15000);
async function startChurn({ count = 10, seconds = 45, hold = 1500 } = {}) {
  if (churn.running) throw new Error("churn already running");
  count = Math.min(20, Math.max(2, Number(count) || 10));
  seconds = Math.min(300, Math.max(10, Number(seconds) || 45));
  hold = Math.min(10000, Math.max(300, Number(hold) || 1500));
  const names = [];
  for (let i = 1; i <= count; i++) {
    const name = `churn-${i}`;
    try { await ate(["create", "actor", name, "-a", ATESPACE, "--template", CHURN_TEMPLATE], 30000); }
    catch (e) { if (!/already exists/i.test(String(e?.stderr || e?.message))) { churnLog(`${name} 创建失败：${String(e?.stderr || e).slice(0, 120)}`); continue; } }
    names.push(name);
  }
  if (!names.length) throw new Error("no churn actors could be created");
  Object.assign(churn, { running: true, stop: false, until: Date.now() + seconds * 1000, count: names.length, seconds, cycles: 0, refused: 0, failed: 0, startedAt: Date.now(), lastError: "" });
  churnLog(`开始：${names.length} 个 Actor 在 ${state.workers.length} 个 Worker 上轮转 ${seconds}s（每次占用 ${hold}ms）`);
  addTimeline("churn", "manual", `Churn 开始：${names.length} 个 Actor / ${state.workers.length} 个 Worker / ${seconds}s`);
  let lastC = 0, lastR = 0;
  const ticker = setInterval(() => {
    const c = churn.cycles - lastC, r = churn.refused - lastR; lastC = churn.cycles; lastR = churn.refused;
    churnLog(`Worker 池${r ? "已满" : "运转中"}：10s 内完成 ${c} 次 唤醒→占用→挂起，${r} 次唤醒因无空闲 Worker 被拒绝并重试`);
  }, 10000);
  Promise.all(names.map((n) => churnActor(n, hold))).finally(async () => {
    clearInterval(ticker);
    // Churn actors are throwaway load: delete them when the run ends, rather than
    // leaving ten suspended (or, after a node scale-down, crashed) actors in the
    // fleet. DeleteActor also tears down one that is still running.
    await deleteChurnActors(names);
    churnLog(`结束：共 ${churn.cycles} 次 唤醒→占用→挂起，${churn.refused} 次拒绝重试${churn.failed ? `，${churn.failed} 次其他错误` : ""}；Churn Actor 已全部删除`);
    addTimeline("churn", "manual", `Churn 结束：${churn.cycles} 个周期，Churn Actor 已删除`);
    churn.running = false;
  });
  return { count: names.length, seconds, hold };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(HERE, "console.html")));
    }
    if (url.pathname === "/lifecycle") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(HERE, "lifecycle.html")));
    }
    if (url.pathname === "/chat") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(HERE, "chat.html")));
    }
    if (url.pathname === "/api/state") {
      return json(200, { ...state, atespace: ATESPACE, template: TEMPLATE, now: Date.now(),
        churn: { ...churn, secsLeft: churn.running ? Math.max(0, Math.round((churn.until - Date.now()) / 1000)) : 0 } });
    }
    if (url.pathname.startsWith("/api/actor/") && req.method === "POST") {
      const kind = url.pathname.split("/").pop();
      const body = await readBody(req);
      const r = await action(kind, body);
      if (kind !== "logs") addTimeline(body.name || "*", "manual", `控制台手动操作：${kind}`);
      return json(200, { ok: true, out: r.stdout });
    }
    if (url.pathname === "/api/autoscaler/config" && req.method === "POST") {
      try { return json(200, { ok: true, ...(await autoscaler.setConfig(await readBody(req))) }); }
      catch (e) { return json(500, { ok: false, error: String(e?.message || e) }); }
    }
    if (url.pathname === "/api/buffer" && req.method === "POST") {
      const b = await readBody(req);
      try { return json(200, { ok: true, ...(await autoscaler.setBuffer(b.kind, b.replicas)) }); }
      catch (e) { return json(500, { ok: false, error: String(e?.message || e) }); }
    }
    if (url.pathname === "/api/churn" && req.method === "POST") {
      try { return json(200, { ok: true, ...(await startChurn(await readBody(req))) }); }
      catch (e) { return json(409, { ok: false, error: String(e?.message || e) }); }
    }
    if (url.pathname === "/api/churn/stop" && req.method === "POST") {
      churn.stop = true;
      return json(200, { ok: true, wasRunning: churn.running, cycles: churn.cycles });
    }
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readBody(req);
      const r = await fetch(`${OBSERVER_URL}/substrate/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300000),
      });
      return json(r.status, await r.json());
    }
    if (url.pathname === "/healthz") return json(200, { ok: true });
    json(404, { error: "not found" });
  } catch (e) {
    json(500, { ok: false, error: String(e?.stderr || e?.message || e).slice(0, 1000) });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`dashboard on :${PORT}`));
loop();
