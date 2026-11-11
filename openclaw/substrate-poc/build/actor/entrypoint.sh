#!/bin/sh
# Seed the persona into the (Filestore-backed) workspace volume, then run the
# OpenClaw agent server on port 80 for atenet.
WS=/home/node/.openclaw/workspace
mkdir -p "$WS" 2>/dev/null || true
for f in /opt/persona/*.md; do
  [ -e "$WS/$(basename "$f")" ] || cp "$f" "$WS/" 2>/dev/null || true
done
# Record which actor/boot wrote here, so the demo can show the volume persists
# across suspend/resume and worker moves.
{
  printf '%s boot actor=%s host=%s\n' "$(date -u +%FT%TZ)" "$(cat /run/ate/actor-id 2>/dev/null || echo golden)" "$(hostname)"
} >> "$WS/.substrate-boot.log" 2>/dev/null || true
exec node /app/openclaw.mjs gateway --allow-unconfigured --bind lan --port 80 "$@"
