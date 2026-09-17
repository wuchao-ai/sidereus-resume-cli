# ============================================================
# resume-cli 容器镜像
#
# 采用两阶段构建：builder 里编译 TypeScript，运行阶段只带编译产物和
# 生产依赖 —— 镜像里不会出现 typescript、vitest、源码这些运行时用不到的东西。
#
# 构建：docker build -t resume-cli .
# 运行：docker run --rm -e OPENAI_API_KEY=sk-xxx \
#                  -v "$PWD/fixtures:/data" resume-cli parse /data/resume.pdf
# ============================================================

# ---------- 构建阶段 ----------
FROM node:20-slim AS builder

WORKDIR /app

# 先只拷贝依赖清单，让 npm ci 这一层能被 Docker 缓存复用
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY bin ./bin

# pdfjs 在 Node 环境下不需要浏览器，但如果要跑 fixture 生成脚本则需要；
# 这里只保留 CLI 运行所需内容，镜像更小也更安全
ENTRYPOINT ["node", "bin/resume-cli.js"]
CMD ["--help"]
