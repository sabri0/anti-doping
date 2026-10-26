#!/usr/bin/env bash
# Deploy the custody and consent chaincodes to the running network.
#
# Chaincode-as-a-service: each contract runs in its own container and the peer
# connects to it over gRPC, so the deployed artefact is the one the unit tests
# exercised.
#
# Endorsement, in three layers:
#
#   chaincode-level   OutOf(2) over the five classes: every public write needs
#                     peers of two distinct organisations to have executed it.
#   collection-level  resultsCollection: AND(NADO, laboratory) for every write,
#                     including the one that creates a record; consentCollection:
#                     an athlete-organisation peer, the only class holding it.
#   key-level         custody dispatch and receipt events and the sample record
#                     are bound by the chaincode to AND(NADO, laboratory).
#
# A second definition, custodyor, uses the same package with an OR policy. It
# exists only so the benchmark can measure the cost of two-organisation versus
# one-organisation endorsement on an identical transaction.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like absolute Unix paths.
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-antidopingchannel}
DOMAIN=antidoping.org
VERSION=${VERSION:-2.0}
PY=${PY:-python}
ORG_ROOT=/work/network/organizations
ORDERER=orderer.nado.$DOMAIN:9050
ORDERER_CA=$ORG_ROOT/peerOrganizations/nado.$DOMAIN/tlsca/tlsca.nado.$DOMAIN-cert.pem
POLICY_2OF5="OutOf(2,'AthleteMSP.peer','FederationMSP.peer','NADOMSP.peer','LabMSP.peer','ResearchMSP.peer')"
POLICY_OR="OR('AthleteMSP.peer','FederationMSP.peer','NADOMSP.peer','LabMSP.peer','ResearchMSP.peer')"
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

# Package the contract, install it on all ten peers and start its container.
# Prints the package id.
package_and_install() {
  local NAME=$1 SERVICE=$2 ENVVAR=$3
  local LABEL="${NAME}_${VERSION}"
  local PKGDIR=/work/network/chaincode-packages/$NAME
  # Fixed mtime/ownership so the package digest — and therefore the package id —
  # is reproducible across runs rather than changing with the wall clock.
  incli "rm -rf $PKGDIR && mkdir -p $PKGDIR && cd $PKGDIR && \
    printf '{\"address\":\"%s:9999\",\"dial_timeout\":\"10s\",\"tls_required\":false}' '$SERVICE' > connection.json && \
    tar czf code.tar.gz --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner connection.json && \
    printf '{\"type\":\"ccaas\",\"label\":\"%s\"}' '$LABEL' > metadata.json && \
    tar czf $NAME.tgz --sort=name --mtime='UTC 2026-01-01' --owner=0 --group=0 --numeric-owner metadata.json code.tar.gz" >&2
  local PKGID
  PKGID=$(incli "peer lifecycle chaincode calculatepackageid $PKGDIR/$NAME.tgz" | tr -d '\r\n')
  # The chaincode server must announce exactly this identifier.
  "$PY" - "$ENVVAR" "$PKGID" <<'PY'
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
  docker compose up -d --build "$SERVICE" >/dev/null 2>&1
  for entry in "${ORG_PORTS[@]}"; do
    local org=${entry%%:*} base=${entry##*:}
    for i in 0 1; do
      incli "$(peer_env "$org" "$i" "$base") peer lifecycle chaincode install $PKGDIR/$NAME.tgz" >/dev/null 2>&1 || true
    done
  done
  echo "$PKGID"
}

# Approve and commit one chaincode definition that uses an installed package.
define() {
  local NAME=$1 PKGID=$2 POLICY=$3 COLLECTIONS=$4
  local COMMITTED SEQUENCE
  set +e
  COMMITTED=$(incli "$(peer_env nado 0 9) peer lifecycle chaincode querycommitted \
    --channelID $CHANNEL --name $NAME --output json" 2>/dev/null \
    | "$PY" -c "import json,sys
try:
    print(int(json.load(sys.stdin).get('sequence', 0)))
except Exception:
    print(0)" 2>/dev/null | tr -dc '0-9')
  set -e
  SEQUENCE=$(( ${COMMITTED:-0} + 1 ))
  local CC_ARGS="--channelID $CHANNEL --name $NAME --version $VERSION --sequence $SEQUENCE \
--signature-policy \"$POLICY\" --collections-config /work/network/collections/$COLLECTIONS"

  blue "$NAME: approving sequence $SEQUENCE for each organisational class"
  for entry in "${ORG_PORTS[@]}"; do
    local org=${entry%%:*} base=${entry##*:}
    incli "$(peer_env "$org" 0 "$base") peer lifecycle chaincode approveformyorg \
      -o $ORDERER --tls --cafile $ORDERER_CA --package-id $PKGID $CC_ARGS" >/dev/null
  done
  incli "$(peer_env nado 0 9) peer lifecycle chaincode checkcommitreadiness $CC_ARGS --output json"

  local PEER_ARGS=""
  for entry in "${ORG_PORTS[@]}"; do
    local org=${entry%%:*} base=${entry##*:}
    PEER_ARGS="$PEER_ARGS --peerAddresses peer0.$org.$DOMAIN:$((base * 1000 + 51)) \
--tlsRootCertFiles $ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer0.$org.$DOMAIN/tls/ca.crt"
  done
  blue "$NAME: committing to $CHANNEL"
  incli "$(peer_env nado 0 9) peer lifecycle chaincode commit \
    -o $ORDERER --tls --cafile $ORDERER_CA $CC_ARGS $PEER_ARGS"
}

blue "packaging and installing custody"
CUSTODY_PKG=$(package_and_install custody custody-cc CUSTODY_CCID)
blue "custody package id: $CUSTODY_PKG"
define custody "$CUSTODY_PKG" "$POLICY_2OF5" custody.json
define custodyor "$CUSTODY_PKG" "$POLICY_OR" custody.json

blue "packaging and installing consent"
CONSENT_PKG=$(package_and_install consent consent-cc CONSENT_CCID)
blue "consent package id: $CONSENT_PKG"
define consent "$CONSENT_PKG" "$POLICY_2OF5" consent.json

blue "committed chaincode definitions on $CHANNEL:"
incli "$(peer_env nado 0 9) peer lifecycle chaincode querycommitted --channelID $CHANNEL"
