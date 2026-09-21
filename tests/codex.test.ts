import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { completeWithCodex } from '../src/core/codex';
import { resolveAiConfig } from '../src/core/config';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'codex-adapter-test-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function fake(body: string) {
  const path = join(dir, `fake-${Math.random()}.cjs`);
  await writeFile(path, `#!/usr/bin/env node\n${body}`);
  await chmod(path, 0o700);
  return path;
}

it('Codex 配置不需要 API Key，默认模型是指定的 Luna', () => {
  const config = resolveAiConfig({ provider: 'codex', apiKey: '' });
  expect(config.model).toBe('gpt-5.6-luna');
  expect(config.apiKey).toBe('');
});

it('通过 stdin 传递数据，保留模型参数并消费完成事件与用量', async () => {
  const bin = await fake(`
    let input = '';
    process.stdin.on('data', x => input += x);
    process.stdin.on('end', () => {
      if (!input.includes('简历数据') || !process.argv.includes('gpt-5.6-luna') || process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY) process.exit(2);
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"name":"测试"}'}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:10}}));
    });`);
  const result = await completeWithCodex(resolveAiConfig({provider:'codex', codexBin:bin}), {system:'返回JSON',user:'简历数据'});
  expect(JSON.parse(result.content)).toEqual({name:'测试'});
  expect(result.usage?.totalTokens).toBe(30);
});

it('进程存在但没有成功完成事件时必须失败', async () => {
  const bin = await fake(`console.log(JSON.stringify({type:'turn.failed',error:{message:'auth failed'}}));`);
  await expect(completeWithCodex(resolveAiConfig({provider:'codex',codexBin:bin}), {system:'',user:''})).rejects.toMatchObject({code:'AI_REQUEST_FAILED'});
});

it('可执行文件不存在时给出配置错误', async () => {
  await expect(completeWithCodex(resolveAiConfig({provider:'codex',codexBin:join(dir,'missing')}), {system:'',user:''})).rejects.toMatchObject({code:'CONFIG_MISSING'});
});

it('超时终止子进程并报告失败', async () => {
  const bin = await fake('setInterval(() => {}, 1000);');
  await expect(completeWithCodex(resolveAiConfig({provider:'codex',codexBin:bin,timeoutMs:100}), {system:'',user:''})).rejects.toMatchObject({code:'AI_REQUEST_FAILED',message:'Codex 请求超时'});
});
