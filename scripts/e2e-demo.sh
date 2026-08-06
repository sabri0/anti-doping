#!/usr/bin/env bash
# End-to-end demonstration against the running network.
#
# Drives a real sample through the full regulatory workflow as committed
# blockchain transactions, then verifies the two properties the manuscript
# claims but never demonstrated:
#
#   1. cross-organizational endorsement — a NADO acting alone cannot alter
#      committed results-management state (§4.1 insider-collusion mitigation);
#   2. purpose-limited ABAC — a researcher receives two of six data categories
#      and is refused the other four (§3.5 worked scenario).
#
# Every step below is a transaction endorsed, ordered and committed by the
# network; nothing is simulated.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.."

CHANNEL=${CHANNEL:-antidopingchannel}
DOMAIN=antidoping.org
ORG_ROOT=/work/network/organizations
ORDERER_CA=$ORG_ROOT/ordererOrganizations/$DOMAIN/tlsca/tlsca.$DOMAIN-cert.pem
SAMPLE=${SAMPLE:-SMP-2026-$RANDOM}
ATHLETE=$(printf 'a%.0s' $(seq 1 64))
LIST_VERSION="2026-01"
LIST_HASH=$(printf 'f%.0s' $(seq 1 64))

declare -A MSPID=( [athlete]=AthleteMSP [federation]=FederationMSP [nado]=NADOMSP \
                   [lab]=LabMSP [research]=ResearchMSP )
declare -A PORT=( [athlete]=7051 [federation]=8051 [nado]=9051 [lab]=10051 [research]=11051 )

blue() { printf '\n\033[0;34m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m   PASS\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m   FAIL\033[0m %s\n' "$*"; exit 1; }

incli() { docker compose exec -T cli sh -c "$1"; }

as() {
  local org=$1
  echo "CORE_PEER_LOCALMSPID=${MSPID[$org]} \
CORE_PEER_MSPCONFIGPATH=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/users/Admin@$org.$DOMAIN/msp \
CORE_PEER_TLS_ROOTCERT_FILE=$ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer0.$org.$DOMAIN/tls/ca.crt \
CORE_PEER_ADDRESS=peer0.$org.$DOMAIN:${PORT[$org]}"
}

# --peerAddresses fragments for the orgs whose endorsement a transaction needs.
endorsers() {
  local out=""
  for org in "$@"; do
    out="$out --peerAddresses peer0.$org.$DOMAIN:${PORT[$org]} \
--tlsRootCertFiles $ORG_ROOT/peerOrganizations/$org.$DOMAIN/peers/peer0.$org.$DOMAIN/tls/ca.crt"
  done
  echo "$out"
}

invoke() {
  local org=$1 cc=$2 payload=$3; shift 3
  incli "$(as "$org") peer chaincode invoke \
    -o orderer.$DOMAIN:7050 --ordererTLSHostnameOverride orderer.$DOMAIN \
    --tls --cafile $ORDERER_CA -C $CHANNEL -n $cc \
    -c '$payload' $(endorsers "$@") --waitForEvent" 2>&1
}

query() {
  local org=$1 cc=$2 payload=$3
  incli "$(as "$org") peer chaincode query -C $CHANNEL -n $cc -c '$payload'" 2>&1
}

blue "1. NADO registers the WADA Prohibited List revision"
invoke nado custody "{\"function\":\"registerProhibitedList\",\"Args\":[\"$LIST_VERSION\",\"$LIST_HASH\"]}" nado >/dev/null
ok "Prohibited List $LIST_VERSION registered on-ledger"

blue "2. Article 5.3 — NADO opens the chain of custody for $SAMPLE"
invoke nado custody "{\"function\":\"initiateSampleCustody\",\"Args\":[\"$SAMPLE\",\"$ATHLETE\",\"seal-hash-001\",\"Tunis National Testing Centre\"]}" nado >/dev/null
ok "custody chain opened"

blue "3. Article 5.4 — transport handoff and laboratory receipt"
invoke nado custody "{\"function\":\"recordCustodyTransfer\",\"Args\":[\"$SAMPLE\",\"TRANSPORT_HANDOFF\",\"NADOMSP\",\"LabMSP\",\"true\",\"48\"]}" nado lab >/dev/null
invoke lab custody "{\"function\":\"recordCustodyTransfer\",\"Args\":[\"$SAMPLE\",\"LABORATORY_RECEIPT\",\"NADOMSP\",\"LabMSP\",\"true\",\"48\"]}" nado lab >/dev/null
ok "two custody transfers committed with dual-organization endorsement"

blue "4. Article 2.1 — accredited laboratory commits an adverse analytical finding"
invoke lab custody "{\"function\":\"recordSampleAnalysisResult\",\"Args\":[\"$SAMPLE\",\"true\",\"Erythropoietin\",\"$LIST_VERSION\",\"$LIST_HASH\",\"VERIFIED\"]}" lab >/dev/null
ok "analysis result committed against a hash-verified Prohibited List"

blue "5. Article 7.1 — results management runs the Table 2 decision engine on-chain"
invoke nado custody "{\"function\":\"triggerResultsManagement\",\"Args\":[\"$SAMPLE\"]}" nado lab >/dev/null
RESULT=$(query nado custody "{\"function\":\"getResultsManagement\",\"Args\":[\"$SAMPLE\"]}")
echo "$RESULT" | head -c 600; echo
echo "$RESULT" | grep -q 'AAF_CONFIRMED' || fail "expected AAF_CONFIRMED from the on-chain decision engine"
echo "$RESULT" | grep -q 'statutoryDeadline' || fail "Article 7.3 statutory clock was not started"
ok "Table 2 rule R1 fired on-chain; Article 7.3 clock started"

blue "6. Article 14.1 — confidentiality gate during results management"
RESEARCH_VIEW=$(query research custody "{\"function\":\"enforceResultsConfidentiality\",\"Args\":[\"$SAMPLE\"]}")
echo "$RESEARCH_VIEW" | grep -q '"granted":false' || fail "a research organization was able to read results under management"
ok "research organization refused (Article 14.1)"
NADO_VIEW=$(query nado custody "{\"function\":\"enforceResultsConfidentiality\",\"Args\":[\"$SAMPLE\"]}")
echo "$NADO_VIEW" | grep -q '"granted":true' || fail "the NADO was refused its own case"
ok "NADO granted"

blue "7. §4.1 — a single organization cannot alter committed results state"
# The results key carries a state-based endorsement policy of
# AND(NADOMSP.peer, LabMSP.peer). Re-running results management with NADO
# endorsement alone must be rejected at commit time.
set +e
SOLO=$(invoke nado custody "{\"function\":\"triggerResultsManagement\",\"Args\":[\"$SAMPLE\"]}" nado)
set -e
if echo "$SOLO" | grep -qi 'ENDORSEMENT_POLICY_FAILURE'; then
  ok "single-organization write rejected with ENDORSEMENT_POLICY_FAILURE"
else
  echo "$SOLO" | tail -5
  fail "a single organization altered results-management state — §4.1 mitigation is not enforced"
fi

blue "8. Article 7.9 / GDPR Article 22 — suspension blocked without human oversight"
set +e
NO_OVERSIGHT=$(invoke nado custody "{\"function\":\"recordProvisionalSuspension\",\"Args\":[\"$SAMPLE\",\"Article 7.9\"]}" nado lab)
set -e
echo "$NO_OVERSIGHT" | grep -q 'GDPR Article 22' || fail "a provisional suspension was imposed by automated processing alone"
ok "provisional suspension refused: no human oversight record"

invoke nado custody "{\"function\":\"enforceOversightRequirement\",\"Args\":[\"$SAMPLE\",\"reviewer-014\",\"UPHOLD\",\"Chain of custody complete; accredited laboratory; finding upheld\"]}" nado >/dev/null
invoke nado custody "{\"function\":\"recordProvisionalSuspension\",\"Args\":[\"$SAMPLE\",\"Article 7.9\"]}" nado lab >/dev/null
ok "suspension recorded once a named human reviewer upheld the finding"

blue "9. §3.5 — athlete consent and purpose-limited ABAC"
invoke athlete consent "{\"function\":\"recordConsentTransaction\",\"Args\":[\"$ATHLETE\",\"ResearchMSP\",\"cardiovascular_research\",\"gps_accelerometry,biochemical_markers,abp_haematological,abp_steroidal,psychological,genetic\",\"2026-01-01T00:00:00.000Z\",\"2027-01-01T00:00:00.000Z\",\"true\"]}" athlete >/dev/null
ok "athlete granted consent for a cardiovascular study across all six categories"

DECISION=$(query research consent "{\"function\":\"previewConsentDecision\",\"Args\":[\"$ATHLETE\",\"cardiovascular_research\",\"gps_accelerometry,biochemical_markers,abp_haematological,abp_steroidal,psychological,genetic\"]}")
echo "$DECISION" | python -c "import json,sys; d=json.load(sys.stdin); print('   granted:', d['granted']); print('   denied :', d['denied'])"
echo "$DECISION" | grep -q '"granted":\["abp_haematological","gps_accelerometry"\]\|"granted":\["gps_accelerometry","abp_haematological"\]' \
  || echo "$DECISION" | python -c "
import json,sys
d=json.load(sys.stdin)
assert sorted(d['granted'])==['abp_haematological','gps_accelerometry'], d['granted']
assert sorted(d['denied'])==['abp_steroidal','biochemical_markers','genetic','psychological'], d['denied']
"
ok "researcher received haematological + accelerometry only; four categories auto-denied"

blue "10. Article 7(3) — withdrawal takes effect immediately"
invoke athlete consent "{\"function\":\"withdrawConsent\",\"Args\":[\"$ATHLETE\",\"ResearchMSP\",\"cardiovascular_research\"]}" athlete >/dev/null
AFTER=$(query research consent "{\"function\":\"previewConsentDecision\",\"Args\":[\"$ATHLETE\",\"cardiovascular_research\",\"abp_haematological\"]}")
echo "$AFTER" | grep -q '"granted":\[\]' || fail "data was still released after consent withdrawal"
ok "nothing released after withdrawal"

blue "11. Ledger provenance"
HISTORY=$(query nado custody "{\"function\":\"getSampleHistory\",\"Args\":[\"$SAMPLE\"]}")
COUNT=$(echo "$HISTORY" | python -c "import json,sys; print(len(json.load(sys.stdin)))")
[ "$COUNT" -ge 3 ] || fail "expected a multi-entry modification history, got $COUNT"
ok "$COUNT ledger versions recorded for $SAMPLE, each with its transaction id"

printf '\n\033[0;32mEnd-to-end demonstration complete for sample %s\033[0m\n' "$SAMPLE"
