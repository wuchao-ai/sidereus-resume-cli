import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePdf } from '../src/core/pdf';
import { CliError } from '../src/core/errors';

const FIXTURE_PDF = join(process.cwd(), 'fixtures/resume.pdf');

/** 断言某个调用抛出指定错误码的 CliError */
async function expectCliError(promise: Promise<unknown>, code: string): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    const cliError = error as CliError;
    expect(cliError.code).toBe(code);
    expect(cliError.hint, '错误必须带可执行的提示').toBeTruthy();
    return cliError;
  }
  throw new Error(`期望抛出 ${code}，但调用成功了`);
}

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'resume-cli-pdf-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('parsePdf - 成功路径', () => {
  it('解析示例简历并提取出可读文本', async () => {
    const result = await parsePdf(FIXTURE_PDF);

    expect(result.pages).toBeGreaterThanOrEqual(1);
    expect(result.chars).toBeGreaterThan(50);
    expect(result.text).toContain('张伟');
    expect(result.text).toContain('浙江大学');
    expect(result.suspectedScanned).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('把 PDF 中的 CJK 兼容字符还原成标准汉字', async () => {
    const { text } = await parsePdf(FIXTURE_PDF);
    // 示例简历里「业务页面」的「页」在 PDF 中可能是 U+2EDA，必须已被归一化
    expect(text).toContain('业务页面');
    expect(text).not.toContain('\u2EDA');
  });

  it('恢复基本的行结构，而不是把整页挤成一行', async () => {
    const { text } = await parsePdf(FIXTURE_PDF);
    const lines = text.split('\n');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.some((line) => line.includes('教育经历'))).toBe(true);
  });
});

describe('parsePdf - 异常路径', () => {
  it('文件不存在 → FILE_NOT_FOUND', async () => {
    await expectCliError(parsePdf(join(workDir, 'not-exist.pdf')), 'FILE_NOT_FOUND');
  });

  it('传入目录 → FILE_NOT_FOUND', async () => {
    await expectCliError(parsePdf(workDir), 'FILE_NOT_FOUND');
  });

  it('扩展名不是 .pdf 的文本文件 → NOT_A_PDF', async () => {
    const txtPath = join(workDir, 'resume.txt');
    await writeFile(txtPath, '这不是 PDF');
    await expectCliError(parsePdf(txtPath), 'NOT_A_PDF');
  });

  it('改成 .pdf 后缀的假文件 → NOT_A_PDF（靠魔数识别，不信扩展名）', async () => {
    const fakePath = join(workDir, 'fake.pdf');
    await writeFile(fakePath, 'PK\u0003\u0004 这其实是个 zip');
    await expectCliError(parsePdf(fakePath), 'NOT_A_PDF');
  });

  it('空文件 → PDF_UNREADABLE', async () => {
    const emptyPath = join(workDir, 'empty.pdf');
    await writeFile(emptyPath, '');
    await expectCliError(parsePdf(emptyPath), 'PDF_UNREADABLE');
  });

  it('文件头是 PDF 但内容损坏 → PDF_UNREADABLE', async () => {
    const brokenPath = join(workDir, 'broken.pdf');
    await writeFile(brokenPath, '%PDF-1.4\n这后面全是垃圾数据，不是合法的 PDF 结构');
    await expectCliError(parsePdf(brokenPath), 'PDF_UNREADABLE');
  });
});
