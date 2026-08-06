#!/bin/sh
# Detach this node from the public IPFS network.
#
# Athlete biological ciphertext must never be announced to a public DHT, even
# encrypted: the CID alone would leak the existence and size of a record. The
# cluster therefore runs with no bootstrap peers and local-only routing; the
# off-chain client writes the bytes to every node directly.
set -e
ipfs bootstrap rm --all >/dev/null 2>&1 || true
ipfs config Routing.Type none
ipfs config --json Discovery.MDNS.Enabled false
ipfs config --json Swarm.DisableNatPortMap true
echo "[ipfs-init] node detached from the public network (private cluster)"
