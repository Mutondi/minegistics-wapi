FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json yarn.lock* package-lock.json* ./
RUN if [ -f yarn.lock ]; then yarn install --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci; \
    else npm install; fi

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Production-only deps
COPY package.json yarn.lock* package-lock.json* ./
RUN if [ -f yarn.lock ]; then yarn install --production --frozen-lockfile; \
    elif [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev; fi

COPY --from=builder /app/dist ./dist

# Auth state lives on a Railway volume mounted at /data
RUN mkdir -p /data/auth-state
ENV WA_AUTH_DIR=/data/auth-state

EXPOSE 3000
CMD ["node", "dist/index.js"]
