#!/usr/bin/env python3
"""Generate docker-compose.yaml for the anti-doping governance network.

Topology is dictated by §4 of docs/implementation_plan.md, which in turn mirrors
§3.2 of the manuscript:

  * 6 Fabric CAs   — one per organizational class + one for the orderer
  * 10 peers       — 2 per organizational class (endorsing + committing)
  * 10 CouchDB     — one per peer, required for ABAC rich queries
  * 1 Raft orderer — baseline consensus
  * 3 IPFS (Kubo)  — multi-node pinning, per the §4.1 threat mitigation

The file is generated rather than hand-written because the 30 services differ
only by org name and port offset; generating removes transcription errors.
Regenerate with:  python scripts/gen-compose.py
"""

import io

FABRIC = "2.5.13"
CA_VER = "1.5.15"
COUCH = "3.3.3"
KUBO = "v0.29.0"
DOMAIN = "antidoping.org"
NET = "antidoping_net"

# (key, MSP id, port base). Peer i of org listens on <base>051 + 10*i.
ORGS = [
    ("athlete", "AthleteMSP", 7),
    ("federation", "FederationMSP", 8),
    ("nado", "NADOMSP", 9),
    ("lab", "LabMSP", 10),
    ("research", "ResearchMSP", 11),
]
PEERS_PER_ORG = 2

out = io.StringIO()
w = out.write

w("# GENERATED FILE — edit scripts/gen-compose.py and rerun, do not edit by hand.\n")
w("# Anti-doping governance network: 6 CAs, 10 peers, 10 CouchDB, Raft orderer, 3 IPFS.\n\n")
w("networks:\n  %s:\n    name: %s\n\n" % (NET, NET))

# ---------------------------------------------------------------- volumes
w("volumes:\n")
w("  orderer.%s:\n" % DOMAIN)
for org, _, _ in ORGS:
    for i in range(PEERS_PER_ORG):
        w("  peer%d.%s.%s:\n" % (i, org, DOMAIN))
        w("  couchdb%d-%s:\n" % (i, org))
for i in range(3):
    w("  ipfs%d-data:\n" % i)
w("\nservices:\n")


def ca(name, port, opsport, msp_org):
    w(f"""
  ca-{name}:
    image: hyperledger/fabric-ca:{CA_VER}
    container_name: ca-{name}
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
      - "{opsport}:{opsport}"
    command: sh -c 'fabric-ca-server start -b admin:adminpw -d'
    volumes:
      - ./network/organizations/fabric-ca/{name}:/etc/hyperledger/fabric-ca-server
    networks: [{NET}]
    healthcheck:
      test: ["CMD", "sh", "-c", "curl -sfk https://localhost:{port}/cainfo || wget -q --no-check-certificate -O- https://localhost:{port}/cainfo"]
      interval: 5s
      timeout: 5s
      retries: 20
""")


w("\n  # ---------------------------------------------------------- Certification authorities\n")
w("  # One CA per organizational class — the multi-CA structure is the paper's\n")
w("  # core mitigation against single-authority credential compromise (§4.1).\n")
for idx, (org, msp, base) in enumerate(ORGS):
    ca(org, 7054 + 1000 * idx, 17054 + 1000 * idx, msp)
ca("orderer", 12054, 22054, "OrdererMSP")

# ---------------------------------------------------------------- orderer
w(f"""
  # ---------------------------------------------------------- Ordering service (Raft)
  orderer.{DOMAIN}:
    image: hyperledger/fabric-orderer:{FABRIC}
    container_name: orderer.{DOMAIN}
    labels: {{ antidoping.role: "orderer" }}
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - ORDERER_GENERAL_LISTENADDRESS=0.0.0.0
      - ORDERER_GENERAL_LISTENPORT=7050
      - ORDERER_GENERAL_LOCALMSPID=OrdererMSP
      - ORDERER_GENERAL_LOCALMSPDIR=/var/hyperledger/orderer/msp
      - ORDERER_GENERAL_TLS_ENABLED=true
      - ORDERER_GENERAL_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_GENERAL_CLUSTER_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_GENERAL_BOOTSTRAPMETHOD=none
      - ORDERER_CHANNELPARTICIPATION_ENABLED=true
      - ORDERER_ADMIN_TLS_ENABLED=true
      - ORDERER_ADMIN_TLS_CERTIFICATE=/var/hyperledger/orderer/tls/server.crt
      - ORDERER_ADMIN_TLS_PRIVATEKEY=/var/hyperledger/orderer/tls/server.key
      - ORDERER_ADMIN_TLS_ROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_TLS_CLIENTROOTCAS=[/var/hyperledger/orderer/tls/ca.crt]
      - ORDERER_ADMIN_LISTENADDRESS=0.0.0.0:7053
      - ORDERER_OPERATIONS_LISTENADDRESS=0.0.0.0:9443
      - ORDERER_METRICS_PROVIDER=prometheus
    working_dir: /root
    command: orderer
    volumes:
      - ./network/organizations/ordererOrganizations/{DOMAIN}/orderers/orderer.{DOMAIN}/msp:/var/hyperledger/orderer/msp
      - ./network/organizations/ordererOrganizations/{DOMAIN}/orderers/orderer.{DOMAIN}/tls:/var/hyperledger/orderer/tls
      - orderer.{DOMAIN}:/var/hyperledger/production/orderer
    ports:
      - "7050:7050"
      - "7053:7053"
      - "19443:9443"
    networks: [{NET}]
""")

# ---------------------------------------------------------------- peers + couchdb
w("\n  # ---------------------------------------------------------- Peers and CouchDB state stores\n")
for idx, (org, msp, base) in enumerate(ORGS):
    for i in range(PEERS_PER_ORG):
        host = f"peer{i}.{org}.{DOMAIN}"
        pport = base * 1000 + 51 + 10 * i          # 7051 / 7061, 8051 / 8061, ...
        opsport = 19000 + idx * 10 + i
        cport = 15984 + idx * PEERS_PER_ORG + i
        cdb = f"couchdb{i}-{org}"
        w(f"""
  {cdb}:
    image: couchdb:{COUCH}
    container_name: {cdb}
    labels: {{ antidoping.role: "statedb", antidoping.org: "{org}" }}
    environment:
      - COUCHDB_USER=admin
      - COUCHDB_PASSWORD=adminpw
    ports:
      - "{cport}:5984"
    volumes:
      - {cdb}:/opt/couchdb/data
    networks: [{NET}]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:5984/_up"]
      interval: 5s
      timeout: 5s
      retries: 20

  {host}:
    image: hyperledger/fabric-peer:{FABRIC}
    container_name: {host}
    labels: {{ antidoping.role: "peer", antidoping.org: "{org}" }}
    depends_on:
      {cdb}: {{ condition: service_healthy }}
    environment:
      - FABRIC_LOGGING_SPEC=INFO
      - CORE_PEER_ID={host}
      - CORE_PEER_ADDRESS={host}:{pport}
      - CORE_PEER_LISTENADDRESS=0.0.0.0:{pport}
      - CORE_PEER_CHAINCODEADDRESS={host}:{pport + 1}
      - CORE_PEER_CHAINCODELISTENADDRESS=0.0.0.0:{pport + 1}
      - CORE_PEER_GOSSIP_BOOTSTRAP={host}:{pport}
      - CORE_PEER_GOSSIP_EXTERNALENDPOINT={host}:{pport}
      - CORE_PEER_LOCALMSPID={msp}
      - CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/fabric/msp
      - CORE_PEER_TLS_ENABLED=true
      - CORE_PEER_TLS_CERT_FILE=/etc/hyperledger/fabric/tls/server.crt
      - CORE_PEER_TLS_KEY_FILE=/etc/hyperledger/fabric/tls/server.key
      - CORE_PEER_TLS_ROOTCERT_FILE=/etc/hyperledger/fabric/tls/ca.crt
      - CORE_LEDGER_STATE_STATEDATABASE=CouchDB
      - CORE_LEDGER_STATE_COUCHDBCONFIG_COUCHDBADDRESS={cdb}:5984
      - CORE_LEDGER_STATE_COUCHDBCONFIG_USERNAME=admin
      - CORE_LEDGER_STATE_COUCHDBCONFIG_PASSWORD=adminpw
      - CORE_OPERATIONS_LISTENADDRESS=0.0.0.0:9443
      - CORE_METRICS_PROVIDER=prometheus
      - 'CORE_CHAINCODE_EXTERNALBUILDERS=[{{name: ccaas_builder, path: /opt/hyperledger/ccaas_builder, propagateEnvironment: [CHAINCODE_AS_A_SERVICE_BUILDER_CONFIG]}}]'
      - 'CHAINCODE_AS_A_SERVICE_BUILDER_CONFIG={{"peername":"{host}"}}'
    volumes:
      - ./network/organizations/peerOrganizations/{org}.{DOMAIN}/peers/{host}/msp:/etc/hyperledger/fabric/msp
      - ./network/organizations/peerOrganizations/{org}.{DOMAIN}/peers/{host}/tls:/etc/hyperledger/fabric/tls
      - {host}:/var/hyperledger/production
    ports:
      - "{pport}:{pport}"
      - "{opsport}:9443"
    networks: [{NET}]
""")

# ---------------------------------------------------------------- IPFS
w("\n  # ---------------------------------------------------------- IPFS (Kubo) off-chain store\n")
w("  # Three nodes so that erasure must unpin across a cluster, not a single host (§6).\n")
for i in range(3):
    w(f"""
  ipfs{i}:
    image: ipfs/kubo:{KUBO}
    container_name: ipfs{i}
    labels: {{ antidoping.role: "ipfs" }}
    environment:
      - IPFS_PROFILE=server
    ports:
      - "{5011 + i}:5001"
      - "{8091 + i}:8080"
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

# ---------------------------------------------------------------- tooling
w(f"""
  # ---------------------------------------------------------- Tooling containers
  # All administration runs inside containers so the host needs nothing but Docker.
  cli:
    image: hyperledger/fabric-tools:{FABRIC}
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
""")

# ---------------------------------------------------------------- chaincode-as-a-service
w(f"""
  # ---------------------------------------------------------- Chaincode as a service
  # CHAINCODE_ID values are written into .env by scripts/deploy-chaincode.sh
  # after `peer lifecycle chaincode install` reports the package identifier.
  custody-cc:
    build: ./chaincode/custody
    image: antidoping/custody-cc:1.0
    container_name: custody-cc
    labels: {{ antidoping.role: "chaincode" }}
    environment:
      - CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999
      - CHAINCODE_ID=${{CUSTODY_CCID}}
      - CORE_CHAINCODE_ID_NAME=${{CUSTODY_CCID}}
    networks: [{NET}]

  consent-cc:
    build: ./chaincode/consent
    image: antidoping/consent-cc:1.0
    container_name: consent-cc
    labels: {{ antidoping.role: "chaincode" }}
    environment:
      - CHAINCODE_SERVER_ADDRESS=0.0.0.0:9999
      - CHAINCODE_ID=${{CONSENT_CCID}}
      - CORE_CHAINCODE_ID_NAME=${{CONSENT_CCID}}
    networks: [{NET}]

  # ---------------------------------------------------------- Application tier
  gateway:
    build: ./gateway
    image: antidoping/gateway:1.0
    container_name: gateway
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
    image: antidoping/web:1.0
    container_name: web
    labels: {{ antidoping.role: "web" }}
    ports:
      - "8088:80"
    networks: [{NET}]
""")

with open("docker-compose.yaml", "w", encoding="utf-8", newline="\n") as fh:
    fh.write(out.getvalue())

print("wrote docker-compose.yaml (%d lines)" % out.getvalue().count("\n"))
