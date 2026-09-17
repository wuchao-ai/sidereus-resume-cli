/**
 * AI 客户端的端到端测试。
 *
 * 不依赖任何外部服务：这里用 node:http 起一个本地服务器扮演 OpenAI 兼容接口，
 * 让真实的 HTTP 请求打过去。这样能覆盖纯单测覆盖不到的部分 ——
 * 请求体到底长什么样、鉴权头带没带、429 之后会不会重试、服务不支持
 * response_format 时会不会降级 —— 这些都是"接上真模型才发现"的问题。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AiClient } from '../src/core/ai';
import { CliError } from '../src/core/errors';
import { logger } from '../src/core/logger';
import type { AiConfig } from '../src/core/config';

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

interface FakeServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

/** 起一个本地假 AI 服务；handler 决定每次请求如何响应 */
async function startFakeServer(
  handler: (attempt: number, res: ServerResponse, body: Record<string, unknown>) => void,
): Promise<FakeServer> {
  const requests: CapturedRequest[] = [];
  let attempt = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      attempt += 1;
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      requests.push({ url: req.url ?? '', authorization: req.headers.authorization, body });
      handler(attempt, res, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('无法获取测试端口');

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function chatCompletion(content: string): unknown {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

/** 收敛测试日志，避免重试告警刷屏 */
logger.setLevel('silent');

const servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function testConfig(baseUrl: string, overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    apiKey: 'sk-test-key',
    baseUrl,
    model: 'test-model',
    timeoutMs: 3000,
    maxRetries: 1,
    ...overrides,
  };
}

describe('AiClient - 正常调用', () => {
  it('解析出内容、用量与模型名', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 200, chatCompletion('{"name":"张伟"}')));
    servers.push(server);

    const client = new AiClient(testConfig(server.baseUrl));
    const result = await client.complete({ system: '你是助手', user: '提取信息', jsonMode: true });

    expect(result.content).toBe('{"name":"张伟"}');
    expect(result.model).toBe('test-model');
    expect(result.usage?.totalTokens).toBe(150);
    expect(result.attempts).toBe(1);
  });

  it('请求打到 /chat/completions，带上鉴权头与消息体', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 200, chatCompletion('{}')));
    servers.push(server);

    await new AiClient(testConfig(server.baseUrl)).complete({ system: 'SYS', user: 'USER' });

    const request = server.requests[0]!;
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.authorization).toBe('Bearer sk-test-key');
    expect(request.body.model).toBe('test-model');
    expect(request.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USER' },
    ]);
  });

  it('开启 jsonMode 时带上 response_format', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 200, chatCompletion('{}')));
    servers.push(server);

    await new AiClient(testConfig(server.baseUrl)).complete({ system: 'S', user: 'U', jsonMode: true });

    expect(server.requests[0]!.body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('AiClient - 错误处理与重试', () => {
  it('401 鉴权失败：不重试，直接给出可操作的提示', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 401, { error: { message: 'invalid api key' } }));
    servers.push(server);

    const client = new AiClient(testConfig(server.baseUrl));

    await expect(client.complete({ system: 'S', user: 'U' })).rejects.toMatchObject({
      code: 'AI_REQUEST_FAILED',
    });
    // 鉴权问题重试没有意义，只应请求一次
    expect(server.requests).toHaveLength(1);
  });

  it('500 后重试成功，并在请求体里保持一致', async () => {
    const server = await startFakeServer((attempt, res) => {
      if (attempt === 1) jsonResponse(res, 500, { error: 'internal' });
      else jsonResponse(res, 200, chatCompletion('{"ok":true}'));
    });
    servers.push(server);

    const result = await new AiClient(testConfig(server.baseUrl)).complete({ system: 'S', user: 'U' });

    expect(result.content).toBe('{"ok":true}');
    expect(result.attempts).toBe(2);
    expect(server.requests).toHaveLength(2);
  });

  it('服务不支持 response_format 时自动降级重试', async () => {
    const server = await startFakeServer((attempt, res, body) => {
      if ('response_format' in body) {
        jsonResponse(res, 400, { error: { message: 'Unsupported parameter: response_format' } });
        return;
      }
      jsonResponse(res, 200, chatCompletion('{"ok":true}'));
    });
    servers.push(server);

    const result = await new AiClient(testConfig(server.baseUrl)).complete({ system: 'S', user: 'U', jsonMode: true });

    expect(result.content).toBe('{"ok":true}');
    expect(server.requests).toHaveLength(2);
    // 降级后的请求不应再带 response_format
    expect(server.requests[1]!.body.response_format).toBeUndefined();
  });

  it('返回空内容时重试，最终失败给出明确错误', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 200, chatCompletion('')));
    servers.push(server);

    await expect(
      new AiClient(testConfig(server.baseUrl, { maxRetries: 1 })).complete({ system: 'S', user: 'U' }),
    ).rejects.toMatchObject({ code: 'AI_REQUEST_FAILED' });
  });

  it('429 限流重试耗尽后报错', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 429, { error: 'rate limited' }));
    servers.push(server);

    const client = new AiClient(testConfig(server.baseUrl, { maxRetries: 1 }));
    await expect(client.complete({ system: 'S', user: 'U' })).rejects.toMatchObject({
      code: 'AI_REQUEST_FAILED',
    });
    expect(server.requests).toHaveLength(2); // 首次 + 1 次重试
  });

  it('404 提示里包含 base_url 与 model，方便排查', async () => {
    const server = await startFakeServer((_, res) => jsonResponse(res, 404, { error: 'not found' }));
    servers.push(server);

    try {
      await new AiClient(testConfig(server.baseUrl)).complete({ system: 'S', user: 'U' });
      throw new Error('应当抛出异常');
    } catch (error) {
      const cliError = error as CliError;
      expect(cliError.code).toBe('AI_REQUEST_FAILED');
      expect(cliError.hint).toContain('test-model');
      expect(cliError.hint).toContain(server.baseUrl);
    }
  });

  it('请求超时会重试并在耗尽后报错', async () => {
    // 服务端故意不响应，让客户端的 AbortSignal 超时生效
    const server = await startFakeServer(() => {
      /* 不调用 res.end() */
    });
    servers.push(server);

    const client = new AiClient(testConfig(server.baseUrl, { timeoutMs: 150, maxRetries: 1 }));
    await expect(client.complete({ system: 'S', user: 'U' })).rejects.toMatchObject({
      code: 'AI_REQUEST_FAILED',
    });
  });
});
