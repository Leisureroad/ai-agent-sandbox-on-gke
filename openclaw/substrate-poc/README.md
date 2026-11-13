# OpenClaw × Agent Substrate on GKE — POC code

Code for the POC described in [`../substrate-poc-user-guide-zh.md`](../substrate-poc-user-guide-zh.md) (in Chinese): one gVisor sandboxed OpenClaw agent per Feishu user or group, running on GKE with Agent Substrate v1.0. Idle agents are suspended and resume on the next message with their memory and workspace intact. Workers scale with demand, backed by a GKE standby CapacityBuffer.

| Path | What it is |
|---|---|
| `extensions/substrate/` | OpenClaw gateway plugin. It routes each conversation to its own Substrate actor and auto-routes unbound Feishu DMs and groups. Idle actors are suspended synchronously. Deleted actors are re-created, and crashed actors are reverted. |
| `build/` | Dockerfiles for the actor and gateway images, the agent persona, and Cloud Build configs. |
| `dashboard2/` | Fleet console (`/`), end-user chat view (`/chat`), and the demand-based worker autoscaler with node warm-up. |
| `deploy/` | `deploy.sh` plus templates: WorkerPool, ActorTemplate, gateway, dashboard, egress policy, ComputeClass, and CapacityBuffer. |

Nothing project-specific is hard-coded. `deploy.sh` reads `PROJECT_ID`, `GCE_REGION`, `ARTIFACT_REGISTRY_REPOSITORY` and `NODE_GSA_NAME` from the env file (`ENV_FILE`, default `../../substrate-gke/.ate-dev-env.sh`). The Cloud Build configs use the build project's `$PROJECT_ID`, and `_REGION` / `_AR_REPO` can be overridden with substitutions.

Quick start, after following sections 4–8 of the guide. These commands use OpenClaw 2026.8.2 with a Filestore user-files volume:

```bash
cd $WORK/openclaw-demo
V8=ghcr.io/openclaw/openclaw@sha256:5d25165995041caa6a7175bec82b25ad98c44eb269bb42435da8e27ec06e6be4
SUBS="_REGION=${GCE_REGION},_AR_REPO=${ARTIFACT_REGISTRY_REPOSITORY},_OPENCLAW_IMAGE=$V8"
B="gcloud builds submit --project $PROJECT_ID --region $GCE_REGION"
$B --substitutions=$SUBS,_TAG=demo-v8 --config build/cloudbuild-gateway.yaml .
$B --substitutions=$SUBS,_TAG=demo-fs-v8,_RUN_AS_UID=0 --config build/cloudbuild-actor.yaml .
$B --substitutions=$SUBS,_TAG=demo-v8,_RUN_AS_UID=1000 --config build/cloudbuild-actor.yaml .
$B --substitutions=_REGION=${GCE_REGION},_AR_REPO=${ARTIFACT_REGISTRY_REPOSITORY} --config build/cloudbuild-dashboard2.yaml .
cd deploy
OPENCLAW_VERSION=2026.8.2 STORAGE=filestore VOLUMEPOOL_STORAGECLASS=substrate-volumepool-sc FEISHU_ENABLED=true ./deploy.sh
TEMPLATE_ONLY=true OPENCLAW_VERSION=2026.8.2 STORAGE=local ./deploy.sh   # churn template
```

Secrets (Gemini API key, gateway token, Feishu app credentials) are read from `$WORK/secrets/` and from Kubernetes Secrets. Never commit them.
