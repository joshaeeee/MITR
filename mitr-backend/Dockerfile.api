FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@10.6.5 --activate
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

EXPOSE 8080
CMD ["node", "dist/src/index.js"]
