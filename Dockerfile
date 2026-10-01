# Node ≥ 22.18 才能直接跑 TypeScript（类型剥离），无需构建步骤
FROM node:24-alpine

WORKDIR /app

# 服务端零运行时依赖：只复制源码
COPY package.json ./
COPY server ./server

ENV NODE_ENV=production
ENV PORT=8788
ENV HOST=0.0.0.0
# 运行时不带默认密钥：没设就是开放服务端，启动日志里会提醒
# ENV SERVER_KEY=

EXPOSE 8788

# 健康检查走服务端自己的 /api/health
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/src/index.ts"]
