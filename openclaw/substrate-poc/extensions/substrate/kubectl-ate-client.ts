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
 * kubectl-ate–backed implementation of the AteApiClient interface.
 *
 * Demo changes vs upstream always-on-agent:
 *  - authenticates with the gateway pod's projected ServiceAccount token
 *    (--token-file), which Substrate v1.0 maps to the principal
 *    system:serviceaccount:<ns>:<sa>; that principal is an editor of the
 *    atespace through its access policy.
 *  - after creating an actor, creates its egress policy from
 *    EGRESS_POLICY_FILE: Substrate v1.0 denies all egress (even DNS) for an
 *    actor without one, so the agent could not reach its LLM otherwise.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import type { ActorRef, AteApiClient } from "./ateapi-client.js";

const pexec = promisify(execFile);

export function createKubectlAteClient(cfg: { binPath?: string; endpoint?: string } = {}): AteApiClient {
  const bin = cfg.binPath || process.env.KUBECTL_ATE || "kubectl-ate";
  const endpoint = process.env.ATE_ENDPOINT || cfg.endpoint || "";
  const tokenFile = process.env.ATE_TOKEN_FILE || "";
  const egressFile = process.env.EGRESS_POLICY_FILE || "";
  const globalArgs = [
    ...(endpoint ? ["--endpoint", endpoint] : []),
    ...(tokenFile ? ["--token-file", tokenFile] : []),
  ];

  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await pexec(bin, [...globalArgs, ...args], { timeout: 120_000 });
    return stdout;
  };
  const errText = (err: unknown): string =>
    String((err as { stderr?: string })?.stderr ?? (err as Error)?.message ?? err);

  const ensureEgress = async (ref: ActorRef) => {
    if (!egressFile || !existsSync(egressFile)) return;
    try {
      await run(["create", "egress-policy", ref.name, "-a", ref.atespace, "-f", egressFile]);
    } catch (err) {
      if (/already exists/i.test(errText(err))) return;
      throw err;
    }
  };

  return {
    async createActor(ref: ActorRef, _templateNamespace: string, templateName: string) {
      try {
        await run(["create", "actor", ref.name, "-a", ref.atespace, "--template", templateName]);
      } catch (err) {
        if (!/already exists/i.test(errText(err))) throw err;
      }
      await ensureEgress(ref);
    },
    async suspendActor(ref: ActorRef) {
      // --mode=sync: return only once the snapshot is COMPLETED in object
      // storage. The default async suspend keeps the snapshot on the node and
      // uploads it later; if the node is scaled down first, the snapshot is lost
      // and the actor crashes on its next resume.
      await run(["suspend", "actor", ref.name, "-a", ref.atespace, "--mode=sync"]);
    },
    async revertActor(ref: ActorRef) {
      // Only revert a CRASHED actor: reverting a RUNNING one would discard its
      // live state, and a 503 can have other causes.
      const out = await run(["get", "actor", ref.name, "-a", ref.atespace, "-o", "json"]);
      const state = (JSON.parse(out) as { status?: { state?: string } })?.status?.state;
      if (state !== "ACTOR_STATE_CRASHED") return false;
      await run(["revert", "actor", ref.name, "-a", ref.atespace]);
      return true;
    },
    async deleteActor(ref: ActorRef) {
      await run(["delete", "actor", ref.name, "-a", ref.atespace]);
    },
  };
}
