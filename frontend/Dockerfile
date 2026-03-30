FROM node:22-bookworm-slim

WORKDIR /app

EXPOSE 4500

CMD ["sh", "-c", "test -x node_modules/.bin/ng || npm ci; exec npm run start:docker"]
