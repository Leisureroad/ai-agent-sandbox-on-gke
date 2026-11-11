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
 * Agent Substrate plugin entry.
 *
 * Drop-in: place this folder under `extensions/` and enable it via
 * `plugins.entries.substrate.enabled = true` in openclaw.json. It requires
 * NO edits to any existing OpenClaw file: config is declared in
 * openclaw.plugin.json, and startup wiring runs through the plugin service +
 * hook API.
 *
 * Gateway role: registers a "substrate" ACP runtime backend that maps each
 * conversation to its own Substrate actor (create-if-absent from a golden
 * template, then forward turns over HTTP via atenet), wires the generic ACP
 * reply-dispatch hook so channels bound to backend "substrate" are delegated,
 * and suspends each actor once its conversation goes idle.
 *
 * There is deliberately no actor-side role. Substrate projects an actor's
 * identity into the sandbox but no client credential, and ateapi requires mTLS,
 * so an actor cannot call the control plane to suspend itself. See
 * docs/ARCHITECTURE.md.
 */
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
  tryDispatchAcpReplyHook,
} from "openclaw/plugin-sdk/acp-runtime-backend";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createSubstrateAcpRuntime } from "./acp-runtime.js";
import { createActorProvisioner } from "./actor-provisioner.js";
import { ateApiConfigFromEnv } from "./ateapi-client.js";
import { createKubectlAteClient } from "./kubectl-ate-client.js";
import { createIdleSuspender } from "./idle-suspender.js";
import { createObserver, serveObserver } from "./observer.js";
import { actorNameForConversation } from "./actor-router.js";

const BACKEND_ID = "substrate";
const DEFAULT_ATEAPI = "api.ate-system.svc.cluster.local:443";

type SubstrateConfig = {
  role?: "gateway";
  // Gateway role: per-conversation actor placement.
  atespace?: string;
  template?: string; // bare name of the golden ActorTemplate, resolved in atespace
  templateForAgent?: Record<string, string>;
  actorDomain?: string;
  actorToken?: string;
  // Marker prepended to every reply, for channels where the gateway posts as
  // the same account the human types from and nothing else tells them apart.
  replyPrefix?: string;
  // How the gateway provisions actors: "ateapi" (in-band gRPC + podcert mTLS)
  // or "kubectl-ate" (shells out to kubectl-ate; for pods without a podcert).
  provisioner?: "ateapi" | "kubectl-ate";
  kubectlAtePath?: string;
  // Idle window before the gateway suspends a conversation's actor.
  idleTimeoutSeconds?: number;
  // How often the idle sweep runs. The real delay before a suspend is the
  // timeout plus up to one poll interval, so a 5s poll quietly doubles a 5s
  // timeout. Worth turning down when the timeout is short.
  idlePollMs?: number;
  // ateapi control-plane address.
  ateapiAddress?: string;
  // Channels whose unbound direct messages are routed to per-user actors.
  autoRouteChannels?: string[];
};

const plugin = {
  id: "substrate",
  name: "Agent Substrate",
  description:
    "Split OpenClaw across an always-on gateway and a suspendable Substrate actor.",
  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as SubstrateConfig;

    // --- Gateway role: one actor per conversation, created on demand ---
    if (cfg.role === "gateway" && cfg.atespace && cfg.template) {
      const ateapiAddress = cfg.ateapiAddress ?? DEFAULT_ATEAPI;
      const client =
        cfg.provisioner === "kubectl-ate"
          ? createKubectlAteClient({ binPath: cfg.kubectlAtePath, endpoint: ateapiAddress })
          : ateApiConfigFromEnv(ateapiAddress);
      const provisioner = createActorProvisioner({
        atespace: cfg.atespace,
        ateapi: client,
      });
      // The sandboxed actor has no ateapi credentials, so the gateway drives
      // idle-suspend from here using the same credentialed kubectl-ate client.
      const idleTimeoutSeconds = cfg.idleTimeoutSeconds ?? 120;
      const observer = createObserver({ idleTimeoutSeconds });
      const suspender = createIdleSuspender({
        atespace: cfg.atespace,
        client,
        idleTimeoutSeconds,
        pollMs: cfg.idlePollMs,
        onSuspendStart: (n) => observer.suspendStart(n),
        onSuspendDone: (n, ok, d) => observer.suspendDone(n, ok, d),
      });
      const runtime = createSubstrateAcpRuntime({
        atespace: cfg.atespace,
        template: cfg.template,
        templateForAgent: cfg.templateForAgent,
        actorDomain: cfg.actorDomain,
        actorToken: cfg.actorToken,
        replyPrefix: cfg.replyPrefix,
        provisioner,
        onActivity: (name) => suspender.touch(name),
        onTurnStart: (name) => suspender.begin(name),
        onTurnEnd: (name) => suspender.end(name),
        observer,
      });
      // Web-simulated end users drive the same runtime as Feishu traffic.
      const chat = async (user: string, text: string, displayName?: string) => {
        const sessionKey = `web:direct:${user.replace(/[^A-Za-z0-9_-]/g, "_")}`;
        const handle = await runtime.ensureSession({ sessionKey, agent: "main", mode: "persistent" } as never);
        observer.session(actorNameForConversation(sessionKey), sessionKey, displayName);
        const turn = runtime.startTurn!({ handle, text, requestId: `web-${Date.now()}`, mode: "prompt" } as never);
        let reply = "";
        let error: string | undefined;
        for await (const ev of turn.events) {
          const e = ev as { type: string; text?: string; message?: string };
          if (e.type === "text_delta" && e.text) reply += e.text;
          if (e.type === "error") error = e.message;
        }
        await turn.result.catch(() => undefined);
        return error ? { ok: false, error, reply } : { ok: true, reply };
      };
      api.registerService({
        id: "substrate-gateway-backend",
        start(ctx) {
          registerAcpRuntimeBackend({ id: BACKEND_ID, runtime });
          suspender.start(ctx.logger);
          serveObserver({
            port: Number(process.env.SUBSTRATE_OBSERVER_PORT || 18790),
            observer,
            chat,
            logger: ctx.logger,
          });
          ctx.logger.info(
            `substrate: per-conversation ACP backend on atespace "${cfg.atespace}" (template ${cfg.template})`,
          );
        },
        stop() {
          unregisterAcpRuntimeBackend(BACKEND_ID);
          suspender.stop();
        },
      });
      // Route turns whose binding resolves to an ACP backend (e.g. "substrate").
      // Demo addition: a direct message on an auto-routed channel that no ACP
      // binding claims (a new Feishu user) gets its own Substrate actor too, so
      // users need no per-open_id binding. ACP bindings only match exact peers.
      const autoChannels = (cfg.autoRouteChannels ?? ["feishu"]).map((c) => c.toLowerCase());
      api.on("reply_dispatch", async (event: any, ctx: any) => {
        const handled = await tryDispatchAcpReplyHook(event, ctx);
        if (handled) return handled;
        const c = (event?.ctx ?? {}) as Record<string, unknown>;
        const channel = String(c.OriginatingChannel ?? c.Provider ?? c.Surface ?? "").toLowerCase();
        const key = String(event?.sessionKey ?? "");
        const chatType = String(c.ChatType ?? "").toLowerCase();
        const isDirect = chatType === "direct" || key.includes(":direct:");
        const isGroup = chatType === "group" || chatType === "channel" || key.includes(":group:");
        if (!autoChannels.includes(channel) || (!isDirect && !isGroup)) return;
        const text = String(c.agentText ?? c.BodyForAgent ?? c.RawBody ?? c.CommandBody ?? c.Body ?? "").trim();
        if (!text) return;
        // One actor per DM sender, and one shared actor per group chat.
        const sessionKey = isDirect
          ? `auto:${channel}:direct:${String(c.SenderId ?? key)}`
          : `auto:${channel}:group:${key.split(":group:")[1] ?? String(c.From ?? key)}`;
        let reply = "";
        let error: string | undefined;
        try {
          const handle = await runtime.ensureSession({ sessionKey, agent: "main", mode: "persistent" } as never);
          observer.session(
            actorNameForConversation(sessionKey),
            sessionKey,
            isGroup ? `群聊 ${String(c.GroupSubject ?? c.ConversationLabel ?? "").trim() || (key.split(":group:")[1] ?? "")}` : c.SenderName ? String(c.SenderName) : undefined,
          );
          const turn = runtime.startTurn!({ handle, text, requestId: `auto-${Date.now()}`, mode: "prompt" } as never);
          for await (const ev of turn.events) {
            const e = ev as { type: string; text?: string; message?: string };
            if (e.type === "text_delta" && e.text) reply += e.text;
            if (e.type === "error") error = e.message;
          }
          await turn.result.catch(() => undefined);
        } catch (e) {
          error = (e as Error)?.message ?? String(e);
        }
        const out = reply.trim() || `⚠️ ${error ?? "no reply from the agent"}`;
        const queuedFinal = ctx.dispatcher?.sendFinalReply?.({ text: out }) ?? false;
        await ctx.dispatcher?.waitForIdle?.().catch?.(() => undefined);
        return { handled: true, queuedFinal: Boolean(queuedFinal), counts: ctx.dispatcher?.getQueuedCounts?.() };
      });
    }
  },
};

export default plugin;