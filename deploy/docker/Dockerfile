FROM node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
ARG CODEX_VERSION=0.149.1
ARG SERVICE_VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Codex Review Service" \
      org.opencontainers.image.source="https://github.com/jiying2007/codex-review-service" \
      org.opencontainers.image.version="${SERVICE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
WORKDIR /app
COPY package.json package-lock.json product-contract.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN mkdir -p /var/lib/codex-review /etc/codex-review \
    && chown -R codex-review:codex-review /var/lib/codex-review /home/codex-review
USER codex-review
ENV CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/index.js"]
