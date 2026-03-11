FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY 404.jpg ./404.jpg

USER node

EXPOSE 5060
CMD ["node", "src/server.js"]
