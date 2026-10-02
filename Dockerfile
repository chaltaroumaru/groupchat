FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# DB と画像はここに保存されるので、ホスティング先でボリューム(永続ディスク)をマウントする
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node

EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
