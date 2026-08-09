#!/usr/bin/env bash
set -Eeuo pipefail

app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
image_ref="${1:?usage: deploy.sh ghcr.io/owner/repository@sha256:digest}"
current_file="$app_dir/.current-image"
previous_image=''

if [[ -s "$current_file" ]]; then
  previous_image="$(<"$current_file")"
fi

cd "$app_dir"

rollback() {
  if [[ -z "$previous_image" ]]; then
    echo "No previous image is available for rollback." >&2
    return 0
  fi

  echo "Restoring $previous_image" >&2
  export IMAGE_REF="$previous_image"
  docker compose -f compose.yml up -d archive-payload || return 0
  for _ in {1..30}; do
    if curl --fail --silent --show-error http://127.0.0.1:13000/api/health >/dev/null; then
      echo "Previous image is healthy." >&2
      return 0
    fi
    sleep 2
  done
  echo "Previous image did not become healthy." >&2
}

fail_deploy() {
  echo "Payload deployment failed." >&2
  set +e
  rollback
  exit 1
}

export IMAGE_REF="$image_ref"
docker compose -f compose.yml pull archive-payload || fail_deploy
docker compose -f compose.yml up -d archive-payload || fail_deploy

healthy=0
for _ in {1..30}; do
  if curl --fail --silent --show-error http://127.0.0.1:13000/api/health >/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" != 1 ]]; then
  fail_deploy
fi

printf '%s\n' "$image_ref" >"$current_file"
