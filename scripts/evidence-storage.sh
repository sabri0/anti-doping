#!/usr/bin/env bash
# Record which organisations' state databases hold private-collection content.
#
# CouchDB keeps one database per namespace: <channel>_<chaincode>$$p<collection>
# holds the private records themselves, $$h<collection> only their hashes. A
# database of the first kind on a non-member peer would mean the collection
# leaked; this script lists both kinds for every peer and writes the result to
# docs/storage-confidentiality.json.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${OUT:-docs/storage-confidentiality.json}
printf '{\n  "recordedAt": "%s",\n  "peers": {\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT"
first=1
for org in athlete federation nado lab research; do
  for i in 0 1; do
    dbs=$(docker exec "couchdb$i-$org" curl -s http://admin:adminpw@localhost:5984/_all_dbs \
          | tr -d '[]' | tr ',' '\n' | grep -E 'custody|consent' | paste -sd, -)
    [ $first -eq 1 ] || printf ',\n' >> "$OUT"
    first=0
    printf '    "peer%s.%s": [%s]' "$i" "$org" "$dbs" >> "$OUT"
  done
done
printf '\n  }\n}\n' >> "$OUT"
echo "[evidence] $OUT"
