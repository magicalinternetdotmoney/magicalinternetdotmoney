FROM node:20-alpine AS build
WORKDIR /app
COPY sdk/searchergap/package.json sdk/searchergap/package-lock.json ./sdk/searchergap/
RUN cd sdk/searchergap && npm ci --no-audit --no-fund
COPY sdk/searchergap/tsconfig.json ./sdk/searchergap/
COPY sdk/searchergap/bin ./sdk/searchergap/bin
COPY sdk/searchergap/src ./sdk/searchergap/src
RUN cd sdk/searchergap && npm run build

FROM node:20-alpine
WORKDIR /app
COPY sdk/searchergap/package.json sdk/searchergap/package-lock.json ./sdk/searchergap/
RUN cd sdk/searchergap && npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/sdk/searchergap/dist ./sdk/searchergap/dist
ENV CRANK_POLL_MS=60000
CMD ["node", "sdk/searchergap/dist/bin/searchergap.js", "crank"]