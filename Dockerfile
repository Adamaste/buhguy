FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY bin ./bin
COPY db ./db
RUN mkdir -p /app/.receipt-collector
CMD ["node", "./bin/scheduler.js"]
