FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
ENV DATA_DIR=/app/data
EXPOSE 8080
CMD ["node", "server.js"]
