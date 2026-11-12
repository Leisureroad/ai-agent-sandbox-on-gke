#!/bin/sh
# Seed the persona into the workspace volume, start OpenClaw on :80 for atenet,
# then warm it up before signalling readiness.
WS=/home/node/.openclaw/workspace
mkdir -p "$WS" 2>/dev/null || true
for f in /opt/persona/*.md; do
  [ -e "$WS/$(basename "$f")" ] || cp "$f" "$WS/" 2>/dev/null || true
done
{
  printf '%s boot actor=%s host=%s\n' "$(date -u +%FT%TZ)" "$(cat /run/ate/actor-id 2>/dev/null || echo golden)" "$(hostname)"
} >> "$WS/.substrate-boot.log" 2>/dev/null || true

node /app/openclaw.mjs gateway --allow-unconfigured --bind lan --port 80 "$@" &
OC=$!
trap 'kill -TERM $OC 2>/dev/null' TERM INT

# Warm-up. OpenClaw's /readyz turns green long before the agent runtime is
# loaded: plugins, tool schemas and the embedded agent are initialised lazily on
# the first real turn (~30s at 1 vCPU in gVisor). Substrate captures the golden
# snapshot as soon as the wakeupProbe passes, so without this every new user
# pays that init on their first message, and every later snapshot carries it.
# Run one throwaway turn locally first (the golden has no egress, so the model
# call itself fails fast; the init before it is what we want), then open the
# readiness port the ActorTemplate's wakeupProbe watches.
until curl -fsS -m 2 http://127.0.0.1:80/readyz >/dev/null 2>&1; do sleep 1; done
curl -sS -m 180 -o /dev/null http://127.0.0.1:80/v1/chat/completions \
  -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Session-Key: substrate-warmup" \
  -d '{"model":"openclaw","messages":[{"role":"user","content":"ping"}],"stream":false}' || true
node -e 'require("http").createServer((q,s)=>{s.end("warm")}).listen(8079,"0.0.0.0")' &

wait $OC
