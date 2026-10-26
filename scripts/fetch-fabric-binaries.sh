#!/usr/bin/env bash
# Fetch the Fabric 3.1.5 release binaries that the tools image layers over
# fabric-tools 2.5 (network/tools/Dockerfile). Hyperledger publishes no 3.x
# tools image, and BFT channel configuration needs configtxgen 3.x.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=${FABRIC_VERSION:-3.1.5}
mkdir -p network/bin-cache network/tools
ARCHIVE=network/bin-cache/fabric-$VERSION.tar.gz
[ -f "$ARCHIVE" ] || curl -sSL -o "$ARCHIVE"   "https://github.com/hyperledger/fabric/releases/download/v$VERSION/hyperledger-fabric-linux-amd64-$VERSION.tar.gz"
tar xzf "$ARCHIVE" -C network/tools bin
echo "[fabric-binaries] network/tools/bin: $(ls network/tools/bin | tr '
' ' ')"
