/**
 * 文件读写。
 *
 * 与 pdf.ts 同属"输入输出边界"：所有失败都在这里翻译成带错误码的 CliError，
 * 业务层拿到的要么是数据，要么是一条能直接展示给用户的错误。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { CliError } from './errors.js';

/** JD 文本文件的大小上限，防止把二进制文件当文本读进来 */
const MAX_JD_BYTES = 2 * 1024 * 1024;

export interface JdFile {
  path: string;
  text: string;
  chars: number;
}

/**
 * 读取 JD 文本文件。
 *
 * @throws CliError JD_FILE_NOT_FOUND | JD_EMPTY
 */
export async function readJdFile(inputPath: string): Promise<JdFile> {
  const absPath = resolve(inputPath);

  let fileStat;
  try {
    fileStat = await stat(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      'JD_FILE_NOT_FOUND',
      code === 'ENOENT' ? `找不到 JD 文件：${absPath}` : `无法访问 JD 文件：${absPath}`,
      {
        hint: '通过 --jd 指定岗位描述文件路径，例如 --jd ./jd.txt，文件应为纯文本（.txt / .md）。',
        cause: error,
      },
    );
  }

  if (fileStat.isDirectory()) {
    throw new CliError('JD_FILE_NOT_FOUND', `--jd 指向的是一个目录：${absPath}`, {
      hint: '请指定具体的 JD 文本文件，例如 --jd ./jd.txt。',
    });
  }

  if (fileStat.size === 0) {
    throw new CliError('JD_EMPTY', `JD 文件为空（0 字节）：${absPath}`, {
      hint: '请填写岗位描述内容后重试，哪怕只有几条岗位要求也可以。',
    });
  }

  if (fileStat.size > MAX_JD_BYTES) {
    throw new CliError('JD_EMPTY', `JD 文件过大（${(fileStat.size / 1024 / 1024).toFixed(1)} MB）`, {
      hint: 'JD 通常只有几 KB，请确认传对了文件。',
    });
  }

  const raw = await readFile(absPath, 'utf8');
  // 二进制文件解码后会带大量替换字符，提前拦掉比让模型胡猜更好
  const replacementChars = (raw.match(/\uFFFD/g) ?? []).length;
  if (replacementChars > raw.length * 0.05) {
    throw new CliError('JD_EMPTY', `JD 文件看起来不是 UTF-8 纯文本：${absPath}`, {
      hint: '请把 JD 保存为 UTF-8 编码的 .txt 或 .md 文件后重试。',
    });
  }

  const text = raw.trim();
  if (text.length === 0) {
    throw new CliError('JD_EMPTY', `JD 文件只有空白字符：${absPath}`, {
      hint: '请填写岗位描述内容后重试。',
    });
  }

  return { path: absPath, text, chars: text.length };
}

/**
 * 写出 JSON 结果文件。
 *
 * @throws CliError OUTPUT_WRITE_FAILED
 */
export async function writeJsonFile(inputPath: string, data: unknown): Promise<string> {
  const absPath = resolve(inputPath);
  try {
    await mkdir(dirname(absPath), { recursive: true });
    // 末尾补换行：让文件符合 POSIX 文本文件约定，diff / cat 都更友好
    await writeFile(absPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      'OUTPUT_WRITE_FAILED',
      `写入结果文件失败：${absPath}`,
      {
        hint: code === 'EACCES' ? '目标目录没有写权限，换一个路径试试。' : '确认目录路径是否合法。',
        cause: error,
      },
    );
  }
  return absPath;
}
