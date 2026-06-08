FROM ubuntu:24.04

# Install Node.js 24
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && apt-get purge -y curl gnupg \
  && rm -rf /var/lib/apt/lists/*

# Install runtime dependencies + Intel GPU drivers + FFmpeg
RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  postgresql-client \
  procps \
  python3 \
  python3-pip \
  python3-venv \
  ffmpeg \
  libchromaprint-tools \
  tesseract-ocr \
  tesseract-ocr-eng \
  tesseract-ocr-fra \
  tesseract-ocr-spa \
  tesseract-ocr-deu \
  tesseract-ocr-ita \
  tesseract-ocr-por \
  tesseract-ocr-nld \
  tesseract-ocr-jpn \
  tesseract-ocr-kor \
  tesseract-ocr-chi-sim \
  tesseract-ocr-rus \
  tesseract-ocr-ara \
  tesseract-ocr-pol \
  tesseract-ocr-tur \
  tesseract-ocr-swe \
  tesseract-ocr-dan \
  tesseract-ocr-nor \
  tesseract-ocr-fin \
  intel-media-va-driver-non-free \
  intel-opencl-icd \
  libmfx-gen1.2 \
  libvpl2 \
  vainfo \
  wget \
  ca-certificates \
  gcc \
  python3-dev \
  libc6-dev \
  && python3 -m pip install --no-cache-dir --break-system-packages ffsubsync pgsrip \
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

EXPOSE 4848

CMD ["npm", "run", "start:dev"]
