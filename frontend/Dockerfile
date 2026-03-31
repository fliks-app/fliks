FROM node:24.14.0-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 4500

CMD ["npm", "run", "start:docker"]
