FROM node:24-alpine

RUN addgroup -S freejam && adduser -S freejam -G freejam

WORKDIR /app

COPY package.json freejam-relay.js ./
RUN chown -R freejam:freejam /app
USER freejam

ENV PORT=8787
EXPOSE 8787

CMD ["node", "freejam-relay.js"]
