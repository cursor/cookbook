#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="/var/log/cursor-worker-bootstrap.log"
exec > >(tee -a "$${LOG_FILE}") 2>&1

echo "Starting Cursor worker bootstrap at $(date -Is)"

dnf update -y
dnf install -y awscli docker git

systemctl enable --now docker

aws ecr get-login-password --region "${aws_region}" \
  | docker login --username AWS --password-stdin "${ecr_repository_url}"

for attempt in {1..60}; do
  if CURSOR_API_KEY="$(aws secretsmanager get-secret-value \
      --region "${aws_region}" \
      --secret-id "${cursor_api_key_secret_id}" \
      --query SecretString \
      --output text 2>/dev/null)"; then
    break
  fi

  echo "Waiting for Cursor API key secret value, attempt $${attempt}/60"
  sleep 10
done

if [[ -z "$${CURSOR_API_KEY:-}" || "$${CURSOR_API_KEY}" == "None" ]]; then
  echo "Cursor API key secret value was not available after waiting." >&2
  exit 1
fi

install -d -m 0700 /etc/cursor
install -d -m 0755 /opt/cursor/worker
if [[ ! -d /opt/cursor/worker/.git ]]; then
  git -C /opt/cursor/worker init
fi
git -C /opt/cursor/worker remote remove origin 2>/dev/null || true
git -C /opt/cursor/worker remote add origin "${worker_repository_url}"

cat >/etc/cursor/worker.env <<EOF
${cursor_api_key_env_name}=$${CURSOR_API_KEY}
CURSOR_WORKER_POOL_NAME=${worker_pool_name}
CURSOR_WORKER_IDLE_RELEASE_TIMEOUT=${worker_idle_release_timeout}
CURSOR_WORKER_LABELS_FILE=/etc/cursor/labels.json
%{ if cursor_worker_management_addr != "" ~}
CURSOR_WORKER_MANAGEMENT_ADDR=${cursor_worker_management_addr}
%{ endif ~}
EOF
chmod 0600 /etc/cursor/worker.env

docker rm -f cursor-worker 2>/dev/null || true
for attempt in {1..60}; do
  if docker pull "${worker_image}"; then
    break
  fi

  echo "Waiting for worker image ${worker_image}, attempt $${attempt}/60"
  sleep 10
done

if ! docker image inspect "${worker_image}" >/dev/null 2>&1; then
  echo "Worker image ${worker_image} was not available after waiting." >&2
  exit 1
fi

docker run -d \
  --name cursor-worker \
  --restart unless-stopped \
  --env-file /etc/cursor/worker.env \
  --volume /opt/cursor/worker:/workspace \
  "${worker_image}"

echo "Cursor worker bootstrap complete at $(date -Is)"
