#!/usr/bin/env python3
"""Generate Hyperledger Caliper connection profiles and network configuration.

Caliper runs inside a container attached to antidoping_net, so it addresses
peers by their container hostnames rather than published host ports. Key and
certificate filenames produced by fabric-ca-client are randomised, so they are
resolved here rather than hard-coded.

Run after scripts/network-up.sh:  python scripts/gen-benchmark-config.py
"""

import glob
import json
import os
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ORGS_DIR = ROOT / "network" / "organizations" / "peerOrganizations"
OUT = ROOT / "benchmark" / "generated"
DOMAIN = "antidoping.org"
CHANNEL = "antidopingchannel"

# org key -> (MSP id, peer port)
ORGS = {
    "athlete": ("AthleteMSP", 7051),
    "federation": ("FederationMSP", 8051),
    "nado": ("NADOMSP", 9051),
    "lab": ("LabMSP", 10051),
    "research": ("ResearchMSP", 11051),
}


def one(pattern: str) -> pathlib.Path:
    """Resolve a glob that must match exactly one file."""
    matches = sorted(glob.glob(pattern))
    if not matches:
        sys.exit(f"ERROR: no file matches {pattern}\nRun scripts/network-up.sh first.")
    return pathlib.Path(matches[0])


def build(org: str, msp: str, port: int) -> dict:
    """Connection profile for `org`.

    Every profile lists all five organizations and all five peers, not just the
    owning organization's own. Discovery is disabled (the peers advertise
    container-internal addresses that only resolve on antidoping_net), so a
    client can reach only the peers named in its profile. A profile containing
    a single peer cannot satisfy a request that targets two organizations —
    endorsement then fails with an empty error list, because no endorser was
    reachable at all. Custody transfers and results-management writes carry
    two-organization state-based endorsement policies, so every profile must be
    able to reach every organization's peer.
    """
    peers = {}
    organizations = {}

    for other, (other_msp, other_port) in ORGS.items():
        peer = f"peer0.{other}.{DOMAIN}"
        tls_ca = (ORGS_DIR / f"{other}.{DOMAIN}" / "peers" / peer / "tls" / "ca.crt").read_text()
        peers[peer] = {
            # Container hostname: Caliper runs on the same Docker network.
            "url": f"grpcs://{peer}:{other_port}",
            "tlsCACerts": {"pem": tls_ca},
            "grpcOptions": {
                "ssl-target-name-override": peer,
                "hostnameOverride": peer,
                "grpc.keepalive_time_ms": 120000,
            },
        }
        organizations[other_msp] = {"mspid": other_msp, "peers": [peer]}

    orderer_tls = (
        ROOT
        / "network/organizations/ordererOrganizations"
        / DOMAIN
        / "tlsca"
        / f"tlsca.{DOMAIN}-cert.pem"
    ).read_text()

    return {
        "name": f"antidoping-{org}",
        "version": "1.0.0",
        "client": {
            "organization": msp,
            "connection": {"timeout": {"peer": {"endorser": "300"}, "orderer": "300"}},
        },
        # With discovery disabled, fabric-network builds the channel's endorser
        # set solely from this block. Omitting it yields a channel with zero
        # peers, and every submit then fails with an empty endorsement error
        # list while the peers themselves log nothing at all.
        "channels": {
            CHANNEL: {
                "orderers": [f"orderer.{DOMAIN}"],
                "peers": {
                    name: {
                        "endorsingPeer": True,
                        "chaincodeQuery": True,
                        "ledgerQuery": True,
                        "eventSource": True,
                    }
                    for name in peers
                },
            }
        },
        "organizations": organizations,
        "orderers": {
            f"orderer.{DOMAIN}": {
                "url": f"grpcs://orderer.{DOMAIN}:7050",
                "tlsCACerts": {"pem": orderer_tls},
                "grpcOptions": {"ssl-target-name-override": f"orderer.{DOMAIN}"},
            }
        },
        "peers": peers,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    organizations = []

    for org, (msp, port) in ORGS.items():
        profile = build(org, msp, port)
        (OUT / f"ccp-{org}.json").write_text(json.dumps(profile, indent=2))

        user_msp = ORGS_DIR / f"{org}.{DOMAIN}" / "users" / f"Admin@{org}.{DOMAIN}" / "msp"
        key = one(str(user_msp / "keystore" / "*"))
        cert = one(str(user_msp / "signcerts" / "*"))

        organizations.append(
            {
                "mspid": msp,
                "identities": {
                    "certificates": [
                        {
                            "name": f"{org}-admin",
                            "admin": True,
                            "clientPrivateKey": {"path": f"/work/{key.relative_to(ROOT).as_posix()}"},
                            "clientSignedCert": {"path": f"/work/{cert.relative_to(ROOT).as_posix()}"},
                        }
                    ]
                },
                "connectionProfile": {
                    "path": f"/work/benchmark/generated/ccp-{org}.json",
                    "discover": False,
                },
            }
        )

    network = {
        "name": "antidoping-governance-network",
        "version": "2.0.0",
        "caliper": {"blockchain": "fabric", "sutOptions": {"mutualTls": False}},
        "channels": [
            {
                "channelName": CHANNEL,
                "contracts": [{"id": "custody"}, {"id": "consent"}],
            }
        ],
        "organizations": organizations,
    }

    (OUT / "network-config.json").write_text(json.dumps(network, indent=2))
    print(f"wrote {len(ORGS)} connection profiles and network-config.json to {OUT}")


if __name__ == "__main__":
    main()
