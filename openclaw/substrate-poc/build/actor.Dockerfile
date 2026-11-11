# Actor image = stock public OpenClaw (2026.11.2-slim) + the agent's config and persona.
#
# Pinned by digest: a golden snapshot is only valid for the exact image it was
# taken from. Keep identical to build/gateway.Dockerfile.
FROM ghcr.io/openclaw/openclaw@sha256:55294524dac01370288fb4beb16714b60f75cec0e96e07e662054cf29900965a
USER 0

# OpenAI-compatible HTTP API + trusted link-local proxy (atenet delivers into the
# sandbox from 169.254.x.x). See always-on-agent docs.
COPY build/actor/openclaw.json /home/node/.openclaw/openclaw.json

# The agent workspace (~/.openclaw/workspace) is an external Filestore VolumePool
# volume mounted by Substrate, so the persona files are kept outside it and
# seeded into the volume on first boot by the entrypoint.
COPY build/actor/SOUL.md build/actor/IDENTITY.md build/actor/AGENTS.md /opt/persona/
COPY build/actor/entrypoint.sh /opt/entrypoint.sh
RUN chmod 0755 /opt/entrypoint.sh && mkdir -p /home/node/.openclaw/workspace \
 && chown -R 1000:1000 /home/node /opt/persona

# Runs as the image's node user (uid 1000). Substrate drops capabilities in the
# sandbox, so root there has no CAP_DAC_OVERRIDE and cannot read node-owned files;
# Substrate makes volumes writable for the image's non-root user instead.
USER 1000
ENV HOME=/home/node OPENCLAW_CONFIG_DIR=/home/node/.openclaw NODE_ENV=production
ENTRYPOINT ["/opt/entrypoint.sh"]
