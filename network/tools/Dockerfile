# Fabric administration tools at the version the network runs.
#
# Hyperledger publishes no fabric-tools image for Fabric 3.x, so the 3.1.5
# release binaries (peer, configtxgen, osnadmin, ...) are layered over the 2.5
# tools image, which supplies the shell, jq and the default configuration.
# BFT channel configuration needs configtxgen 3.x.
FROM hyperledger/fabric-tools:2.5.16
COPY bin/ /usr/local/bin/
RUN peer version | head -3 && configtxgen --version
