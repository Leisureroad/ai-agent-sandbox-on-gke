#!/usr/bin/env bash
# Render and apply the OpenClaw-on-Substrate demo (after Substrate + Filestore CSI
# are installed). Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
S="$(cd "$HERE/../.." && pwd)"
# Environment (PROJECT_ID, GCE_REGION, ...). Override with ENV_FILE=/path/to/env.sh.
source "${ENV_FILE:-$S/substrate-gke/.ate-dev-env.sh}"
: "${PROJECT_ID:?PROJECT_ID must be set (see .ate-dev-env.sh)}"
export GCE_REGION="${GCE_REGION:-us-central1}"
export ARTIFACT_REGISTRY_REPOSITORY="${ARTIFACT_REGISTRY_REPOSITORY:-ate-images}"
export NODE_GSA_NAME="${NODE_GSA_NAME:-ate-gke-node}"
export NODE_SA="${NODE_SA:-${NODE_GSA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com}"

REPO="${GCE_REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REGISTRY_REPOSITORY}"
digest() { gcloud artifacts docker images describe "$1" --format='value(image_summary.digest)' 2>/dev/null; }
export GATEWAY_IMAGE="${REPO}/openclaw-gateway@$(digest ${REPO}/openclaw-gateway:demo)"
export ACTOR_IMAGE="${REPO}/openclaw-actor@$(digest ${REPO}/openclaw-actor:demo)"
export DASHBOARD_IMAGE="${REPO}/openclaw-dashboard@$(digest ${REPO}/openclaw-dashboard:demo)"
export WORKER_IMAGE="${WORKER_IMAGE:-ghcr.io/agent-substrate/substrate/ateworker-gvisor:v1.0.0}"
export ENVOY_IMAGE="${ENVOY_IMAGE:-envoyproxy/envoy:v1.34-latest}"
export IDLE_TIMEOUT_SECONDS="${IDLE_TIMEOUT_SECONDS:-30}"
export GEMINI_API_KEY="$(cat "$S/secrets/gemini.key")"
export GATEWAY_TOKEN="$(cat "$S/secrets/gateway.token")"
export FEISHU_ENABLED="${FEISHU_ENABLED:-false}"
export FEISHU_DOMAIN="${FEISHU_DOMAIN:-feishu}"
# STORAGE=filestore (Filestore VolumePool external volume) or local (durableDir,
# snapshotted with the actor). Template names differ because templates are immutable.
export STORAGE="${STORAGE:-filestore}"
if [ "$STORAGE" = filestore ]; then
  export TEMPLATE_NAME="${TEMPLATE_NAME:-openclaw-agent}"
  export WORKSPACE_VOLUME='# Per-actor Filestore VolumePool share: provisioned on first resume,
# attached/mounted on every resume, unmounted/detached on every suspend.
- name: workspace
  external:
    template:
      capacityBytes: 2147483648
      storageClassName: substrate-volumepool-sc'
else
  export TEMPLATE_NAME="${TEMPLATE_NAME:-openclaw-agent-local}"
  export WORKSPACE_VOLUME='# Fallback: Substrate durable dir, captured in every snapshot.
- name: workspace
  durableDir: {}'
fi
# ACP bindings route Feishu DMs to the per-conversation Substrate actors. An
# explicit open_id binding is the documented form for ACP; the wildcard entry
# covers users not listed yet.
export FEISHU_PEERS="${FEISHU_PEERS:-}"
export FEISHU_BINDINGS="$(python3 - << 'PY'
import json, os
peers = [p.strip() for p in os.environ.get("FEISHU_PEERS", "").split(",") if p.strip()] + ["*"]
print(json.dumps([{"type": "acp", "agentId": "main",
  "match": {"channel": "feishu", "accountId": "default", "peer": {"kind": "direct", "id": p}},
  "acp": {"backend": "substrate"}} for p in peers]))
PY
)"
export DASHBOARD_SOURCE_RANGES="${DASHBOARD_SOURCE_RANGES:-[\"0.0.0.0/0\"]}"
KATE=(kubectl ate)

# Render only the listed variables; leave ${OPENCLAW_GATEWAY_TOKEN},
# ${FEISHU_APP_ID}, ${FEISHU_APP_SECRET} for OpenClaw's own env substitution.
render() {
  python3 - "$1" << 'EOF'
import os, re, sys
keys = ["GATEWAY_IMAGE","ACTOR_IMAGE","DASHBOARD_IMAGE","WORKER_IMAGE","ENVOY_IMAGE","IDLE_TIMEOUT_SECONDS",
        "GEMINI_API_KEY","GATEWAY_TOKEN","TEMPLATE_NAME","WORKSPACE_VOLUME","FEISHU_BINDINGS","FEISHU_ENABLED","FEISHU_DOMAIN","DASHBOARD_SOURCE_RANGES","CONFIG_HASH","NODE_SA"]
s = open(sys.argv[1]).read()
for k in keys:
    s = s.replace("${%s}" % k, os.environ.get(k, ""))
sys.stdout.write(s)
EOF
}

echo "== worker compute class / standby capacity buffer"
render "$HERE/computeclass.yaml.tmpl" | kubectl apply -f -
kubectl create namespace openclaw-workers --dry-run=client -o yaml | kubectl apply -f -
if [ "${CAPACITY_BUFFER_ENABLED:-true}" = true ]; then
  kubectl apply -f "$HERE/capacitybuffer.yaml"
fi

echo "== namespaces / secrets"
render "$HERE/workerpool.yaml.tmpl" | kubectl apply -f -
kubectl create namespace openclaw --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace openclaw ate.dev/api-access=true --overwrite
kubectl -n openclaw create secret generic openclaw-secrets \
  --from-literal=OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" --dry-run=client -o yaml | kubectl apply -f -
if ! kubectl -n openclaw get secret openclaw-feishu >/dev/null 2>&1; then
  kubectl -n openclaw create secret generic openclaw-feishu \
    --from-literal=FEISHU_APP_ID=placeholder --from-literal=FEISHU_APP_SECRET=placeholder
fi

echo "== atespace / access policy / template"
"${KATE[@]}" create atespace openclaw-demo 2>/dev/null || true
cat > /tmp/openclaw-access.yaml << 'EOF'
metadata:
  name: default
bindings:
- role: editor
  members:
  - user:system:serviceaccount:openclaw:openclaw-gateway
  - user:system:serviceaccount:openclaw:openclaw-dashboard
EOF
"${KATE[@]}" get access-policy -a openclaw-demo >/dev/null 2>&1 \
  || "${KATE[@]}" create access-policy -a openclaw-demo -f /tmp/openclaw-access.yaml

if ! "${KATE[@]}" get actor-template "$TEMPLATE_NAME" -a openclaw-demo >/dev/null 2>&1; then
  render "$HERE/actortemplate.yaml.tmpl" > /tmp/openclaw-actortemplate.yaml
  "${KATE[@]}" --preview create actor-template -f /tmp/openclaw-actortemplate.yaml
  rm -f /tmp/openclaw-actortemplate.yaml
fi

echo "== gateway / dashboard"
export CONFIG_HASH="$(render "$HERE/gateway.yaml.tmpl" | sha256sum | cut -c1-12)"
render "$HERE/gateway.yaml.tmpl" | kubectl apply -f -
render "$HERE/dashboard.yaml.tmpl" | kubectl apply -f -
echo "done"
