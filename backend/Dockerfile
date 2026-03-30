FROM node:22-bookworm-slim

# Nest CLI utilise `ps` pour tree-kill au reload ; absent sur slim, seul le shell
# était tué et Node gardait le port → EADDRINUSE au save.
RUN apt-get update && apt-get install -y --no-install-recommends procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=development
# Avec un volume monté sur le code source, le watch fonctionne mieux avec le polling
ENV CHOKIDAR_USEPOLLING=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
