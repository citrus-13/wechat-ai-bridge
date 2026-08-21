FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src

ENV DATA_DIR=/data
ENV CODEX_HOME=/codex-auth
ENV PATH="/app/node_modules/.bin:${PATH}"
VOLUME ["/data"]
USER node
CMD ["node", "--no-warnings", "src/cli.mjs", "cloud"]
