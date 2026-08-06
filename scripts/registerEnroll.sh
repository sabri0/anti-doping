#!/bin/sh
# Enroll every identity in the network against its own organizational CA.
#
# Runs INSIDE the ca-tools container (the only image that ships fabric-ca-client),
# so the host needs no Fabric binaries. Invoked by scripts/network-up.sh.
#
# Each of the five organizational classes from §3.2 of the manuscript gets its
# own CA, its own MSP, and NodeOU-based role separation (client / peer / admin).
set -eu

ROOT=/work
ORGS_DIR=$ROOT/network/organizations
DOMAIN=antidoping.org
export FABRIC_CA_CLIENT_TLS_CERTFILES=""

# org_key:ca_port
ORG_LIST="athlete:7054 federation:8054 nado:9054 lab:10054 research:11054"

log() { printf '\033[0;34m[enroll]\033[0m %s\n' "$*"; }

# Write the NodeOU config that lets Fabric derive client/peer/admin roles from
# the OU field of a certificate instead of a legacy admincerts folder.
#
# The cacerts filename is discovered rather than constructed: fabric-ca-client
# names it <host>-<port>-<caname>.pem, not <host>-<port>.pem, and a wrong name
# leaves NodeOU role resolution silently disabled (the peer logs a warning and
# then treats every identity as unclassified).
write_nodeou_config() {
  msp_dir=$1
  ca_cert_name=$(basename "$(ls "$msp_dir"/cacerts/*.pem | head -1)")
  cat > "$msp_dir/config.yaml" <<EOF
NodeOUs:
  Enable: true
  ClientOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: client
  PeerOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: peer
  AdminOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: admin
  OrdererOUIdentifier:
    Certificate: cacerts/${ca_cert_name}
    OrganizationalUnitIdentifier: orderer
EOF
}

# fabric-ca-client writes the TLS key under keystore/ with a generated name;
# the peer and orderer expect fixed filenames.
normalise_tls() {
  tls_dir=$1
  cp "$tls_dir"/signcerts/* "$tls_dir/server.crt"
  cp "$tls_dir"/keystore/*  "$tls_dir/server.key"
  cp "$tls_dir"/tlscacerts/* "$tls_dir/ca.crt"
}

# ---------------------------------------------------------------- peer orgs
for entry in $ORG_LIST; do
  ORG=${entry%%:*}
  PORT=${entry##*:}
  CA=ca-$ORG
  ORG_HOME=$ORGS_DIR/peerOrganizations/$ORG.$DOMAIN
  CA_CERT=$ORGS_DIR/fabric-ca/$ORG/ca-cert.pem

  log "org $ORG -> $CA:$PORT"
  mkdir -p "$ORG_HOME"
  export FABRIC_CA_CLIENT_HOME=$ORG_HOME

  # 1. Enroll the CA administrator.
  fabric-ca-client enroll -u "https://admin:adminpw@$CA:$PORT" \
    --caname "$CA" --tls.certfiles "$CA_CERT" >/dev/null

  write_nodeou_config "$ORG_HOME/msp"

  # 2. Register the identities this organization owns.
  fabric-ca-client register --caname "$CA" --id.name "peer0-$ORG" --id.secret peerpw \
    --id.type peer --tls.certfiles "$CA_CERT" >/dev/null
  fabric-ca-client register --caname "$CA" --id.name "peer1-$ORG" --id.secret peerpw \
    --id.type peer --tls.certfiles "$CA_CERT" >/dev/null
  fabric-ca-client register --caname "$CA" --id.name "${ORG}admin" --id.secret ${ORG}adminpw \
    --id.type admin --tls.certfiles "$CA_CERT" >/dev/null
  fabric-ca-client register --caname "$CA" --id.name "${ORG}user" --id.secret ${ORG}userpw \
    --id.type client --tls.certfiles "$CA_CERT" >/dev/null

  # 3. Enroll each peer: one identity MSP, one TLS certificate.
  i=0
  while [ $i -lt 2 ]; do
    PEER=peer$i.$ORG.$DOMAIN
    PDIR=$ORG_HOME/peers/$PEER
    mkdir -p "$PDIR"

    fabric-ca-client enroll -u "https://peer$i-$ORG:peerpw@$CA:$PORT" --caname "$CA" \
      -M "$PDIR/msp" --csr.hosts "$PEER" --tls.certfiles "$CA_CERT" >/dev/null
    write_nodeou_config "$PDIR/msp"

    fabric-ca-client enroll -u "https://peer$i-$ORG:peerpw@$CA:$PORT" --caname "$CA" \
      -M "$PDIR/tls" --enrollment.profile tls \
      --csr.hosts "$PEER" --csr.hosts localhost \
      --tls.certfiles "$CA_CERT" >/dev/null
    normalise_tls "$PDIR/tls"
    i=$((i + 1))
  done

  # 4. Org-level trust anchors, referenced by configtx.yaml.
  mkdir -p "$ORG_HOME/msp/tlscacerts" "$ORG_HOME/tlsca" "$ORG_HOME/ca"
  cp "$CA_CERT" "$ORG_HOME/msp/tlscacerts/ca.crt"
  cp "$CA_CERT" "$ORG_HOME/tlsca/tlsca.$ORG.$DOMAIN-cert.pem"
  cp "$CA_CERT" "$ORG_HOME/ca/ca.$ORG.$DOMAIN-cert.pem"

  # 5. Administrator and end-user identities used by the CLI and the gateway.
  fabric-ca-client enroll -u "https://${ORG}admin:${ORG}adminpw@$CA:$PORT" --caname "$CA" \
    -M "$ORG_HOME/users/Admin@$ORG.$DOMAIN/msp" --tls.certfiles "$CA_CERT" >/dev/null
  write_nodeou_config "$ORG_HOME/users/Admin@$ORG.$DOMAIN/msp"

  fabric-ca-client enroll -u "https://${ORG}user:${ORG}userpw@$CA:$PORT" --caname "$CA" \
    -M "$ORG_HOME/users/User1@$ORG.$DOMAIN/msp" --tls.certfiles "$CA_CERT" >/dev/null
  write_nodeou_config "$ORG_HOME/users/User1@$ORG.$DOMAIN/msp"
done

# ---------------------------------------------------------------- orderer org
log "org orderer -> ca-orderer:12054"
ORD_HOME=$ORGS_DIR/ordererOrganizations/$DOMAIN
ORD_CA_CERT=$ORGS_DIR/fabric-ca/orderer/ca-cert.pem
mkdir -p "$ORD_HOME"
export FABRIC_CA_CLIENT_HOME=$ORD_HOME

fabric-ca-client enroll -u "https://admin:adminpw@ca-orderer:12054" \
  --caname ca-orderer --tls.certfiles "$ORD_CA_CERT" >/dev/null
write_nodeou_config "$ORD_HOME/msp"

fabric-ca-client register --caname ca-orderer --id.name orderer --id.secret ordererpw \
  --id.type orderer --tls.certfiles "$ORD_CA_CERT" >/dev/null
fabric-ca-client register --caname ca-orderer --id.name ordereradmin --id.secret ordereradminpw \
  --id.type admin --tls.certfiles "$ORD_CA_CERT" >/dev/null

ODIR=$ORD_HOME/orderers/orderer.$DOMAIN
mkdir -p "$ODIR"
fabric-ca-client enroll -u "https://orderer:ordererpw@ca-orderer:12054" --caname ca-orderer \
  -M "$ODIR/msp" --csr.hosts "orderer.$DOMAIN" --tls.certfiles "$ORD_CA_CERT" >/dev/null
write_nodeou_config "$ODIR/msp"

fabric-ca-client enroll -u "https://orderer:ordererpw@ca-orderer:12054" --caname ca-orderer \
  -M "$ODIR/tls" --enrollment.profile tls \
  --csr.hosts "orderer.$DOMAIN" --csr.hosts localhost \
  --tls.certfiles "$ORD_CA_CERT" >/dev/null
normalise_tls "$ODIR/tls"

mkdir -p "$ORD_HOME/msp/tlscacerts" "$ORD_HOME/tlsca"
cp "$ORD_CA_CERT" "$ORD_HOME/msp/tlscacerts/tlsca.$DOMAIN-cert.pem"
cp "$ORD_CA_CERT" "$ORD_HOME/tlsca/tlsca.$DOMAIN-cert.pem"

fabric-ca-client enroll -u "https://ordereradmin:ordereradminpw@ca-orderer:12054" --caname ca-orderer \
  -M "$ORD_HOME/users/Admin@$DOMAIN/msp" --tls.certfiles "$ORD_CA_CERT" >/dev/null
write_nodeou_config "$ORD_HOME/users/Admin@$DOMAIN/msp"

log "all identities enrolled across 6 certification authorities"
