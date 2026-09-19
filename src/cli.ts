#!/usr/bin/env node
/**
 * CLI 入口。
 *
 * 这一层只做四件事：解析参数、装配依赖、调度命令、统一处理错误。
 * 业务逻辑一律不写在这里 —— 否则命令一多就会变成一坨 if-else。
 */

import { Command, CommanderError, Option } from 'commander';
import { loadEnvFile } from './core/config.js';
import { logger, type LogLevel } from './core/logger.js';
import { setColorEnabled, isColorEnabled } from './core/ui.js';
import { toCliError } from './core/errors.js';
import { runParse } from './commands/parse.js';
import { runExtract } from './commands/extract.js';
import { runScore } from './commands/score.js';
import type { CommonOptions } from './commands/common.js';
import { parsePositiveInt } from './commands/common.js';

const VERSION = '1.0.0';

/** 三个命令共享的输出开关，避免每个命令重复声明一遍 */
function withCommonOptions(command: Command): Command {
  return command
    .option('--json', '输出纯 JSON，便于管道或 jq 处理')
    .addOption(new Option('-o, --output <path>', '把结果保存为 JSON 文件，例如 -o result.json'))
    .option('--mock', '离线模式：使用内置规则引擎，不调用大模型（无需 API Key）')
    .option('--model <name>', '覆盖 OPENAI_MODEL，例如 --model gpt-4o');
}

function toCommonOptions(options: Record<string, unknown>): CommonOptions {
  return {
    json: options.json === true,
    output: typeof options.output === 'string' ? options.output : undefined,
    mock: options.mock === true,
    model: typeof options.model === 'string' ? options.model : undefined,
    verbose: options.verbose === true,
    quiet: options.quiet === true,
    color: options.color !== false,
  };
}

/** 根据全局开关配置日志级别与颜色 */
function configureRuntime(options: Record<string, unknown>): void {
  let level: LogLevel = 'info';
  if (options.verbose === true) level = 'debug';
  if (options.quiet === true) level = 'error';

  logger.setLevel(level);
  const envNoColor = Boolean(process.env.NO_COLOR);
  setColorEnabled(options.color !== false && !envNoColor);
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name('resume-cli')
    .description(
      [
        'AI 简历解析命令行工具：读取 PDF 简历，提取结构化信息，并与岗位描述做匹配评分。',
        '',
        '示例：',
        '  $ resume-cli parse ./resume.pdf',
        '  $ resume-cli extract ./resume.pdf',
        '  $ resume-cli score ./resume.pdf --jd ./jd.txt',
        '  $ resume-cli extract ./resume.pdf --mock --json',
      ].join('\n'),
    )
    .version(VERSION, '-V, --version', '显示版本号')
    .option('-v, --verbose', '打印调试日志（含请求耗时、AI 配置等）')
    .option('-q, --quiet', '静默模式，只输出错误')
    .option('--no-color', '关闭彩色输出（管道场景推荐）')
    // 关闭 commander 的默认退出行为，交给下面的统一错误处理决定退出码
    .exitOverride()
    .showHelpAfterError('（使用 --help 查看完整用法）');

  program
    .command('parse')
    .description('解析 PDF 简历并提取纯文本（不调用 AI）')
    .argument('<pdf_path>', 'PDF 简历文件路径')
    .option('--full', '打印完整文本，不做行数截断')
    .option('--lines <n>', '预览行数上限，必须是正整数（默认 40）', parsePositiveInt)
    .addOption(new Option('-o, --output <path>', '把结果保存为 JSON 文件，例如 -o result.json'))
    .option('--json', '输出纯 JSON，便于管道或 jq 处理')
    .action(async (pdfPath: string, options: Record<string, unknown>, command: Command) => {
      const globals = command.optsWithGlobals();
      configureRuntime(globals);
      await runParse(pdfPath, {
        ...toCommonOptions(globals),
        full: options.full === true,
        lines: typeof options.lines === 'number' ? options.lines : undefined,
      });
    });

  withCommonOptions(
    program
      .command('extract')
      .description('调用 AI 从简历中提取结构化信息（姓名/联系方式/教育经历/技能）')
      .argument('<pdf_path>', 'PDF 简历文件路径'),
  ).action(async (pdfPath: string, options: Record<string, unknown>, command: Command) => {
    const globals = command.optsWithGlobals();
    configureRuntime(globals);
    await runExtract(pdfPath, toCommonOptions(globals));
  });

  withCommonOptions(
    program
      .command('score')
      .description('调用 AI 评估简历与岗位描述（JD）的匹配度并给出评分')
      .argument('<pdf_path>', 'PDF 简历文件路径')
      .requiredOption('--jd <jd_path>', '岗位描述文本文件路径（.txt / .md）'),
  ).action(async (pdfPath: string, options: Record<string, unknown>, command: Command) => {
    const globals = command.optsWithGlobals();
    configureRuntime(globals);
    await runScore(pdfPath, {
      ...toCommonOptions(globals),
      jd: options.jd as string,
    });
  });

  return program;
}

/** 统一错误输出：错误码 + 说明 + 可执行的建议 */
function reportError(error: unknown, verbose: boolean): number {
  const cliError = toCliError(error);

  process.stderr.write(`\n${isColorEnabled() ? '\u001b[31m✖\u001b[0m' : '✖'} ${cliError.message}\n`);
  process.stderr.write(`  ${isColorEnabled() ? '\u001b[90m' : ''}错误码：${cliError.code}${isColorEnabled() ? '\u001b[0m' : ''}\n`);

  if (cliError.hint) {
    const indented = cliError.hint
      .split('\n')
      .map((line) => `      ${line}`)
      .join('\n');
    process.stderr.write(`  ${isColorEnabled() ? '\u001b[36m提示：\u001b[0m' : '提示：'}\n${indented}\n`);
  }

  if (verbose && cliError.cause) {
    const cause = cliError.cause as Error;
    process.stderr.write(`\n${cause.stack ?? String(cause)}\n`);
  } else if (cliError.cause) {
    process.stderr.write(`  ${isColorEnabled() ? '\u001b[90m' : ''}（加 --verbose 查看详细堆栈）${isColorEnabled() ? '\u001b[0m' : ''}\n`);
  }

  process.stderr.write('\n');
  return cliError.exitCode;
}

async function main(): Promise<void> {
  // .env 只在当前进程缺该变量时生效，真实环境变量优先级更高
  const envPath = loadEnvFile();
  if (envPath) logger.debug(`已加载环境变量文件：${envPath}`);

  const program = buildProgram();
  const argv = process.argv;

  try {
    await program.parseAsync(argv);
  } catch (error) {
    // --help / --version 走的是"抛异常"的退出路径，退出码为 0，属于正常流程
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return;
      // 用法错误（缺参数、未知命令）：commander 已打印信息，这里只统一退出码
      process.exitCode = 2;
      return;
    }
    const verbose = argv.includes('--verbose') || argv.includes('-v');
    process.exitCode = reportError(error, verbose);
  }
}

// 兜底：任何漏网的异常都不该让用户看到一段裸栈
process.on('unhandledRejection', (reason) => {
  process.exitCode = reportError(reason, false);
});

void main();
