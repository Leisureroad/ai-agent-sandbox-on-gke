FROM golang:1.27-bookworm AS ate
ARG SUBSTRATE_REF=v1.0.0
RUN git clone --filter=blob:none https://github.com/agent-substrate/substrate.git /src \
 && cd /src && git checkout "$SUBSTRATE_REF" \
 && CGO_ENABLED=0 go build -o /out/kubectl-ate ./cmd/kubectl-ate

FROM node:24-bookworm-slim
COPY --from=ate /out/kubectl-ate /usr/local/bin/kubectl-ate
WORKDIR /app
COPY dashboard2/server.mjs dashboard2/autoscaler.mjs dashboard2/console.html dashboard2/chat.html /app/
USER 1000
ENV PORT=8090
EXPOSE 8090
CMD ["node", "/app/server.mjs"]
