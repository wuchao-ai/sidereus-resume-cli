import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readJdFile, writeJsonFile } from '../src/core/io';
import { CliError } from '../src/core/errors';
import { parseEnvFile, resolveAiConfig, describeAiConfig } from '../src/core/config';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'resume-cli-io-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('readJdFile', () => {
  it('读取正常 JD 文本', async () => {
    const path = join(workDir, 'jd.txt');
    await writeFile(path, '\n\n  全栈工程师，要求熟悉 TypeScript  \n\n');
    const result = await readJdFile(path);
    expect(result.text).toBe('全栈工程师，要求熟悉 TypeScript');
    expect(result.chars).toBeGreaterThan(0);
  });

  it('文件不存在 → JD_FILE_NOT_FOUND', async () => {
    await expect(readJdFile(join(workDir, 'nope.txt'))).rejects.toMatchObject({
      code: 'JD_FILE_NOT_FOUND',
    });
  });

  it('空文件 → JD_EMPTY', async () => {
    const path = join(workDir, 'empty-jd.txt');
    await writeFile(path, '');
    await expect(readJdFile(path)).rejects.toMatchObject({ code: 'JD_EMPTY' });
  });

  it('只有空白字符 → JD_EMPTY', async () => {
    const path = join(workDir, 'blank-jd.txt');
    await writeFile(path, '   \n\t\n  ');
    await expect(readJdFile(path)).rejects.toMatchObject({ code: 'JD_EMPTY' });
  });

  it('传目录 → JD_FILE_NOT_FOUND', async () => {
    await expect(readJdFile(workDir)).rejects.toMatchObject({ code: 'JD_FILE_NOT_FOUND' });
  });

  it('二进制内容 → JD_EMPTY（提示不是纯文本）', async () => {
    const path = join(workDir, 'binary.txt');
    await writeFile(path, Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x81, 0x82, 0x83]));
    await expect(readJdFile(path)).rejects.toMatchObject({ code: 'JD_EMPTY' });
  });
});

describe('writeJsonFile', () => {
  it('写出带缩进、以换行结尾的 JSON', async () => {
    const path = join(workDir, 'out', 'result.json');
    const written = await writeJsonFile(path, { name: '张伟', score: 82 });

    expect(written).toBe(path);
    const content = await readFile(path, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(JSON.parse(content)).toEqual({ name: '张伟', score: 82 });
    expect(content).toContain('\n  "name"'); // 确认是 2 空格缩进而非压缩输出
  });

  it('自动创建不存在的父目录', async () => {
    const path = join(workDir, 'a', 'b', 'c', 'deep.json');
    await expect(writeJsonFile(path, { ok: true })).resolves.toBe(path);
  });

  it('目标路径不可写时 → OUTPUT_WRITE_FAILED', async () => {
    // 把文件写到已存在的文件下面，必然失败
    const blocker = join(workDir, 'blocker');
    await writeFile(blocker, 'x');
    await expect(writeJsonFile(join(blocker, 'sub', 'x.json'), {})).rejects.toBeInstanceOf(CliError);
  });
});

describe('config', () => {
  it('parseEnvFile 支持注释、引号与 export 前缀', () => {
    const parsed = parseEnvFile(
      [
        '# 这是注释',
        'OPENAI_API_KEY=sk-abc',
        'export OPENAI_MODEL="gpt-4o"',
        "OPENAI_BASE_URL='https://api.example.com/v1'",
        '',
        'INVALID_LINE',
      ].join('\n'),
    );

    expect(parsed.OPENAI_API_KEY).toBe('sk-abc');
    expect(parsed.OPENAI_MODEL).toBe('gpt-4o');
    expect(parsed.OPENAI_BASE_URL).toBe('https://api.example.com/v1');
    expect(parsed.INVALID_LINE).toBeUndefined();
  });

  it('缺 API Key 时抛出 CONFIG_MISSING 且提示里含 --mock', () => {
    const saved = { key: process.env.OPENAI_API_KEY, alt: process.env.AI_API_KEY };
    delete process.env.OPENAI_API_KEY;
    delete process.env.AI_API_KEY;

    try {
      resolveAiConfig();
      throw new Error('应当抛出异常');
    } catch (error) {
      expect((error as CliError).code).toBe('CONFIG_MISSING');
      expect((error as CliError).hint).toContain('--mock');
    } finally {
      if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
      if (saved.alt !== undefined) process.env.AI_API_KEY = saved.alt;
    }
  });

  it('describeAiConfig 隐藏 Key 主体', () => {
    const text = describeAiConfig({
      apiKey: 'sk-1234567890abcdef',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      timeoutMs: 1000,
      maxRetries: 1,
    });
    expect(text).not.toContain('567890ab');
    expect(text).toContain('****');
    expect(text).toContain('gpt-4o-mini');
  });

  it('baseUrl 末尾斜杠会被去掉，避免拼出双斜杠', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.OPENAI_BASE_URL = 'https://api.example.com/v1///';
    try {
      expect(resolveAiConfig().baseUrl).toBe('https://api.example.com/v1');
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_BASE_URL;
    }
  });
});
