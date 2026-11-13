# Base OpenClaw image, pinned by digest. Gateway and actor must use the SAME one.
#   2026.11.2-slim: ghcr.io/openclaw/openclaw@sha256:55294524dac01370288fb4beb16714b60f75cec0e96e07e662054cf29900965a
#   2026.8.2-slim:  ghcr.io/openclaw/openclaw@sha256:5d25165995041caa6a7175bec82b25ad98c44eb269bb42435da8e27ec06e6be4
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw@sha256:55294524dac01370288fb4beb16714b60f75cec0e96e07e662054cf29900965a
# Actor image = stock public OpenClaw (2026.11.2-slim) + the agent's config and persona.
#
# Pinned by digest: a golden snapshot is only valid for the exact image it was
# taken from. Keep identical to build/gateway.Dockerfile.
FROM ${OPENCLAW_IMAGE}
USER 0

# OpenAI-compatible HTTP API + trusted link-local proxy (atenet delivers into the
# sandbox from 169.254.x.x). See always-on-agent docs.
COPY build/actor/openclaw.json /home/node/.openclaw/openclaw.json

# The agent workspace (~/.openclaw/workspace) is an external Filestore VolumePool
# volume mounted by Substrate, so the persona files are kept outside it and
# seeded into the volume on first boot by the entrypoint.
ARG RUN_AS_UID=1000
COPY build/actor/SOUL.md build/actor/IDENTITY.md build/actor/AGENTS.md build/actor/USER.md build/actor/BOOTSTRAP.md /opt/persona/
COPY build/actor/wakeup.mjs /opt/wakeup.mjs
COPY build/actor/entrypoint.sh /opt/entrypoint.sh
RUN chmod 0755 /opt/entrypoint.sh && mkdir -p /home/node/.openclaw/workspace /home/node/files \
 && chown -R ${RUN_AS_UID}:${RUN_AS_UID} /home/node /opt/persona

# Runs as RUN_AS_UID, and everything it writes is owned by that uid. Substrate drops
# capabilities in the sandbox, so even root has no CAP_DAC_OVERRIDE/CAP_CHOWN there:
# a process can only write what its own uid owns.
#  - 1000 (default, the image's node user): Substrate makes durableDir volumes
#    writable for it.
#  - 0 for the Filestore variant: a fresh VolumePool share is owned by root:root
#    0755 and nothing in the sandbox can chown it, so the agent runs as root to be
#    able to write the user's files/ volume.
USER ${RUN_AS_UID}
ENV HOME=/home/node OPENCLAW_CONFIG_DIR=/home/node/.openclaw NODE_ENV=production
ENTRYPOINT ["/opt/entrypoint.sh"]
