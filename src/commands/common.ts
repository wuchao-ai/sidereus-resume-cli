/**
 * 命令间的公共选项定义。
 * 三个命令共享同一套输出/日志开关，集中在这里避免各写各的导致行为不一致。
 */

import { InvalidArgumentError } from 'commander';

export interface CommonOptions {
  /** 输出纯 JSON */
  json?: boolean;
  /** 结果保存路径 */
  output?: string;
  /** 离线模式，不调用大模型 */
  mock?: boolean;
  /** 打印调试日志 */
  verbose?: boolean;
  /** 只保留错误输出 */
  quiet?: boolean;
  /** 强制关闭颜色（管道场景） */
  color?: boolean;
  /** 覆盖模型名 */
  model?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 解析"正整数"型命令行参数（如 --lines）。
 *
 * 必须显式校验的原因：commander 传进来的永远是字符串，而 `Number.parseInt` 失败时返回 NaN、
 * 遇到 `-5` 会老老实实返回 -5。这两者一旦流进 `Array.prototype.slice`，
 * 就会变成"静默显示全部内容"或"悄悄吃掉最后 5 行"—— 用户看不到任何报错，
 * 却拿到了不完整的结果。参数错就要当场报错，不能让它带着错误值往下走。
 */
export function parsePositiveInt(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new InvalidArgumentError(`需要是正整数，收到 "${value}"`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`需要是大于 0 的整数，收到 "${value}"`);
  }
  return parsed;
}
