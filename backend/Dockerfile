FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV TZ=Asia/Ho_Chi_Minh

CMD ["node", "index.js"]
