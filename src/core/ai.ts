/**
 * AI 调用层。
 *
 * HTTP 模式对接 OpenAI 兼容的 /chat/completions 协议；
 * Codex 模式交给官方 CLI 管理账号登录并调用模型。
 *
 * 这一层的核心价值是「把不可靠的网络调用变成可靠的函数」：
 *   · 超时控制（不让命令无限挂起）
 *   · 有区分的重试（限流/5xx/网络抖动重试；鉴权失败不重试，重试也没用）
 *   · 错误翻译（把 401 翻译成"你的 Key 不对"，而不是甩一个状态码给用户）
 */

import { completeWithCodex } from './codex.js';
import { CliError } from './errors.js';
import { logger } from './logger.js';
import type { AiConfig } from './config.js';

export interface ChatRequest {
  system: string;
  user: string;
  /** 是否请求模型返回 JSON 对象；不支持该参数的服务会自动降级重试 */
  jsonMode?: boolean;
  temperature?: number;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatResult {
  content: string;
  model: string;
  usage: ChatUsage | null;
  durationMs: number;
  attempts: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 判断一个失败是否值得重试 */
function isRetryable(status: number | undefined, error: unknown): boolean {
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  // 没有状态码说明请求根本没发出去（DNS / 连接重置 / 超时），这类通常可以重试
  const name = (error as Error)?.name;
  return name === 'TimeoutError' || name === 'AbortError' || error instanceof TypeError;
}

/** 把 HTTP 状态码翻译成用户能直接照做的提示 */
function describeHttpFailure(status: number, body: string, baseUrl: string, model: string): CliError {
  const snippet = body.slice(0, 300);

  if (status === 401 || status === 403) {
    return new CliError('AI_REQUEST_FAILED', `AI 服务拒绝了请求（HTTP ${status}）：鉴权失败`, {
      hint: '检查 OPENAI_API_KEY 是否正确/是否过期；若用的是第三方兼容服务，确认 Key 与 OPENAI_BASE_URL 属于同一家。',
    });
  }
  if (status === 404) {
    return new CliError('AI_REQUEST_FAILED', `AI 服务返回 404：接口或模型不存在`, {
      hint: `确认 OPENAI_BASE_URL（当前 ${baseUrl}）是否包含 /v1，以及 OPENAI_MODEL（当前 ${model}）是否为该服务支持的模型名。`,
    });
  }
  if (status === 429) {
    return new CliError('AI_REQUEST_FAILED', `AI 服务限流（HTTP 429），重试后仍未成功`, {
      hint: '降低调用频率，或稍等一会儿再试；也可用 OPENAI_MODEL 换一个额度更宽松的模型。',
    });
  }
  if (status >= 500) {
    return new CliError('AI_REQUEST_FAILED', `AI 服务端错误（HTTP ${status}），重试后仍未成功`, {
      hint: '多半是服务方临时故障，稍后重试即可。',
      cause: new Error(snippet),
    });
  }
  return new CliError('AI_REQUEST_FAILED', `AI 服务返回异常状态（HTTP ${status}）`, {
    hint: `服务返回内容：${snippet || '(空)'}`,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AiClient {
  private readonly config: AiConfig;

  constructor(config: AiConfig) {
    this.config = config;
  }

  /** 带超时与重试的对话补全调用 */
  async complete(request: ChatRequest): Promise<ChatResult> {
    if (this.config.provider === 'codex') return completeWithCodex(this.config, request);
    const { baseUrl, apiKey, model, timeoutMs, maxRetries } = this.config;
    const endpoint = `${baseUrl}/chat/completions`;

    let lastError: unknown;
    let useJsonMode = request.jsonMode ?? false;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      attempts = attempt + 1;
      const startedAt = Date.now();

      const payload: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        temperature: request.temperature ?? 0.2,
      };
      if (useJsonMode) payload.response_format = { type: 'json_object' };

      try {
        logger.debug(`POST ${endpoint}（第 ${attempts} 次，json_mode=${useJsonMode}）`);

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');

          // 有些兼容服务不认 response_format，报 400；这种情况降级为提示词约束，值得再试一次
          if (response.status === 400 && useJsonMode && /response_format|json_object/i.test(body)) {
            logger.warn('当前服务不支持 response_format=json_object，已降级为提示词约束模式');
            useJsonMode = false;
            attempt -= 1; // 降级不算一次失败重试
            continue;
          }

          const error = describeHttpFailure(response.status, body, baseUrl, model);
          if (!isRetryable(response.status, error) || attempt === maxRetries) throw error;

          lastError = error;
          logger.warn(`请求失败（HTTP ${response.status}），准备重试…`);
        } else {
          const json = (await response.json()) as {
            choices?: Array<{ message?: { content?: string | null } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            model?: string;
          };

          const content = json.choices?.[0]?.message?.content;
          if (typeof content !== 'string' || content.trim().length === 0) {
            const error = new CliError('AI_REQUEST_FAILED', 'AI 返回内容为空', {
              hint: '可能触发了内容过滤或模型输出异常，重试或换模型试试。',
            });
            if (attempt === maxRetries) throw error;
            lastError = error;
            logger.warn('AI 返回空内容，准备重试…');
          } else {
            const usage = json.usage
              ? {
                  promptTokens: json.usage.prompt_tokens ?? 0,
                  completionTokens: json.usage.completion_tokens ?? 0,
                  totalTokens: json.usage.total_tokens ?? 0,
                }
              : null;
            const durationMs = Date.now() - startedAt;
            logger.debug(`AI 调用成功，耗时 ${durationMs}ms，tokens=${usage?.totalTokens ?? '未知'}`);
            return { content, model: json.model ?? model, usage, durationMs, attempts };
          }
        }
      } catch (error) {
        if (error instanceof CliError && !isRetryable(undefined, error)) throw error;
        lastError = error;

        if (attempt === maxRetries) break;

        if (error instanceof CliError) {
          // 上面已经打过日志，这里只退避
        } else if ((error as Error)?.name === 'TimeoutError') {
          logger.warn(`请求超时（${timeoutMs}ms），准备重试…`);
        } else {
          logger.warn(`请求异常：${(error as Error)?.message ?? String(error)}，准备重试…`);
        }
      }

      // 指数退避 + 抖动，避免多个并发请求同时重试把对方打死
      const backoff = 400 * 2 ** attempt + Math.floor(Math.random() * 200);
      await sleep(backoff);
    }

    if (lastError instanceof CliError) throw lastError;
    throw new CliError('AI_REQUEST_FAILED', `AI 调用失败，已重试 ${maxRetries} 次仍未成功`, {
      hint: '检查网络连通性（能否访问 OPENAI_BASE_URL），或稍后重试。',
      cause: lastError,
    });
  }
}
