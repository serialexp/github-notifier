FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

RUN corepack enable && pnpm install --frozen-lockfile --prod --ignore-scripts

COPY dist/forwarder.js ./dist/

CMD ["node", "dist/forwarder.js"]
