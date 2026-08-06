#!/usr/bin/env bash
# Deploy the custody and consent chaincodes to the running network.
#
# Uses chaincode-as-a-service: the contract runs in its own container and the
# peer connects to it over gRPC, instead of the peer building and launching the
# chaincode itself. This makes deployment reproducible and keeps the built
# artefact identical to the one the unit tests exercised.
#
# Chaincode-level endorsement is OR over the five organizational classes.
# Cross-organizational endorsement on critical results-management state is
# imposed per-key by the chaincode itself (state-based endorsement), which is
# what §4.1 of the manuscript actually requires — a blanket AND policy would
# also force laboratory endorsement on sample collection, which is wrong.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-antidopingchannel}
DOMAIN=antidoping.org
VERSION=${VERSION:-1.0}
SEQUENCE=1  # recomputed per chaincode from what is already committed
ORG_ROOT=/work/network/organizations
ORDERER_CA=$ORG_ROOT/ordererOrganizations/$DOMAIN/tlsca/tlsca.$DOMAIN-cert.pem
POLICY="OR('AthleteMSP.peer','FederationMSP.peer','NADOMSP.peer','LabMSP.peer','ResearchMSP.peer')"

ORG_PORTS=(athlete:7 federation:8 nado:9 lab:10 research:11)
declare -A MSP=( [athlete]=AthleteMSP [federation]=FederationMSP [nado]=NADOMSP \
                 [lab]=LabMSP [research]=ResearchMSP )

blue() { printf '\033[0;34m[chaincode]\033[0m %s\n' "$*"; }
incli() { docker compose exec -T cli sh -c "$1"; }

# Environment prefix that makes the peer CLI act as `org`'s admin against peer `i`.
peer_env() {
  local org=$1 i=$2 base=$3
  local port=$((base * 1000 + 51 + 10 * i))
  echo "CORE_PEER_LOCALMSPID=${MSP[$org]} \
CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/users/Admin@$org.$DOMAIN/msp \
CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer$i.$org.$DOMAIN/tls/ca.crt \
CORE_PEER_ADDRESS=peer$i.$org.$DOMAIN:$port"
}

deploy() {
  local NAME=$1 SERVICE=$2 ENVVAR=$3
  local LABEL="${NAME}_${VERSION}"
  local PKGDIR=/work/network/chaincode-packages/$NAME

  # A chaincode definition may only be committed once per sequence number, so a
  # redeploy has to advance it. Read what is already committed and go next.
  # querycommitted exits non-zero when the chaincode is not yet committed, which
  # is the normal first-deploy case — errexit/pipefail must not treat it as fatal.
  # Strip to digits: the CLI emits CRLF and MSP notices alongside the JSON.
  local COMMITTED
  set +e
  COMMITTED=$(incli "$(peer_env nado 0 9) peer lifecycle chaincode querycommitted \
    --channelID $CHANNEL --name $NAME --output json" 2>/dev/null \
    | python -c "import json,sys
try:
    print(int(json.load(sys.stdin).get('sequence', 0)))
except Exception:
    print(0)" 2>/dev/null | tr -dc '0-9')
  set -e
  COMMITTED=${COMMITTED:-0}
  SEQUENCE=$((COMMITTED + 1))
  blue "$NAME: committed sequence $COMMITTED, deploying sequence $SEQUENCE"

  blue "packaging $NAME as chaincode-as-a-service"
  # Fixed mtime/ownership so the package digest — and therefore the package id —
  # is reproducible across runs rather than changing with the wall clock.
  incli "rm -rf $PKGDIR && mkdir -p $PKGDIR && cd $PKGDIR && \
    printf '{\"address\":\"%s:9999\",\"dial_timeout\":\"10s\",\"tls_required\":false}' '$SERVICE' > connection.json && \
    tar czf code.tar.gz --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner connection.json && \
    printf '{\"type\":\"ccaas\",\"label\":\"%s\"}' '$LABEL' > metadata.json && \
    tar czf $NAME.tgz --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner metadata.json code.tar.gz"

  local PKGID
  PKGID=$(incli "peer lifecycle chaincode calculatepackageid $PKGDIR/$NAME.tgz" | tr -d '\r\n')
  blue "$NAME package id: $PKGID"

  # The chaincode server must announce exactly this identifier.
  python - "$ENVVAR" "$PKGID" <<'PY'
import re, sys, pathlib
var, val = sys.argv[1], sys.argv[2]
p = pathlib.Path('.env')
text = p.read_text() if p.exists() else ''
if re.search(rf'^{var}=.*$', text, re.M):
    text = re.sub(rf'^{var}=.*$', f'{var}={val}', text, flags=re.M)
else:
    text += f'{var}={val}\n'
p.write_text(text)
PY

  blue "starting the $NAME chaincode container"
  docker compose up -d --build "$SERVICE" >/dev/null 2>&1

  blue "installing $NAME on all ten peers"
  for entry in "${ORG_PORTS[@]}"; do
    local org=${entry%%:*} base=${entry##*:}
    for i in 0 1; do
      incli "$(peer_env "$org" "$i" "$base") \
        peer lifecycle chaincode install $PKGDIR/$NAME.tgz" >/dev/null 2>&1 || true
    done
  done

  blue "approving $NAME for each organizational class"
  for entry in "${ORG_PORTS[@]}"; do
    local org=${entry%%:*} base=${entry##*:}
    incli "$(peer_env "$org" 0 "$base") \
      peer lifecycle chaincode approveformyorg \
      -o orderer.$DOMAIN:7050 --ordererTLSHostnameOverride orderer.$DOMAIN \
      --tls --cafile $ORDERER_CA --channelID $CHANNEL --name $NAME \
      --version $VERSION --package-id $PKGID --sequence $SEQUENCE \
      --signature-policy \"$POLICY\"" >/dev/null
  done

  blue "checking commit readiness for $NAME"
  incli "$(peer_env nado 0 9) \
    peer lifecycle chaincode checkcommitreadiness --channelID $CHANNEL --name $NAME \
    --version $VERSION --sequence $SEQUENCE --signature-policy \"$POLICY\" --output json"

  # Commit needs endorsement from a majority of organizations.
  local PEER_ARGS=""
  for entry in "${ORG_PORTS[@]}"; do
    local org=${entry%%:*} base=${entry##*:}
    local port=$((base * 1000 + 51))
    PEER_ARGS="$PEER_ARGS --peerAddresses peer0.$org.$DOMAIN:$port \
--tlsRootCertFiles $ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer0.$org.$DOMAIN/tls/ca.crt"
  done

  blue "committing $NAME to $CHANNEL"
  incli "$(peer_env nado 0 9) \
    peer lifecycle chaincode commit \
    -o orderer.$DOMAIN:7050 --ordererTLSHostnameOverride orderer.$DOMAIN \
    --tls --cafile $ORDERER_CA --channelID $CHANNEL --name $NAME \
    --version $VERSION --sequence $SEQUENCE --signature-policy \"$POLICY\" $PEER_ARGS"

  blue "$NAME committed"
}

deploy custody custody-cc CUSTODY_CCID
deploy consent consent-cc CONSENT_CCID

blue "committed chaincode definitions on $CHANNEL:"
incli "$(peer_env nado 0 9) peer lifecycle chaincode querycommitted --channelID $CHANNEL"
