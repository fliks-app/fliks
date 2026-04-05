#!/usr/bin/env bash
set -euo pipefail

IMAGE="ghcr.io/clementdelestre/suitarr"
TAG="${1:-latest}"

echo "==> Building ${IMAGE}:${TAG}"
docker build -t "${IMAGE}:${TAG}" .

echo "==> Logging in to ghcr.io"
echo "${GITHUB_TOKEN}" | docker login ghcr.io -u clementdelestre --password-stdin

echo "==> Pushing ${IMAGE}:${TAG}"
docker push "${IMAGE}:${TAG}"

echo "==> Done: ${IMAGE}:${TAG}"



##  TO USE : ./scripts/push-ghcr.sh v1.0.0 
