FROM node:22.23.2-bookworm-slim
ARG CODEX_VERSION=0.149.1
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN mkdir -p /var/lib/codex-review /etc/codex-review \
    && chown -R codex-review:codex-review /var/lib/codex-review /home/codex-review
USER codex-review
ENV CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/index.js"]
