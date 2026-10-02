FROM node:22-slim

# Litestream(SQLite の常時バックアップツール)
ARG LITESTREAM_VERSION=0.3.13
ARG TARGETARCH=amd64
ADD https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-${TARGETARCH}.tar.gz /tmp/litestream.tar.gz
RUN tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream && rm /tmp/litestream.tar.gz

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY litestream.yml ./
COPY scripts/docker-entrypoint.sh ./scripts/

# DB(画像を含む全データ)はここに保存される。
# 永続ディスクがある環境ではここにマウントし、無い環境(Render の無料プランなど)では Litestream で外部にバックアップする
RUN mkdir -p /data && chown node:node /data
USER node

EXPOSE 3000
CMD ["./scripts/docker-entrypoint.sh"]
