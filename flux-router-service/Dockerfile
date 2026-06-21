FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js flux-indexer.js flux-router.js amounts.js ./
COPY public ./public
ENV PORT=8080 NODE_ENV=production NODE_OPTIONS=--max-old-space-size=768
EXPOSE 8080
CMD ["node", "server.js"]