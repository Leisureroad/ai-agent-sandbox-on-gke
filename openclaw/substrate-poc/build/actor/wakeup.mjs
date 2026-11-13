// Readiness server for the ActorTemplate wakeupProbe (port 8079).
//
// It answers only after the entrypoint's warm-up turn (see entrypoint.sh), and on
// every probe it seeds the OpenClaw bootstrap files into the workspace if they are
// missing. That matters for an external (Filestore VolumePool) workspace: each
// actor gets a fresh, empty volume mounted at resume, after the golden snapshot
// was taken, so the entrypoint's own seeding never ran against it. OpenClaw would
// then publish the files itself with hard links, which a gVisor-mounted NFS share
// does not support ("Workspace filesystem does not support atomic bootstrap
// publication"). Substrate runs the wakeupProbe after the volume is mounted and
// before any request is routed in, so seeding here always wins the race.
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readdirSync, chmodSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";

const WS = "/home/node/.openclaw/workspace";
const SRC = "/opt/persona";
// Best effort and never fatal: readiness must not depend on the workspace (a
// failed seed only means OpenClaw tries to publish the file itself later).
const reported = new Set();
function seed() {
  try { mkdirSync(WS, { recursive: true }); } catch {}
  for (const f of readdirSync(SRC)) {
    const dst = join(WS, f);
    try {
      if (existsSync(dst)) continue;
      copyFileSync(join(SRC, f), dst);
      try { chmodSync(dst, 0o600); } catch {}
    } catch (e) {
      const k = `${f}:${e?.code}`;
      if (!reported.has(k)) { reported.add(k); console.error(`[wakeup] seeding ${dst} failed: ${e?.message || e}`); }
    }
  }
}
// OpenClaw's own workspace stays on a local (snapshotted) filesystem: OpenClaw 2026.11
// publishes workspace state atomically with hard links, which a gVisor-mounted NFS
// share does not support. The user's Filestore volume is mounted at /home/node/files
// and exposed inside the workspace as files/ (a symlink, kept in the snapshot).
const FILES = "/home/node/files";
function linkFiles() {
  try {
    if (!existsSync(FILES)) return;
    try { lstatSync(join(WS, "files")); return; } catch {}
    symlinkSync(FILES, join(WS, "files"));
  } catch (e) {
    if (!reported.has("files")) { reported.add("files"); console.error(`[wakeup] linking files/ failed: ${e?.message || e}`); }
  }
}
createServer((_req, res) => { seed(); linkFiles(); res.end("warm"); }).listen(8079, "0.0.0.0");
