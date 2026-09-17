/**
 * 重新生成示例简历 PDF（fixtures/resume.pdf）。
 *
 * 做法是把 fixtures/resume.source.html 用无头 Chrome 打印成 PDF。
 * 之所以不引 pdfkit 之类的库：PDF 里要放中文，纯 JS 库得额外内嵌字体文件，
 * 而"用浏览器打印"这条路本来就是业务里生成 PDF 的主流方式，产物也更接近真实简历。
 *
 * 用法：npm run fixture
 * 需要本机已安装 Chrome / Chromium；没有安装时会给出提示并跳过，不影响正常使用。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const SOURCE_HTML = join(PROJECT_ROOT, 'fixtures', 'resume.source.html');
const OUTPUT_PDF = join(PROJECT_ROOT, 'fixtures', 'resume.pdf');

/** 常见安装位置；也可以用 CHROME_PATH 环境变量显式指定 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter((candidate): candidate is string => Boolean(candidate));

function findChrome(): string | null {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      // Chrome 的 headless 会往 stderr 打不少噪声（GPU、sandbox 警告），
      // 只有非 0 退出码才当作真失败
      else rejectPromise(new Error(`Chrome 退出码 ${code}\n${stderr.slice(-500)}`));
    });
  });
}

async function main(): Promise<void> {
  if (!existsSync(SOURCE_HTML)) {
    console.error(`✖ 找不到源文件：${SOURCE_HTML}`);
    process.exitCode = 1;
    return;
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error('✖ 未找到 Chrome / Chromium，无法重新生成 PDF。');
    console.error('  可设置环境变量 CHROME_PATH 指向浏览器可执行文件，或直接使用仓库里已有的 fixtures/resume.pdf。');
    process.exitCode = 1;
    return;
  }

  // Chrome 在部分环境下无法访问默认的临时目录，这里给它一个独立的工作目录
  const userDataDir = await mkdtemp(join(tmpdir(), 'resume-cli-chrome-'));
  try {
    console.log(`· 使用浏览器：${chrome}`);
    await run(chrome, [
      '--headless=new',
      // CI / 容器里没有内核沙箱权限，显式关闭以免启动失败
      '--no-sandbox',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--user-data-dir=${userDataDir}`,
      `--print-to-pdf=${OUTPUT_PDF}`,
      pathToFileURL(SOURCE_HTML).href,
    ]);
    console.log(`✔ 已生成 ${OUTPUT_PDF}`);
  } catch (error) {
    console.error(`✖ 生成 PDF 失败：${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
}

void main();
