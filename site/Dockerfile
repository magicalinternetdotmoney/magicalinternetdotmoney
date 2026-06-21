FROM node:20-alpine
WORKDIR /app
# install deps (web3.js + spl-token for the deposit/withdraw tx builder)
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js txbuild.js fluxbeam.js fluxbeam-lut.js patch-metadata.js backfill.js init-hook-metas.js ./
COPY public ./public
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
