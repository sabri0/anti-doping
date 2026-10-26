#!/bin/sh
# Enroll every identity in the network against its own organizational CA.
#
# Runs INSIDE the ca-tools container (the only image that ships fabric-ca-client),
# so the host needs no Fabric binaries. Invoked by scripts/network-up.sh.
#
# Each of the five organisational classes gets its own CA, its own MSP, and
# NodeOU-based role separation (client / peer / admin / orderer). Four of the
# classes also operate one ordering node each, enrolled against their own CA:
# there is no separate ordering organisation.
set -eu

ROOT=/work
ORGS_DIR=$ROOT/network/organizations
DOMAIN=antidoping.org
export FABRIC_CA_CLIENT_TLS_CERTFILES=""

# org_key:ca_port
ORG_LIST="athlete:7054 federation:8054 nado:9054 lab:10054 research:11054"
# Organisations that operate an ordering node.
ORDERER_ORGS="athlete federation nado lab"

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

  # 3b. Ordering node, for the organisations that operate one.
  case " $ORDERER_ORGS " in
    *" $ORG "*)
      OHOST=orderer.$ORG.$DOMAIN
      ODIR=$ORG_HOME/orderers/$OHOST
      mkdir -p "$ODIR"
      fabric-ca-client register --caname "$CA" --id.name "orderer-$ORG" --id.secret ordererpw         --id.type orderer --tls.certfiles "$CA_CERT" >/dev/null
      fabric-ca-client enroll -u "https://orderer-$ORG:ordererpw@$CA:$PORT" --caname "$CA"         -M "$ODIR/msp" --csr.hosts "$OHOST" --tls.certfiles "$CA_CERT" >/dev/null
      write_nodeou_config "$ODIR/msp"
      fabric-ca-client enroll -u "https://orderer-$ORG:ordererpw@$CA:$PORT" --caname "$CA"         -M "$ODIR/tls" --enrollment.profile tls         --csr.hosts "$OHOST" --csr.hosts localhost         --tls.certfiles "$CA_CERT" >/dev/null
      normalise_tls "$ODIR/tls"
      ;;
  esac

  # 4. Org-level trust anchors, referenced by configtx.yaml.
  mkdir -p "$ORG_HOME/msp/tlscacerts" "$ORG_HOME/tlsca" "$ORG_HOME/ca"
  cp "$CA_CERT" "$ORG_HOME/msp/tlscacerts/ca.crt"
  cp "$CA_CERT" "$ORG_HOME/tlsca/tlsca.$ORG.$DOMAIN-cert.pem"
  cp "$CA_CERT" "$ORG_HOME/ca/ca.$ORG.$DOMAIN-cert.pem"
  # Every orderer trusts every organisation's TLS root for cluster traffic.
  mkdir -p "$ORGS_DIR/cas"
  cp "$CA_CERT" "$ORGS_DIR/cas/$ORG.pem"

  # 5. Administrator and end-user identities used by the CLI and the gateway.
  fabric-ca-client enroll -u "https://${ORG}admin:${ORG}adminpw@$CA:$PORT" --caname "$CA" \
    -M "$ORG_HOME/users/Admin@$ORG.$DOMAIN/msp" --tls.certfiles "$CA_CERT" >/dev/null
  write_nodeou_config "$ORG_HOME/users/Admin@$ORG.$DOMAIN/msp"

  fabric-ca-client enroll -u "https://${ORG}user:${ORG}userpw@$CA:$PORT" --caname "$CA" \
    -M "$ORG_HOME/users/User1@$ORG.$DOMAIN/msp" --tls.certfiles "$CA_CERT" >/dev/null
  write_nodeou_config "$ORG_HOME/users/User1@$ORG.$DOMAIN/msp"
done

log "all identities enrolled across 5 certification authorities"
