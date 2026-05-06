FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  fonts-liberation \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
EXPOSE 4569
CMD ["node", "server.js"]
