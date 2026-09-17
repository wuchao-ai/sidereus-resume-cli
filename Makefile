# resume-cli 常用命令
# 用法：make <target>；直接执行 make 会打印所有可用目标

NODE ?= node
NPM  ?= npm
CLI   = $(NODE) bin/resume-cli.js

.DEFAULT_GOAL := help
.PHONY: help install build test typecheck fixture demo demo-json docker clean

help: ## 显示所有可用命令
	@echo "resume-cli 可用命令："
	@# 用 awk 单条实现：macOS 自带的 BSD grep 对这里的正则写法不兼容
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## 安装依赖（会自动执行 build）
	$(NPM) install

build: ## 编译 TypeScript 到 dist/
	$(NPM) run build

test: ## 运行全部单元测试
	$(NPM) test

typecheck: ## 只做类型检查，不产出文件
	$(NPM) run typecheck

fixture: ## 用无头 Chrome 重新生成示例简历 PDF
	$(NPM) run fixture

demo: ## 用示例数据依次跑通 parse / extract / score（extract 与 score 走离线模式）
	@echo "\n=== 1/3 parse：解析 PDF 文本 ===\n"
	@$(CLI) parse fixtures/resume.pdf
	@echo "\n=== 2/3 extract：结构化提取（--mock，无需 API Key）===\n"
	@$(CLI) extract fixtures/resume.pdf --mock
	@echo "\n=== 3/3 score：JD 匹配评分（--mock，无需 API Key）===\n"
	@$(CLI) score fixtures/resume.pdf --jd fixtures/jd.txt --mock

demo-json: ## 同 demo，但把 JSON 结果保存到 output/
	@mkdir -p output
	@$(CLI) parse fixtures/resume.pdf --json --output output/parse.json > /dev/null
	@$(CLI) extract fixtures/resume.pdf --mock --json --output output/extract.json > /dev/null
	@$(CLI) score fixtures/resume.pdf --jd fixtures/jd.txt --mock --json --output output/score.json > /dev/null
	@echo "结果已写入 output/parse.json、output/extract.json、output/score.json"

docker: ## 构建 Docker 镜像
	docker build -t resume-cli:latest .

clean: ## 清理构建产物与测试产物
	rm -rf dist coverage output/*.json result.json
