#!/usr/bin/env bash
# Stage 0 acceptance gate: verify the toolchain and report every pinned version.
#
# The build runs almost entirely inside containers, so the host requirements are
# deliberately small: Docker with Compose v2, and Node only if you want to run
# the unit tests outside a container.
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
ok()   { printf '  \033[0;32mOK\033[0m   %-22s %s\n' "$1" "$2"; }
bad()  { printf '  \033[0;31mMISS\033[0m %-22s %s\n' "$1" "$2"; FAIL=1; }
note() { printf '  \033[0;33m--\033[0m   %-22s %s\n' "$1" "$2"; }

echo "Anti-doping governance framework - preflight"
echo

echo "Host tools"
if command -v docker >/dev/null 2>&1; then
  ok docker "$(docker --version)"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose" "$(docker compose version)"
  else
    bad "docker compose" "Compose v2 is required (docker compose, not docker-compose)"
  fi
  if docker info >/dev/null 2>&1; then
    ok "docker daemon" "reachable"
  else
    bad "docker daemon" "not reachable - is Docker running?"
  fi
else
  bad docker "not installed"
fi

command -v python  >/dev/null 2>&1 && ok python "$(python --version 2>&1)"  || \
  command -v python3 >/dev/null 2>&1 && ok python3 "$(python3 --version 2>&1)" || \
  bad python "required to generate the compose and benchmark configuration"

command -v node >/dev/null 2>&1 && ok node "$(node --version)" || \
  note node "not installed - unit tests then run only inside containers"

echo
echo "Pinned image versions"
grep -oE 'hyperledger/fabric-(peer|orderer|tools|ca):[0-9.]+' docker-compose.yaml | sort -u | sed 's/^/  /'
grep -oE 'couchdb:[0-9.]+|ipfs/kubo:v[0-9.]+' docker-compose.yaml | sort -u | sed 's/^/  /'
echo "  hyperledger/caliper:0.6.0 (benchmark/Dockerfile)"

echo
echo "Locally available images"
for image in hyperledger/fabric-peer:2.5.13 hyperledger/fabric-orderer:2.5.13 \
             hyperledger/fabric-tools:2.5.13 hyperledger/fabric-ca:1.5.15 \
             couchdb:3.3.3 ipfs/kubo:v0.29.0; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    ok "$(echo "$image" | cut -d: -f1 | cut -d/ -f2)" "$image"
  else
    note "$(echo "$image" | cut -d: -f1 | cut -d/ -f2)" "$image not pulled yet (network-up.sh will fetch it)"
  fi
done

echo
if [ "$FAIL" -eq 0 ]; then
  echo -e "\033[0;32mpreflight passed\033[0m"
else
  echo -e "\033[0;31mpreflight failed\033[0m"
fi
exit $FAIL
