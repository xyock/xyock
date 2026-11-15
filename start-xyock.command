#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
SERVER_PID=""
SERVER_LOG="${TMPDIR:-/tmp}/xyock-server-$$.log"

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
    SERVER_PID=""
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "xyock 실행 환경을 준비합니다."
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Desktop이 필요합니다. Docker Desktop을 설치하고 실행한 뒤 다시 실행하세요."
  open "https://www.docker.com/products/docker-desktop/" 2>/dev/null || true
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop을 먼저 실행해 주세요."
  exit 1
fi

docker compose up -d
echo "Piston 실행 엔진이 시작될 때까지 대기합니다…"
piston_ready=0
for _ in {1..90}; do
  if curl -fsS http://127.0.0.1:2000/api/v2/packages >/dev/null 2>&1; then
    piston_ready=1
    break
  fi
  sleep 2
done
if [ "$piston_ready" -ne 1 ]; then
  echo "Piston 시작에 실패했습니다. Docker 로그를 확인하세요: docker logs xyock-piston"
  exit 1
fi

python3 install-runtimes.py

echo "xyock 로컬 서버를 시작합니다."
python3 app.py >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
server_ready=0
for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then
    server_ready=1
    break
  fi
  if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    echo "xyock 서버가 시작되지 않았습니다. 로그: $SERVER_LOG"
    cat "$SERVER_LOG"
    exit 1
  fi
  sleep 1
done
if [ "$server_ready" -ne 1 ]; then
  echo "xyock 서버의 상태 확인에 실패했습니다. 로그: $SERVER_LOG"
  cat "$SERVER_LOG"
  exit 1
fi

open "http://127.0.0.1:8000/"
echo "xyock 편집기가 실행 중입니다. 종료하려면 Ctrl+C를 누르세요."
wait "$SERVER_PID
