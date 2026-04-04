FROM node:24.14.0-bookworm-slim

# Enable non-free-firmware repo for Intel media drivers
RUN sed -i 's/^Components: main$/Components: main contrib non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  postgresql-client \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  ffmpeg \
  intel-media-va-driver-non-free \
  libmfx-gen1.2 \
  libvpl2 \
  vainfo \
  wget \
  ca-certificates \
  gcc \
  python3-dev \
  libc6-dev \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync \
  && wget -q -O /usr/local/bin/alass https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
  && chmod +x /usr/local/bin/alass \
  && apt-get purge -y wget gcc python3-dev libc6-dev \
  && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=development
ENV CHOKIDAR_USEPOLLING=true

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000

CMD ["npm", "run", "start:dev"]
