FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

EXPOSE 9900

ENV NODE_ENV=production
ENV PORT=9900
ENV DB_PATH=/app/data/taller.db

CMD ["node", "src/app.js"]
