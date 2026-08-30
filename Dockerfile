FROM node:20-alpine

WORKDIR /app

COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3210

EXPOSE 3210

VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3210)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
