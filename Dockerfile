FROM node:22-alpine

WORKDIR /app

COPY package.json server.js LICENSE ./
COPY lib ./lib
COPY public ./public

ENV NODE_ENV=production \
    PORT=3210 \
    HOST=0.0.0.0 \
    JMW_DATA_DIR=/app/data

EXPOSE 3210

VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const n=Number(process.env.PORT||3210),p=Number.isInteger(n)&&n>=1&&n<=65535?n:3210;fetch('http://127.0.0.1:'+p+'/healthz',{method:'HEAD',signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
