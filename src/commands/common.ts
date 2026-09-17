/**
 * 命令间的公共选项定义。
 * 三个命令共享同一套输出/日志开关，集中在这里避免各写各的导致行为不一致。
 */

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
