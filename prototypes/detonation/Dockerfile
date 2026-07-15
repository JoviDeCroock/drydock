# Container image for standalone Docker and the optional Cloudflare service.
# Standalone restrictions come from buildDockerArgs; Cloudflare disables internet
# in DetonationContainer and destroys the unique instance after every request.
FROM node:20-alpine

# Non-root user the container runs as (matches buildDockerArgs --user 1000:1000).
RUN addgroup -g 1000 detonation && adduser -u 1000 -G detonation -D detonation

WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src

USER detonation

# Two entrypoints:
#   * As a service (the Cloudflare Container wiring): an HTTP server the Worker
#     POSTs reviewed file bytes to. This is the default.
#   * As a one-shot CLI: `docker run ... node bin/detonate.mjs --package /pkg`
#     (see buildDockerArgs in src/harness.mjs).
EXPOSE 8080
ENV PORT=8080
ENTRYPOINT ["node"]
CMD ["src/server.mjs"]
