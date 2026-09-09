# syntax=docker/dockerfile:1

# Schema Studio, containerised.
#
# Three stages so the image that ships carries neither the source nor the build
# toolchain: install dependencies, build, then copy only what `next start` needs
# into a clean runtime.
#
# Debian slim rather than Alpine: Next pulls in `sharp`, whose prebuilt binaries
# are chosen by libc, and the glibc build is the one that is always published.
# An Alpine base saves ~40 MB and costs an occasional "could not load sharp".

# ---------------------------------------------------------------- dependencies
FROM node:22-slim AS deps
WORKDIR /app

# Only the manifests, so this layer is rebuilt when dependencies change and not
# every time a component does.
COPY package.json package-lock.json ./
RUN npm ci

# ----------------------------------------------------------------------- build
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* variables are inlined into the browser bundle at build time, so
# this one cannot be changed by the runtime environment — an image built with
# the bypass on has it on. Build with
# `--build-arg NEXT_PUBLIC_AUTH_BYPASS=false` to get real sign-in.
ARG NEXT_PUBLIC_AUTH_BYPASS="true"
ENV NEXT_PUBLIC_AUTH_BYPASS=$NEXT_PUBLIC_AUTH_BYPASS

# lib/version-db.ts refuses to load without a connection string, and the build
# imports it while collecting page data. Nothing connects — every page that
# reads the database is force-dynamic — so this deliberately points nowhere.
# The real one arrives at run time.
ENV DATABASE_URL_A=postgres://build:build@127.0.0.1:5432/build

RUN npm run build

# --------------------------------------------------------------------- runtime
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Without this the server binds to localhost inside the container, where
# nothing outside it can reach the published port.
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# `output: "standalone"` writes a self-contained server.js plus the subset of
# node_modules it actually reaches, so the runtime image never sees the full
# dependency tree. Static assets are not part of it and are copied beside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

# Node 22 has fetch built in, so the check needs nothing installed. The login
# page renders without touching the database, which is what makes it a fair
# test of "the server is up" rather than "the database is up".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
