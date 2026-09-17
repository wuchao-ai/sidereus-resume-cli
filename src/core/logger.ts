/**
 * 日志器。
 *
 * 关键约定：**日志一律写 stderr，业务结果才写 stdout**。
 * 这样 `resume-cli extract r.pdf > out.json` 拿到的永远是干净可解析的 JSON，
 * 日志信息依然能在终端被看到 —— 这是 CLI 工具能否被脚本复用的分水岭。
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const supportsColor = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stderr.isTTY);
};

export interface LoggerOptions {
  level?: LogLevel;
  /** 是否输出带时间戳的前缀，默认只在 debug 级别打开 */
  timestamps?: boolean;
}

export class Logger {
  private level: LogLevel;
  private readonly timestamps: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.timestamps = options.timestamps ?? false;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVEL_WEIGHT[level] <= LEVEL_WEIGHT[this.level];
  }

  private write(level: Exclude<LogLevel, 'silent'>, label: string, color: number, message: string): void {
    if (!this.enabled(level)) return;
    const parts: string[] = [];
    if (this.timestamps) parts.push(new Date().toISOString());
    parts.push(supportsColor() ? `\u001b[${color}m${label}\u001b[0m` : label);
    parts.push(message);
    process.stderr.write(`${parts.join(' ')}\n`);
  }

  error(message: string): void {
    this.write('error', '✖ error', 31, message);
  }

  warn(message: string): void {
    this.write('warn', '▲ warn', 33, message);
  }

  info(message: string): void {
    this.write('info', '· info', 36, message);
  }

  debug(message: string): void {
    this.write('debug', '· debug', 90, message);
  }
}

/** 全局单例，由 CLI 入口根据 --verbose / --quiet 调整级别。 */
export const logger = new Logger();
