/**
 * 统一错误体系。
 *
 * 设计目标：任何一个失败路径都必须能回答三个问题——
 *   1. 出了什么问题（code + message）
 *   2. 用户接下来该做什么（hint）
 *   3. 脚本/CI 如何区分失败类型（exitCode）
 *
 * 退出码约定见 README「退出码」一节，便于 shell 脚本按类型分支处理。
 */

export type ErrorCode =
  | 'FILE_NOT_FOUND'
  | 'NOT_A_PDF'
  | 'PDF_UNREADABLE'
  | 'PDF_EMPTY_TEXT'
  | 'JD_FILE_NOT_FOUND'
  | 'JD_EMPTY'
  | 'CONFIG_MISSING'
  | 'AI_REQUEST_FAILED'
  | 'AI_INVALID_JSON'
  | 'AI_INVALID_SHAPE'
  | 'OUTPUT_WRITE_FAILED'
  | 'UNKNOWN';

/** 错误码 → 进程退出码。分组便于调用方按大类判断。 */
const EXIT_CODE_BY_ERROR: Record<ErrorCode, number> = {
  // 输入文件类
  FILE_NOT_FOUND: 3,
  NOT_A_PDF: 3,
  PDF_UNREADABLE: 3,
  PDF_EMPTY_TEXT: 3,
  JD_FILE_NOT_FOUND: 3,
  JD_EMPTY: 3,
  // 配置类
  CONFIG_MISSING: 4,
  // 远端/模型类
  AI_REQUEST_FAILED: 5,
  AI_INVALID_JSON: 5,
  AI_INVALID_SHAPE: 5,
  // 输出类
  OUTPUT_WRITE_FAILED: 6,
  UNKNOWN: 1,
};

export interface CliErrorOptions {
  /** 给用户的下一步建议，会以 "提示：" 前缀打印 */
  hint?: string;
  /** 原始错误，仅在 --verbose 时打印栈 */
  cause?: unknown;
}

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = EXIT_CODE_BY_ERROR[code];
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** 把任意抛出物归一化为 CliError，避免上层到处写 instanceof 判断。 */
export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    return new CliError('UNKNOWN', error.message, { cause: error });
  }
  return new CliError('UNKNOWN', String(error));
}
