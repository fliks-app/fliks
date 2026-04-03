FROM node:24.14.0-alpine

RUN apk add --no-cache \
  bash \
  postgresql18-client \
  procps \
  python3 \
  py3-pip \
  ffmpeg \
  intel-media-driver \
  libva-intel-driver \
  mesa-va-gallium \
  libva-utils \
  && apk add --no-cache --virtual .ffsubsync-build \
  gcc \
  musl-dev \
  python3-dev \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync \
  && apk del .ffsubsync-build \
  && wget -q -O /usr/local/bin/alass https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
  && chmod +x /usr/local/bin/alass \
  && ffsubsync --version \
  && alass --help >/dev/null \
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
