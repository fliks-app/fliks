FROM node:24.14.0-alpine

RUN apk add --no-cache \
  bash \
  postgresql18-client \
  procps \
  && pg_dump --version \
  && psql --version

WORKDIR /app

ENV NODE_ENV=development
ENV CHOKIDAR_USEPOLLING=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
