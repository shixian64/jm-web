ARG NODE_IMAGE=node:22.23.2-alpine3.24
FROM ${NODE_IMAGE}

WORKDIR /app

# 发布制品可能在严格 umask 下解包，不能继承宿主机的 root-only 模式后
# 再交给非 root 进程读取。构建时显式把全部运行文件归 node 用户所有。
COPY --chown=node:node package.json server.js LICENSE ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

# 官方 Node 镜像内置 uid/gid 1000 的 node 用户。提前创建并收紧数据目录权限，
# 使命名卷首次初始化后仍可由最终的非 root 进程写入。
RUN mkdir -p /app/data \
    && chown node:node /app/data \
    && chmod 0700 /app/data

ENV NODE_ENV=production \
    PORT=3210 \
    HOST=0.0.0.0 \
    JMW_DATA_DIR=/app/data

EXPOSE 3210

VOLUME ["/app/data"]

USER node

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const n=Number(process.env.PORT||3210),p=Number.isInteger(n)&&n>=1&&n<=65535?n:3210;fetch('http://127.0.0.1:'+p+'/healthz',{method:'HEAD',signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
