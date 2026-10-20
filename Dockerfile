# The sample as a container: the same `node --experimental-strip-types
# server.ts` the README runs, on Node 22 (type stripping needs >= 22.12).
FROM node:22-alpine
# Node and the idle `sleep` below ignore SIGTERM when they run as PID 1, so
# every stop would wait out the grace period and end in a SIGKILL. tini is
# PID 1 instead and hands the signal on.
RUN apk add --no-cache tini
LABEL org.opencontainers.image.source="https://github.com/abill-io/abillio-gateway-example" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# The npm cache is only for the install: it stays out of the image.
RUN npm ci --omit=dev && npm cache clean --force
# The whole repo minus .dockerignore. public/ comes along with its fonts and
# their licence texts (the OFL wants them to travel together), and the server
# serves /public from this working directory.
COPY . .
# The state directory is the only thing the process writes; the code stays
# root's, read-only to it.
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=4000 STATE_FILE=/data/state.json
EXPOSE 4000
VOLUME ["/data"]
ENTRYPOINT ["/sbin/tini", "--"]
# No key seeded yet (the deploy seeds it after the first roll-out), or only
# half of it: say so once and idle, so the orchestrator does not restart-loop
# the container on the error loadEnv would raise.
CMD ["sh", "-c", "if [ -z \"$ABILLIO_API_KEY_ID\" ] || [ -z \"$ABILLIO_PRIVATE_KEY\" ]; then echo 'gateway-example: ABILLIO_API_KEY_ID or ABILLIO_PRIVATE_KEY is empty, idling until both are seeded'; exec sleep infinity; fi; exec node --experimental-strip-types server.ts"]
