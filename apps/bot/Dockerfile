# zuna-bot: one file that Node runs, and the cryptography beside it. Build those first,
# which puts them in dist/bot, and build the image from there:
#
#   npm run build:bot && docker build -f apps/bot/Dockerfile dist/bot
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
COPY zuna-bot.mjs zuna_crypto_bg.wasm /opt/zuna-bot/
# The bot's keys go here, and whoever can read them is the bot: a folder of the account
# that runs it, and nobody else's. A volume here starts out that account's.
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
ENV ZUNA_BOT_DATA=/data
VOLUME /data
# Its API, on the container's own 127.0.0.1 unless ZUNA_BOT_HOST says otherwise: the bot's
# code runs in the same network namespace (network_mode: "service:...") to reach it.
EXPOSE 8081
ENTRYPOINT ["node", "/opt/zuna-bot/zuna-bot.mjs"]
CMD ["run"]
