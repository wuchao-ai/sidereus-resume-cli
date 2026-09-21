/**
 * CLI 端到端测试。
 *
 * 前面那些单测都是在进程内直接调函数，验证不了"装配"这一层：
 * 参数怎么解析、退出码怎么定、stdout 与 stderr 分不分得开、提示词到底有没有真的被限制住。
 * 这里用**子进程跑真正的 CLI**，前面挂一个假的 OpenAI 兼容服务，
 * 于是整条链路 —— 参数 → 读 PDF → 组提示词 → HTTP → 解析 → 规范化 → 渲染 —— 全部被覆盖。
 *
 * 有两条断言是单测给不了的：
 *   1. `--json` 时 stdout 必须能被 jq 直接消费（错误信息只能走 stderr）；
 *   2. **在服务端收到的请求体里**检查提示词长度与截断标记 ——
 *      单测只能证明 buildExtractPrompt 拼得对，这里才能证明它真的被用上了。
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_JD_CHARS } from '../src/core/prompts';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const TSX_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const FIXTURES = join(PROJECT_ROOT, 'fixtures');
const SAMPLE_RESUME = join(FIXTURES, 'resume.pdf');

const FAKE_PROFILE = {
  name: '张伟',
  phone: '138-0000-1234',
  email: 'zhangwei@example.com',
  city: '杭州',
  education: [{ school: '浙江大学', major: '软件工程', degree: '本科', graduation_time: '2018.06' }],
  skills: ['TypeScript', 'React', 'Node.js'],
};

const FAKE_REPORT = {
  overall_score: 82,
  skill_score: 88,
  experience_score: 80,
  education_score: 75,
  comment: '技术栈与岗位要求高度重合。',
  interview_questions: ['请介绍你做过的最复杂的性能优化。'],
};

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let server: Server;
let baseUrl = '';
/** 服务端最近一次收到的请求体，用来检查"实际发出去的提示词" */
let lastRequest: { messages?: Array<{ role: string; content: string }> } | null = null;
let requestCount = 0;
let tempDir = '';

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(TSX_BIN, ['src/cli.ts', ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        AI_PROVIDER: 'openai', // 本地 .env 的 Codex 配置不能改变 HTTP 测试路径
        NO_COLOR: '1', // 断言面对纯文本，不用逐处剥 ANSI
        AI_MAX_RETRIES: '1', // 假服务不应触发重试，真触发了也别等太久
        ...env,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function lastUserPrompt(): string {
  return lastRequest?.messages?.find((message) => message.role === 'user')?.content ?? '';
}

/** 截出提示词里某一段分隔符包裹的内容 */
function sectionBetween(text: string, open: string, close = '<<<结束>>>'): string {
  const start = text.indexOf(open);
  if (start === -1) return '';
  const end = text.indexOf(close, start + open.length);
  return end === -1 ? text.slice(start) : text.slice(start, end);
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requestCount += 1;
      try {
        lastRequest = JSON.parse(body) as typeof lastRequest;
      } catch {
        lastRequest = null;
      }

      // 按提示词内容判断这次是 extract 还是 score，省得维护两套假服务
      const payload = lastUserPrompt().includes('抽取结构化信息') ? FAKE_PROFILE : FAKE_REPORT;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'fake-model',
          choices: [{ message: { content: JSON.stringify(payload) } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/v1`;

  tempDir = mkdtempSync(join(tmpdir(), 'resume-cli-e2e-'));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe('CLI 端到端', () => {
  it('参数非法时退出码为 2，且错误只出现在 stderr', async () => {
    const result = await runCli(['parse', SAMPLE_RESUME, '--lines', '-5', '--json']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('需要是大于 0 的整数');
    // stdout 必须干净：这就是 --json | jq 能吃的前提
    expect(result.stdout).toBe('');
  }, 30_000);

  it('文件不存在时退出码为 3，并给出错误码', async () => {
    const result = await runCli(['parse', join(FIXTURES, 'does-not-exist.pdf'), '--json']);

    expect(result.code).toBe(3);
    expect(result.stderr).toContain('FILE_NOT_FOUND');
    expect(result.stdout).toBe('');
  }, 30_000);

  it('缺少 API Key 时退出码为 4，并提示可以先用 --mock', async () => {
    const result = await runCli(['extract', SAMPLE_RESUME], {
      OPENAI_API_KEY: '',
      AI_API_KEY: '',
    });

    expect(result.code).toBe(4);
    expect(result.stderr).toContain('未找到 AI API Key');
    expect(result.stderr).toContain('--mock');
  }, 30_000);

  it('--mock 全流程不联网，--json 输出可直接解析', async () => {
    const before = requestCount;
    const result = await runCli(['extract', SAMPLE_RESUME, '--mock', '--json']);

    expect(result.code).toBe(0);
    const profile = JSON.parse(result.stdout) as typeof FAKE_PROFILE;
    expect(profile.skills.length).toBeGreaterThan(0);
    // 离线模式下不该发出任何 HTTP 请求
    expect(requestCount).toBe(before);
  }, 30_000);

  it('接上真实 AI 链路：extract 的 JSON 输出符合契约', async () => {
    const result = await runCli(['extract', SAMPLE_RESUME, '--json'], {
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: 'fake-model',
    });

    expect(result.code).toBe(0);

    const profile = JSON.parse(result.stdout) as typeof FAKE_PROFILE;
    expect(profile.name).toBe('张伟');
    expect(profile.skills).toEqual(['TypeScript', 'React', 'Node.js']);
    // 结果之外的东西（日志、耗时）一个字都不该混进 stdout
    expect(result.stdout.trim().startsWith('{')).toBe(true);

    // 正常长度的简历不该被截断
    expect(lastUserPrompt()).toContain('张伟');
    expect(lastUserPrompt()).not.toContain('已被截断');
  }, 30_000);

  it('超长 JD 被拦截：发出去的提示词有界，且明确告知模型内容被切过', async () => {
    const jdPath = join(tempDir, 'huge-jd.txt');
    writeFileSync(jdPath, '岗位要求：熟悉 TypeScript 与 React。'.repeat(3000), 'utf8');

    const result = await runCli(['score', SAMPLE_RESUME, '--jd', jdPath, '--json'], {
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: baseUrl,
      OPENAI_MODEL: 'fake-model',
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty('overall_score');

    // 面向用户：stderr 上有明确告警，而不是让人对着一个语焉不详的 400 发呆
    expect(result.stderr).toContain('JD 文本');
    expect(result.stderr).toContain('已截断');

    // 面向模型：真正发出去的 JD 段落必须被截到上限附近，且带着截断标记
    const user = lastUserPrompt();
    const jdSection = sectionBetween(user, '<<<岗位描述>>>');
    expect(jdSection).toContain('已被截断');
    expect(jdSection).toContain('不要推测或补全被截断的部分');
    // 上限本身 + 标记文字的开销
    expect(jdSection.length).toBeLessThan(MAX_JD_CHARS + 400);
    // 确认造的数据确实远超上限，否则这条断言是空转的
    expect(readFileSync(jdPath, 'utf8').length).toBeGreaterThan(MAX_JD_CHARS * 3);
  }, 60_000);
});
