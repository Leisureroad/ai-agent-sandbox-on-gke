// Demand-driven WorkerPool autoscaler for the demo.
//
// Substrate's WorkerPool exposes the scale subresource, so anything that can
// PATCH .../workerpools/<name>/scale can autoscale it. This loop sizes the pool
// to the number of conversations that need a worker right now, plus a warm
// spare, so the user after the third one finds a worker waiting instead of a
// queue:
//
//   desired = clamp(active + waiting + SPARE, MIN, MAX)
//
//   active  = actors RUNNING / RESUMING / SUSPENDING
//   waiting = conversations with a turn in flight whose actor is not running yet
//
// New worker pods that do not fit the worker node pool trigger the cluster
// autoscaler, which takes a node from the GKE standby CapacityBuffer.
// Scale-down waits out a cooldown and first marks idle worker pods with a low
// pod-deletion-cost so the ReplicaSet removes those and never a busy worker.
import { readFileSync } from "node:fs";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const API = `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT}`;

export function createWorkerAutoscaler(opts) {
  const cfg = {
    namespace: opts.namespace || "openclaw-workers",
    pool: opts.pool || "openclaw",
    min: Number(opts.min ?? 3),
    max: Number(opts.max ?? 9),
    spare: Number(opts.spare ?? 1),
    scaleDownCooldownMs: Number(opts.scaleDownCooldownMs ?? 180000),
    buffer: opts.buffer || "openclaw-worker-standby",
    enabled: opts.enabled !== false,
    warmup: opts.warmup !== false,
    warmupMaxAttempts: 3,
  };
  // Node warm-up: atelet pulls and unpacks the OpenClaw image (and caches the
  // golden snapshot) only when an actor first lands on a node, ~45s. Run a
  // throwaway actor on every new worker node before users need it.
  const ate = opts.ate; // (args, timeoutMs) => Promise<{stdout}>
  const atespace = opts.atespace || "openclaw-demo";
  const template = opts.template || "openclaw-agent-local";
  const warmNodes = new Set();
  const warmAttempts = new Map();
  let warming = null; // { node, actor, startedAt }
  const st = {
    replicas: null,
    readyReplicas: null,
    desired: null,
    active: 0,
    waiting: 0,
    lastScaleUp: 0,
    belowSince: 0,
    lastAction: "",
    lastError: "",
    buffer: null,
    nodes: [],
    events: [],
    warmNodes: [],
    warming: null,
  };

  const k8s = async (method, path, body, contentType = "application/merge-patch+json") => {
    const token = readFileSync(`${SA}/token`, "utf8");
    const r = await fetch(API + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": contentType } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  };
  const event = (kind, detail) => {
    st.events.unshift({ at: Date.now(), kind, detail });
    if (st.events.length > 50) st.events.pop();
    st.lastAction = `${kind}: ${detail}`;
  };
  const scalePath = `/apis/ate.dev/v1/namespaces/${cfg.namespace}/workerpools/${cfg.pool}/scale`;

  async function observeCluster() {
    const scale = await k8s("GET", scalePath);
    st.replicas = scale.spec?.replicas ?? null;
    const wp = await k8s("GET", `/apis/ate.dev/v1/namespaces/${cfg.namespace}/workerpools/${cfg.pool}`);
    st.readyReplicas = wp.status?.readyReplicas ?? 0;
    try {
      const b = await k8s("GET", `/apis/autoscaling.x-k8s.io/v1beta1/namespaces/${cfg.namespace}/capacitybuffers/${cfg.buffer}`);
      st.buffer = {
        strategy: b.spec?.provisioningStrategy,
        replicas: b.status?.replicas ?? b.spec?.replicas,
        conditions: (b.status?.conditions || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
      };
    } catch (e) {
      st.buffer = { error: String(e.message || e).slice(0, 200) };
    }
    try {
      const nodes = await k8s("GET", `/api/v1/nodes?labelSelector=${encodeURIComponent("cloud.google.com/compute-class=openclaw-workers")}`);
      st.nodes = (nodes.items || []).map((n) => ({
        name: n.metadata.name,
        ready: (n.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True"),
        created: n.metadata.creationTimestamp,
      }));
    } catch (e) {
      st.nodes = [];
    }
  }

  async function markIdlePodsForRemoval(workers) {
    const idlePods = new Set(workers.filter((w) => !w.actor).map((w) => w.pod));
    const pods = await k8s("GET", `/api/v1/namespaces/${cfg.namespace}/pods`);
    for (const p of pods.items || []) {
      const cost = idlePods.has(p.metadata.name) ? "-100" : "100";
      if (p.metadata.annotations?.["controller.kubernetes.io/pod-deletion-cost"] === cost) continue;
      await k8s("PATCH", `/api/v1/namespaces/${cfg.namespace}/pods/${p.metadata.name}`, {
        metadata: { annotations: { "controller.kubernetes.io/pod-deletion-cost": cost } },
      }).catch(() => {});
    }
  }

  function shortNode(n) {
    return n.replace(/^gke-[a-z0-9-]*?-(nap-|openclaw-)?/, "").slice(-12).replace(/[^a-z0-9-]/g, "");
  }

  async function warmupNode(node) {
    const actor = `warmup-${shortNode(node)}`.replace(/-+$/, "");
    warming = { node, actor, startedAt: Date.now() };
    event("warmup-start", `预热冷节点 ${shortNode(node)}：唤醒 ${actor} 以缓存 OpenClaw 镜像与 Golden 快照`);
    try {
      await ate(["create", "actor", actor, "-a", atespace, "--template", template], 60000).catch((e) => {
        if (!/already exists/i.test(String(e?.stderr || e?.message))) throw e;
      });
      await ate(["resume", "actor", actor, "-a", atespace], 240000);
      const out = await ate(["get", "actor", actor, "-a", atespace, "-o", "json"], 30000);
      const j = JSON.parse(out.stdout || "{}");
      const a = j.actors?.[0] ?? j;
      const landed = a.status?.workerAssignment?.nodeName || a.status?.assignedNode || "";
      const secs = Math.round((Date.now() - warming.startedAt) / 1000);
      if (landed === node) {
        warmNodes.add(node);
        event("warmup-done", `节点 ${shortNode(node)} 已预热（${secs}s），之后在该节点唤醒约 2s`);
      } else {
        warmAttempts.set(node, (warmAttempts.get(node) || 0) + 1);
        if (landed) warmNodes.add(landed);
        event("warmup-retry", `预热沙箱落在 ${shortNode(landed || "?")}，不是目标节点，稍后重试`);
      }
    } catch (e) {
      warmAttempts.set(node, (warmAttempts.get(node) || 0) + 1);
      event("warmup-failed", `${shortNode(node)}: ${String(e?.stderr || e?.message || e).slice(0, 160)}`);
    } finally {
      await ate(["delete", "actor", actor, "-a", atespace], 120000).catch(() => {});
      warming = null;
    }
  }

  async function tick({ actors, workers, conversations, extraWaiting = 0 }) {
    if (!cfg.enabled) return;
    try {
      await observeCluster();
      const activeStates = new Set(["RUNNING", "RESUMING", "SUSPENDING"]);
      // warmup-* actors are node warm-up probes: they never drive scaling. churn-*
      // actors do (they are the load-test), via active + extraWaiting.
      const synthetic = (n) => n.startsWith("warmup-");
      for (const a of actors) if (a.status === "RUNNING" && a.node && !synthetic(a.name)) warmNodes.add(a.node);
      const running = new Set(actors.filter((a) => activeStates.has(a.status) && !synthetic(a.name)).map((a) => a.name));
      st.active = running.size;
      st.waiting = (conversations || []).filter((c) => c.inflight > 0 && c.actor && !running.has(c.actor)).length + Math.max(0, extraWaiting);
      const desired = Math.min(cfg.max, Math.max(cfg.min, st.active + st.waiting + cfg.spare));
      st.desired = desired;
      if (st.replicas == null) return;
      if (desired > st.replicas) {
        await k8s("PATCH", scalePath, { spec: { replicas: desired } });
        event("scale-up", `${st.replicas} → ${desired} workers (active ${st.active}, waiting ${st.waiting}, spare ${cfg.spare})`);
        st.lastScaleUp = Date.now();
        st.belowSince = 0;
      } else if (desired < st.replicas) {
        if (!st.belowSince) st.belowSince = Date.now();
        if (Date.now() - st.belowSince >= cfg.scaleDownCooldownMs && Date.now() - st.lastScaleUp >= cfg.scaleDownCooldownMs) {
          const target = st.replicas - 1; // one at a time
          await markIdlePodsForRemoval(workers);
          await k8s("PATCH", scalePath, { spec: { replicas: target } });
          event("scale-down", `${st.replicas} → ${target} workers (idle for ${Math.round(cfg.scaleDownCooldownMs / 1000)}s)`);
          st.belowSince = Date.now();
        }
      } else {
        st.belowSince = 0;
      }
      if (cfg.warmup && ate && !warming) {
        const readyNodes = st.nodes.filter((n) => n.ready).map((n) => n.name);
        const cold = readyNodes.find(
          (n) =>
            !warmNodes.has(n) &&
            (warmAttempts.get(n) || 0) < cfg.warmupMaxAttempts &&
            workers.some((w) => w.node === n && !w.actor && /ACTIVE/.test(w.state)),
        );
        if (cold) warmupNode(cold); // runs in the background, one at a time
      }
      st.lastError = "";
    } catch (e) {
      st.lastError = String(e.message || e).slice(0, 300);
    }
  }

  return {
    tick,
    state: () => ({
      ...cfg,
      ...st,
      warmNodes: [...warmNodes],
      warming: warming ? { ...warming, elapsedSec: Math.round((Date.now() - warming.startedAt) / 1000) } : null,
    }),
  };
}
