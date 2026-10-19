FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY collector ./collector
COPY ledger ./ledger
ENV PORT=4318 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 4318
USER node
CMD ["node", "collector/server.js"]
