/**
 * 运行配置。
 *
 * 三条原则：
 *   1. 真实环境变量优先于 .env 文件 —— 这样 CI / Docker 里可以覆盖本地配置
 *   2. 配置缺失时报错必须给出"怎么修"，而不是只说"没有 key"
 *   3. 不引入 dotenv 依赖，20 行就能说清楚的事不值得多一个包
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CliError } from './errors.js';

/** 模型供应商的默认接入点，可通过 OPENAI_BASE_URL 覆盖成任意 OpenAI 兼容服务 */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

export interface AiConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

/** 极简 .env 解析：支持 # 注释、引号包裹、export 前缀，不做变量插值 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator === -1) continue;

    const key = withoutExport.slice(0, separator).trim();
    let value = withoutExport.slice(separator + 1).trim();
    if (!key) continue;

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    result[key] = value;
  }
  return result;
}

/**
 * 从 .env 加载配置。
 * 只写入"当前进程里还不存在"的键，保证真实环境变量始终优先。
 */
export function loadEnvFile(cwd = process.cwd()): string | null {
  const envPath = resolve(cwd, '.env');
  if (!existsSync(envPath)) return null;

  let parsed: Record<string, string>;
  try {
    parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  } catch {
    return null; // .env 读不了不该阻断流程，用户可能直接用环境变量
  }

  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return loaded > 0 ? envPath : null;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 读取 AI 相关配置。
 *
 * @param overrides 命令行显式传入的值，优先级最高
 * @throws CliError CONFIG_MISSING 缺少 API Key 时
 */
export function resolveAiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  const apiKey = overrides.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY ?? '';
  if (!apiKey) {
    throw new CliError('CONFIG_MISSING', '未找到 AI API Key', {
      hint: [
        '任选一种方式配置后重试：',
        '  1) 复制 .env.example 为 .env，填入 OPENAI_API_KEY=sk-xxx',
        '  2) 直接导出环境变量：export OPENAI_API_KEY=sk-xxx',
        '  3) 想先看效果？加 --mock 参数，无需 Key 即可跑通全流程。',
      ].join('\n'),
    });
  }

  return {
    apiKey,
    // 兼容 OpenAI 协议的服务（DeepSeek / 通义 / 智谱 / Ollama…）改这一个变量即可切换
    baseUrl: (overrides.baseUrl ?? process.env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: overrides.model ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL,
    timeoutMs: overrides.timeoutMs ?? readPositiveInt('AI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    maxRetries: overrides.maxRetries ?? readPositiveInt('AI_MAX_RETRIES', DEFAULT_MAX_RETRIES),
  };
}

/** 打印当前生效的配置（隐藏 Key 主体），用于 --verbose 自检 */
export function describeAiConfig(config: AiConfig): string {
  const masked = config.apiKey.length > 8 ? `${config.apiKey.slice(0, 4)}****${config.apiKey.slice(-4)}` : '****';
  return `base_url=${config.baseUrl} model=${config.model} key=${masked} timeout=${config.timeoutMs}ms retries=${config.maxRetries}`;
}
