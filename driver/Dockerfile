# Load driver, scenario runner and baselines.
#
# Built from the repository root so that the compiled off-chain module
# (offchain/dist) is available to the erasure scenario. Run by
# scripts/run-evaluation.sh on processors the network does not use.
FROM node:20-bookworm-slim
WORKDIR /app/driver
COPY driver/package.json driver/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY driver/ ./
COPY offchain/dist /app/offchain/dist
ENV OFFCHAIN_DIST=/app/offchain/dist \
    CRYPTO_ROOT=/work/network/organizations \
    IPFS_ENDPOINTS=http://ipfs0:5001,http://ipfs1:5001,http://ipfs2:5001
ENTRYPOINT ["node"]
