FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src

USER node

EXPOSE 7000

# Not `npm start`: the container runs read_only and npm wants to write to its cache.
CMD ["node", "src/server.js"]
