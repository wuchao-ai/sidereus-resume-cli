import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiConfig } from './config.js';
import type { ChatRequest, ChatResult, ChatUsage } from './ai.js';
import { CliError } from './errors.js';

/** 使用官方 CLI 管理登录和刷新令牌；本工具不读取 auth.json。 */
export async function completeWithCodex(config: AiConfig, request: ChatRequest): Promise<ChatResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'resume-codex-'));
  const started = Date.now();
  try {
    return await new Promise<ChatResult>((resolve, reject) => {
      const env = { ...process.env };
      // 明确使用 Codex 保存的登录，避免外层 API Key 意外切换认证方式。
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      const child = spawn(config.codexBin ?? 'codex', [
        'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--disable', 'shell_tool',
        '--model', config.model, '--json', '-',
      ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let content = '';
      let usage: ChatUsage | null = null;
      let buffer = '';
      let completed = false;
      let failed = false;
      let timedOut = false;
      let bytes = 0;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, config.timeoutMs);
      const consume = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') content = event.item.text;
          if (event.type === 'turn.failed' || event.type === 'error') failed = true;
          if (event.type === 'turn.completed') {
            completed = true;
            if (event.usage) {
              const input = event.usage.input_tokens ?? 0;
              const output = event.usage.output_tokens ?? 0;
              usage = { promptTokens: input, completionTokens: output, totalTokens: input + output };
            }
          }
        } catch { failed = true; }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 4 * 1024 * 1024) { failed = true; child.kill('SIGKILL'); return; }
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          consume(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
        }
      });
      // Codex 调试输出可能包含请求上下文，不转发到用户终端或日志。
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => {
        clearTimeout(timer);
        reject(new CliError('CONFIG_MISSING', '无法启动 Codex CLI', {
          hint: '安装可用的 Codex CLI，或设置 CODEX_BIN 为执行文件路径；随后执行 codex login。',
        }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        consume(buffer);
        if (timedOut || code !== 0 || failed || !completed || !content.trim()) {
          reject(new CliError('AI_REQUEST_FAILED', timedOut ? 'Codex 请求超时' : 'Codex 调用未成功完成', {
            hint: '检查 Codex 登录状态、网络和模型访问权限。可执行 codex login status；超时可调整 AI_TIMEOUT_MS。',
          }));
          return;
        }
        resolve({ content, model: config.model, usage, durationMs: Date.now() - started, attempts: 1 });
      });
      child.stdin.end(`${request.system}\n\n只处理下面提供的数据，不调用工具、不读取文件。只返回要求的 JSON 对象。\n\n${request.user}`);
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
