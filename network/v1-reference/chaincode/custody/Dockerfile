# Chaincode-as-a-service image for the custody contract.
# The peer connects to this container over gRPC instead of building and
# launching chaincode itself, which keeps deployment reproducible.
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 9999
CMD ["npm", "run", "start:server"]
