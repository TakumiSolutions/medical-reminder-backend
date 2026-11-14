# Production image (Back4App Containers, or any Docker host).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=4000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

USER node
EXPOSE 4000

# Create the database if missing and apply migrations, then serve. `exec` lets the server
# receive SIGTERM directly for a clean shutdown.
CMD ["sh", "-c", "node src/db/cli.js setup && exec node src/server.js"]
