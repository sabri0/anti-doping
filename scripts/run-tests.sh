#!/usr/bin/env bash
# Run every test suite and record the passing counts the manuscript quotes
# (docs/test-summary.json). The off-chain suite needs the live IPFS cluster;
# with the network down its IPFS tests are reported as pending, and the
# summary records that.
set -uo pipefail
cd "$(dirname "$0")/.."
PY=${PY:-python}
declare -A COUNT PENDING FAILING
for pkg in custody consent offchain fhir; do
  case $pkg in
    custody) dir=chaincode/custody ;;
    consent) dir=chaincode/consent ;;
    offchain) dir=offchain ;;
    fhir) dir=fhir-adapter ;;
  esac
  out=$(cd "$dir" && npx mocha 2>&1)
  COUNT[$pkg]=$(echo "$out" | grep -oE '[0-9]+ passing' | grep -oE '[0-9]+' || echo 0)
  PENDING[$pkg]=$(echo "$out" | grep -oE '[0-9]+ pending' | grep -oE '[0-9]+' || echo 0)
  FAILING[$pkg]=$(echo "$out" | grep -oE '[0-9]+ failing' | grep -oE '[0-9]+' || echo 0)
  echo "[tests] $dir: ${COUNT[$pkg]} passing, ${PENDING[$pkg]} pending, ${FAILING[$pkg]} failing"
done
"$PY" - <<PY
import json, datetime
d = {k: int(v or 0) for k, v in {"custody": "${COUNT[custody]}", "consent": "${COUNT[consent]}",
     "offchain": "${COUNT[offchain]}", "fhir": "${COUNT[fhir]}"}.items()}
d["pending"] = {"offchain": int("${PENDING[offchain]}" or 0)}
d["failing"] = {k: int(v or 0) for k, v in {"custody": "${FAILING[custody]}", "consent": "${FAILING[consent]}",
                "offchain": "${FAILING[offchain]}", "fhir": "${FAILING[fhir]}"}.items()}
d["recordedAt"] = datetime.datetime.utcnow().isoformat() + "Z"
json.dump(d, open("docs/test-summary.json", "w"), indent=1)
print(json.dumps(d))
PY
