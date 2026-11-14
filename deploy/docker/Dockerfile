FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de
ARG CODEX_VERSION=0.149.1
ARG SERVICE_VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="Codex Review Service" \
      org.opencontainers.image.source="https://github.com/jiying2007/codex-review-service" \
      org.opencontainers.image.version="${SERVICE_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"
# Disable retries before upgrading the vulnerable package manager itself.
RUN apt-get -o Acquire::Retries=0 update \
    && apt-get -o Acquire::Retries=0 install -y --no-install-recommends --only-upgrade apt libapt-pkg7.0 libpcre2-8-0 zlib1g gzip libsqlite3-0 libssl3t64 openssl-provider-legacy perl-base \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' apt)" ge 3.0.4 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libapt-pkg7.0)" ge 3.0.4 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge '10.46-1~deb13u3' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge '1:1.3.dfsg+really1.3.1-1+deb13u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' gzip)" ge '1.13-1+deb13u1' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libsqlite3-0)" ge '3.46.1-7+deb13u2' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libssl3t64)" ge '3.5.7-1~deb13u3' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' openssl-provider-legacy)" ge '3.5.7-1~deb13u3' \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' perl-base)" ge '5.40.1-6+deb13u1' \
    && apt-get -o Acquire::Retries=0 install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g "@openai/codex@${CODEX_VERSION}" \
    && useradd --system --create-home --home-dir /home/codex-review --shell /usr/sbin/nologin codex-review
WORKDIR /app
COPY package.json package-lock.json product-contract.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && rm -rf /root/.npm /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY src ./src
RUN mkdir -p /var/lib/codex-review /etc/codex-review \
    && chown -R codex-review:codex-review /var/lib/codex-review /home/codex-review
USER codex-review
ENV CODEX_REVIEW_CONFIG_FILE=/etc/codex-review/config.json
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","src/index.js"]
