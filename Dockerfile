# Build from the PARENT directory (kaspa-apps/) so the file: deps on the upstream kaspa-x402 clone resolve:
#   docker build -f x402-gateway/Dockerfile -t x402-gateway:dev .
# Testnet-10 only. Mock chain is the default; real mode also needs the WASM SDK (vendor/) and keys mounted at runtime.
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY upstream-x402/protocol/packages ./upstream-x402/protocol/packages
COPY x402-gateway/package.json x402-gateway/package-lock.json ./x402-gateway/
WORKDIR /app/x402-gateway
RUN npm ci --omit=dev
COPY x402-gateway/bin ./bin
COPY x402-gateway/src ./src
COPY x402-gateway/config ./config

FROM node:20-bookworm-slim
ENV NODE_ENV=production X402_DB=/data/gateway.sqlite X402_CHAIN=mock
WORKDIR /app
COPY --from=build /app /app
# Optional, real mode only:  -v $PWD/vendor:/app/vendor:ro  -v $PWD/x402-gateway/.secrets:/app/x402-gateway/.secrets:ro   (L9: keys read-only; live batch also needs a writable dataDir, e.g. -v x402live:/app/x402-gateway/.secrets/live-batch)
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app/x402-gateway
VOLUME ["/data"]
EXPOSE 8402
# listen.host in the config must be 0.0.0.0 inside a container (or pass --host 0.0.0.0)
ENTRYPOINT ["node", "bin/x402-gateway.mjs"]
CMD ["serve", "--host", "0.0.0.0"]
