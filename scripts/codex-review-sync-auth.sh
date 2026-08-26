#!/usr/bin/env bash
set -euo pipefail
MODE=dry-run
for arg in "$@"; do case "$arg" in --dry-run) MODE=dry-run;; --apply) MODE=apply;; --restart) MODE=restart;; --help) echo "Usage: $0 [--dry-run|--apply|--restart]"; exit 0;; *) echo "Unknown option: $arg" >&2; exit 2;; esac; done
SOURCE_AUTH="${CODEX_REVIEW_HOST_AUTH_FILE:-$HOME/.codex/auth.json}"
CONTAINER="${CODEX_REVIEW_CONTAINER:-}"
if [ -z "$CONTAINER" ]; then
  CONTAINER="$(docker ps --filter 'label=com.docker.compose.service=codex-review-service' --format '{{.Names}}' | head -n1)"
fi
test -n "$CONTAINER" || { echo "Codex Review Service container was not found; set CODEX_REVIEW_CONTAINER" >&2; exit 1; }
test -s "$SOURCE_AUTH" || { echo "Host Codex auth file is missing" >&2; exit 1; }
VOLUME="$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/home/codex-review"}}{{.Name}}{{end}}{{end}}')"
test -n "$VOLUME" || { echo "Codex home volume was not found" >&2; exit 1; }
IMAGE="${CODEX_REVIEW_IMAGE:-$(docker inspect "$CONTAINER" --format '{{.Config.Image}}')}"
test -n "$IMAGE" || { echo "Container image could not be resolved" >&2; exit 1; }
if [ "$MODE" = dry-run ]; then echo "Would sync host Codex auth into Docker volume: $VOLUME (container: $CONTAINER, image: $IMAGE)"; exit 0; fi
docker run --rm --user root -v "$VOLUME:/home/codex-review" -v "$SOURCE_AUTH:/source/auth.json:ro" "$IMAGE" sh -c 'mkdir -p /home/codex-review/.codex; cp /source/auth.json /home/codex-review/.codex/auth.json; chown -R 999:999 /home/codex-review/.codex; chmod 0700 /home/codex-review/.codex; chmod 0600 /home/codex-review/.codex/auth.json; test -s /home/codex-review/.codex/auth.json'
if [ "$MODE" = restart ]; then docker restart "$CONTAINER" >/dev/null; sleep 3; fi
docker exec "$CONTAINER" codex login status
