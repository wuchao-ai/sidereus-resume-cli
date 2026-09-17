/**
 * 结果输出。
 *
 * 统一处理三个互相正交的诉求，避免每个命令各写一套：
 *   · 人看     → 渲染函数产出的排版文本
 *   · 机器看   → --json，纯 JSON 写到 stdout（日志走 stderr，两边不互相污染）
 *   · 存档     → --output，把同样的 JSON 落盘
 *
 * 同时支持两种一起用：`--json --output r.json` 既打印又保存，适合边看边留档。
 */

import { writeJsonFile } from './io.js';
import { logger } from './logger.js';

export interface EmitOptions {
  /** 输出纯 JSON（便于管道、jq 处理） */
  json: boolean;
  /** 结果文件路径 */
  output?: string | undefined;
  /** 人看模式的渲染函数，只在非 --json 时调用 */
  render: () => string;
  /** 结果文件的用途描述，用于日志文案 */
  label?: string;
}

/**
 * 输出结果。
 * @returns 结果文件路径（如果写了文件）
 */
export async function emitResult(data: unknown, options: EmitOptions): Promise<string | undefined> {
  let outputPath: string | undefined;

  if (options.output) {
    outputPath = await writeJsonFile(options.output, data);
    logger.info(`结果已保存到 ${outputPath}`);
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${options.render()}\n`);
  }

  return outputPath;
}
