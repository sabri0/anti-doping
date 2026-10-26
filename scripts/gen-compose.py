#!/usr/bin/env python3
"""Generate docker-compose.yaml for the anti-doping governance network.

Topology:

  * 5 Fabric CAs   — one per organisational class
  * 10 peers       — 2 per organisational class, Hyperledger Fabric 3.1
  * 10 CouchDB     — one per peer, when STATE_DB=couchdb (omitted for goleveldb)
  * 4 orderers     — one each operated by the athlete, federation, NADO and
                     laboratory organisations, so that no single organisation
                     runs the ordering service; Raft or SmartBFT is chosen
                     when the channel is created, not here
  * 3 IPFS (Kubo)  — private off-chain store for encrypted payloads

Every network container is pinned to the processors in NET_CPUS, and the load
driver runs on the remaining processors (scripts/run-evaluation.sh), so that
the driver does not compete with the network it measures.

Regenerate with:
    python scripts/gen-compose.py [--state-db couchdb|goleveldb] [--net-cpus 0-5]
"""

import argparse
import io

FABRIC = "3.1.5"
CA_VER = "1.5.15"
COUCH = "3.3.3"
KUBO = "v0.29.0"
DOMAIN = "antidoping.org"
NET = "antidoping_v2"

# (key, MSP id, port base). Peer i of org listens on <base>051 + 10*i.
ORGS = [
    ("athlete", "AthleteMSP", 7),
    ("federation", "FederationMSP", 8),
    ("nado", "NADOMSP", 9),
    ("lab", "LabMSP", 10),
    ("research", "ResearchMSP", 11),
]
# Organisations that each operate one ordering node: four is the smallest
# SmartBFT cluster that tolerates one Byzantine node (n >= 3f + 1).
ORDERER_ORGS = ["athlete", "federation", "nado", "lab"]
PEERS_PER_ORG = 2

ap = argparse.ArgumentParser()
ap.add_argument("--state-db", choices=["couchdb", "goleveldb"], default="couchdb")
ap.add_argument("--net-cpus", default="0-5", help="cpuset for network containers, or none")
args = ap.parse_args()
COUCHDB = args.state_db == "couchdb"
CPUS = args.net_cpus

out = io.StringIO()
w = out.write

w("# GENERATED FILE — edit scripts/gen-compose.py and rerun, do not edit by hand.\n")
w(f"# Anti-doping governance network: 5 CAs, 10 peers ({args.state_db}), 4 orderers, 3 IPFS.\n")
w(f"# Network containers pinned to processors {CPUS}.\n\n")
w("networks:\n  %s:\n    name: %s\n\n" % (NET, NET))

w("volumes:\n")
for org in ORDERER_ORGS:
    w("  orderer.%s.%s:\n" % (org, DOMAIN))
for org, _, _ in ORGS:
    for i in range(PEERS_PER_ORG):
        w("  peer%d.%s.%s:\n" % (i, org, DOMAIN))
        if COUCHDB:
            w("  couchdb%d-%s:\n" % (i, org))
for i in range(3):
    w("  ipfs%d-data:\n" % i)
w("\nservices:\n")


def ca(name, port, opsport):
    w(f"""
  ca-{name}:
    image: hyperledger/fabric-ca:{CA_VER}
    container_name: ca-{name}
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "ca", antidoping.org: "{name}" }}
    environment:
      - FABRIC_CA_HOME=/etc/hyperledger/fabric-ca-server
      - FABRIC_CA_SERVER_CA_NAME=ca-{name}
      - FABRIC_CA_SERVER_TLS_ENABLED=true
      - FABRIC_CA_SERVER_PORT={port}
      - FABRIC_CA_SERVER_OPERATIONS_LISTENADDRESS=0.0.0.0:{opsport}
      - FABRIC_CA_SERVER_CSR_CN=ca-{name}
      - FABRIC_CA_SERVER_CSR_HOSTS=ca-{name},localhost,127.0.0.1
    ports:
      - "{port}:{port}"
    command: sh -c 'fabric-ca-server start -b admin:adminpw -d'
    volumes:
      - ./network/organizations/fabric-ca/{name}:/etc/hyperledger/fabric-ca-server
    networks: [{NET}]
""")


w("\n  # ---------------------------------------------------------- Certification authorities\n")
w("  # One CA per organisational class; each issues the identities of its own peers,\n")
w("  # ordering node, administrators and users.\n")
for idx, (org, msp, base) in enumerate(ORGS):
    ca(org, 7054 + 1000 * idx, 17054 + 1000 * idx)

w("\n  # ---------------------------------------------------------- Ordering service\n")
w("  # Four nodes, one per operating organisation. Consensus type (etcdraft or BFT)\n")
w("  # is fixed by the channel genesis block (scripts/create-channel.sh).\n")
ALL_CAS = ",".join(
    f"/var/hyperledger/cas/{org}.pem" for org, _, _ in ORGS
)
for org in ORDERER_ORGS:
    msp = dict((o, m) for o, m, _ in ORGS)[org]
    base = dict((o, b) for o, _, b in ORGS)[org]
    host = f"orderer.{org}.{DOMAIN}"
    port = base * 1000 + 50
    admin = base * 1000 + 53
    odir = f"./network/organizations/peerOrganizations/{org}.{DOMAIN}/orderers/{host}"
    w(f"""
  {host}:
    image: hyperledger/fabric-orderer:{FABRIC}
    container_name: {host}
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "orderer", antidoping.org: "{org}" }}
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - ORDERER_GENERAL_LISTENADDRESS=0.0.0.0
      - ORDERER_GENERAL_LISTENPORT={port}
      - ORDERER_GENERAL_LOCALMSPID={msp}
      - ORDERER_GENERAL_LOCALMSPDIR=/var/hyperledger/orderer/msp
      - ORDERER_GENERAL_TLS_ENABLED=true
      - ORDERER_GENERAL_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_TLS_ROOTCAS=[{ALL_CAS}]
      - ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_CLUSTER_ROOTCAS=[{ALL_CAS}]
      - ORDERER_GENERAL_BOOTSTRAPMETHOD=none
      - ORDERER_CHANNELPARTICIPATION_ENABLED=true
      - ORDERER_ADMIN_TLS_ENABLED=true
      - ORDERER_ADMIN_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_ADMIN_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_ADMIN_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_TLS_CLIENTROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:{admin}
      - ORDERER_OPERATIONS_LISTENADDRESS=0.0.0.0:9443
      - ORDERER_METRICS_PROVIDER=prometheus
    working_dir: /root
    command: orderer
    volumes:
      - {odir}/msp:/var/hyperledger/orderer/msp
      - {odir}/tls:/var/hyperledger/orderer/tls
      - ./network/organizations/cas:/var/hyperledger/cas:ro
      - {host}:/var/hyperledger/production/orderer
    ports:
      - "{port}:{port}"
      - "{admin}:{admin}"
    networks: [{NET}]
""")

w("\n  # ---------------------------------------------------------- Peers and state databases\n")
for idx, (org, msp, base) in enumerate(ORGS):
    for i in range(PEERS_PER_ORG):
        host = f"peer{i}.{org}.{DOMAIN}"
        pport = base * 1000 + 51 + 10 * i
        cdb = f"couchdb{i}-{org}"
        if COUCHDB:
            w(f"""
  {cdb}:
    image: couchdb:{COUCH}
    container_name: {cdb}
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "statedb", antidoping.org: "{org}" }}
    environment:
      - COUCHDB_USER=admin
      - COUCHDB_PASSWORD=adminpw
    volumes:
      - {cdb}:/opt/couchdb/data
    networks: [{NET}]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:5984/_up"]
      interval: 5s
      timeout: 5s
      retries: 20
""")
            statedb = f"""      - CORE_LEDGER_STATE_STATEDATABASE=CouchDB
      - CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS={cdb}:5984
      - CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin
      - CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=adminpw
"""
            depends = f"""    depends_on:
      {cdb}: {{ condition: service_healthy }}
"""
        else:
            statedb = "      - CORE_LEDGER_STATE_STATEDATABASE=goleveldb\n"
            depends = ""
        w(f"""
  {host}:
    image: hyperledger/fabric-peer:{FABRIC}
    container_name: {host}
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "peer", antidoping.org: "{org}" }}
{depends}    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_PEER_ID={host}
      - CORE_PEER_ADDRESS={host}:{pport}
      - CORE_PEER_LISTENADDRESS=0.0.0.0:{pport}
      - CORE_PEER_CHAINCODEADDRESS={host}:{pport + 1}
      - CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:{pport + 1}
      - CORE_PEER_GOSSIP_BOOTSTRAP=peer{1 - i}.{org}.{DOMAIN}:{base * 1000 + 51 + 10 * (1 - i)}
      - CORE_PEER_GOSSIP_EXTERNALENDPOINT={host}:{pport}
      - CORE_PEER_LOCALMSPID={msp}
      - CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp
      - CORE_PEER_TLS_ENABLED=true
      - CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt
      - CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key
      - CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt
{statedb}      - CORE_OPERATIONS_LISTENADDRESS=0.0.0.0:9443
      - CORE_METRICS_PROVIDER=prometheus
      - CLOCK_SKEW_SECONDS=300
      - 'CORE_CHAINCODE_EXTERNALBUILDERS=[{{name: ccaas_builder, path: /opt/hyperledger/ccaas_builder, propagateEnvironment: [CHAINCODE_AS_A_SERVICE_BUILDER_CONFIG]}}]'
      - 'CHAINCODE_AS_A_SERVICE_BUILDER_CONFIG={{"peername":"{host}"}}'
    volumes:
      - ./network/organizations/peerOrganizations/{org}.{DOMAIN}/peers/{host}/msp:/etc/hyperledger/fabric/msp
      - ./network/organizations/peerOrganizations/{org}.{DOMAIN}/peers/{host}/tls:/etc/hyperledger/fabric/tls
      - {host}:/var/hyperledger/production
    ports:
      - "{pport}:{pport}"
    networks: [{NET}]
""")

w("\n  # ---------------------------------------------------------- IPFS (Kubo) off-chain store\n")
w("  # Private cluster: no bootstrap peers, local-only routing (network/ipfs/init).\n")
for i in range(3):
    w(f"""
  ipfs{i}:
    image: ipfs/kubo:{KUBO}
    container_name: ipfs{i}
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "ipfs" }}
    environment:
      - IPFS_PROFILE=server
    ports:
      - "{5011 + i}:5001"
    volumes:
      - ipfs{i}-data:/data/ipfs
      - ./network/ipfs/init:/container-init.d:ro
    networks: [{NET}]
    healthcheck:
      test: ["CMD", "ipfs", "id"]
      interval: 10s
      timeout: 5s
      retries: 20
""")

w(f"""
  # ---------------------------------------------------------- Tooling containers
  # The cli image is fabric-tools 2.5 with the Fabric {FABRIC} binaries layered on top
  # (network/tools/Dockerfile): no 3.x tools image is published.
  cli:
    build: ./network/tools
    image: antidoping/fabric-tools:{FABRIC}
    container_name: cli
    tty: true
    stdin_open: true
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - FABRIC_CFG_PATH=/etc/hyperledger/fabric
      - CORE_PEER_TLS_ENABLED=true
    working_dir: /work
    command: sleep infinity
    volumes:
      - .:/work
    networks: [{NET}]

  ca-tools:
    image: hyperledger/fabric-ca:{CA_VER}
    container_name: ca-tools
    tty: true
    stdin_open: true
    working_dir: /work
    entrypoint: ["/bin/sh", "-c"]
    command: ["sleep infinity"]
    volumes:
      - .:/work
    networks: [{NET}]

  # ---------------------------------------------------------- Chaincode as a service
  # CHAINCODE_ID values are written into .env by scripts/deploy-chaincode.sh.
  # One container serves every chaincode definition that uses its package.
  custody-cc:
    build: ./chaincode/custody
    image: antidoping/custody-cc:2.0
    container_name: custody-cc
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "chaincode" }}
    environment:
      - CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999
      - CHAINCODE_ID=${{CUSTODY_CCID}}
      - CORE_CHAINCODE_ID_NAME=${{CUSTODY_CCID}}
      - CLOCK_SKEW_SECONDS=300
    networks: [{NET}]

  consent-cc:
    build: ./chaincode/consent
    image: antidoping/consent-cc:2.0
    container_name: consent-cc
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "chaincode" }}
    environment:
      - CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999
      - CHAINCODE_ID=${{CONSENT_CCID}}
      - CORE_CHAINCODE_ID_NAME=${{CONSENT_CCID}}
      - CLOCK_SKEW_SECONDS=300
    networks: [{NET}]

  # ---------------------------------------------------------- Application tier
  gateway:
    build: ./gateway
    image: antidoping/gateway:2.0
    container_name: gateway
    cpuset: "{CPUS}"
    labels: {{ antidoping.role: "gateway" }}
    environment:
      - PORT=3000
      - CHANNEL=antidopingchannel
      - CRYPTO_ROOT=/work/network/organizations
    ports:
      - "3000:3000"
    volumes:
      - ./network/organizations:/work/network/organizations:ro
    networks: [{NET}]

  web:
    build: ./web
    image: antidoping/web:2.0
    container_name: web
    labels: {{ antidoping.role: "web" }}
    ports:
      - "8088:80"
    networks: [{NET}]
""")

text = out.getvalue()
if CPUS == "none":
    # No pinning, for hosts with fewer processors than the measured partition (CI).
    text = "\n".join(line for line in text.split("\n") if "cpuset:" not in line)
with open("docker-compose.yaml", "w", encoding="utf-8", newline="\n") as fh:
    fh.write(text)

print("wrote docker-compose.yaml (%d lines, state database %s, network processors %s)"
      % (out.getvalue().count("\n"), args.state_db, CPUS))
