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
const KUBECTL_ATE = process.env.KUBECTL_ATE || "kubectl-ate";
const ATE_ENDPOINT = process.env.ATE_ENDPOINT || "api.ate-system.svc:443";
const ATE_TOKEN_FILE = process.env.ATE_TOKEN_FILE || "/var/run/ate/token";
const OBSERVER_URL = process.env.OBSERVER_URL || "http://openclaw-gateway.openclaw.svc:18790";
const ate = (args, timeout = 30000) =>
  pexec(KUBECTL_ATE, ["--endpoint", ATE_ENDPOINT, "--token-file", ATE_TOKEN_FILE, ...args], {
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
  warmup: process.env.WARMUP !== "false",
  ate: (args, timeout) => ate(args, timeout),
  atespace: ATESPACE,
  template: TEMPLATE,
});

const state = {
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
  if (state.timeline.length > 150) state.timeline.pop();
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
  });
  state.autoscaler = autoscaler.state();
}

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
    if (url.pathname === "/chat") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(readFileSync(path.join(HERE, "chat.html")));
    }
    if (url.pathname === "/api/state") {
      return json(200, { ...state, atespace: ATESPACE, template: TEMPLATE, now: Date.now() });
    }
    if (url.pathname.startsWith("/api/actor/") && req.method === "POST") {
      const kind = url.pathname.split("/").pop();
      const body = await readBody(req);
      const r = await action(kind, body);
      if (kind !== "logs") addTimeline(body.name || "*", "manual", `控制台手动操作：${kind}`);
      return json(200, { ok: true, out: r.stdout });
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
