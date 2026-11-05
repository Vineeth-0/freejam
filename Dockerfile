FROM node:20-alpine

WORKDIR /app

COPY package.json freejam-relay.js ./

ENV PORT=8787
EXPOSE 8787

CMD ["node", "freejam-relay.js"]
