/**
 * PDF 解析层。
 *
 * 职责边界：只负责「把一个本地 PDF 变成干净文本」，不碰 AI、不碰业务字段。
 * 所有可预期的失败都在这里被识别成带错误码的 CliError，
 * 上层拿到错误直接打印即可，不需要再猜"到底是文件问题还是解析问题"。
 *
 * 选型说明：使用 pdfjs-dist 的 legacy 构建，纯 JS、无原生依赖，
 * 不需要额外安装 poppler / ImageMagick 之类的系统组件，`npm install` 后即可运行。
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js';
import { CliError } from './errors.js';
import { logger } from './logger.js';
import { cleanExtractedText } from './text.js';

/** 单个文件体积上限：超过这个值基本是扫描件或异常文件，提前拒绝比跑到一半 OOM 更好。 */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** PDF 文件魔数，用来在真正解析之前快速判断"这是不是一个 PDF"。 */
const PDF_MAGIC = '%PDF-';

export interface PdfMetadata {
  title?: string;
  author?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
}

export interface PdfParseResult {
  /** 绝对路径，便于在输出里直接展示 */
  path: string;
  /** 文件大小（字节） */
  bytes: number;
  /** 页数 */
  pages: number;
  /** 清洗后的文本字符数 */
  chars: number;
  /** 清洗后的全文 */
  text: string;
  metadata: PdfMetadata;
  /** 扫描件嫌疑：有页面但几乎提不出文字 */
  suspectedScanned: boolean;
}

/**
 * 解析前的静态校验：文件是否存在、是不是普通文件、是不是 PDF、是不是空文件。
 * 这些检查放在读取之前，一是错误信息更准确，二是避免把无关的大文件读进内存。
 */
async function assertReadablePdf(inputPath: string): Promise<{ absPath: string; bytes: number }> {
  const absPath = resolve(inputPath);

  let fileStat;
  try {
    fileStat = await stat(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new CliError('FILE_NOT_FOUND', `找不到文件：${absPath}`, {
        hint: '确认路径拼写是否正确，也可以把文件拖进终端自动补全绝对路径。',
        cause: error,
      });
    }
    if (code === 'EACCES') {
      throw new CliError('FILE_NOT_FOUND', `没有权限读取文件：${absPath}`, {
        hint: '检查文件权限（ls -l），或换一个可读路径。',
        cause: error,
      });
    }
    throw new CliError('PDF_UNREADABLE', `无法访问文件：${absPath}`, { cause: error });
  }

  if (fileStat.isDirectory()) {
    throw new CliError('FILE_NOT_FOUND', `目标是一个目录而不是文件：${absPath}`, {
      hint: '请传入 PDF 文件路径，例如 ./resume.pdf。',
    });
  }

  if (fileStat.size === 0) {
    throw new CliError('PDF_UNREADABLE', `文件为空（0 字节）：${absPath}`, {
      hint: '文件可能没有下载完整，请重新获取后重试。',
    });
  }

  if (fileStat.size > MAX_FILE_BYTES) {
    throw new CliError(
      'PDF_UNREADABLE',
      `文件过大（${(fileStat.size / 1024 / 1024).toFixed(1)} MB），超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限`,
      { hint: '超大文件通常是扫描件，建议先压缩或改用文本版简历。' },
    );
  }

  // 魔数检查：PDF 规范允许文件头前有少量偏移，但这在实践中极罕见，取前 1KB 足够判断
  const head = await readFile(absPath).then((buf) => buf.subarray(0, Math.min(1024, buf.length)));
  const headText = head.toString('latin1');
  if (!headText.includes(PDF_MAGIC)) {
    const ext = extname(absPath).toLowerCase();
    const looksLikeOtherFormat = ext && ext !== '.pdf';
    throw new CliError(
      'NOT_A_PDF',
      `文件不是有效的 PDF：${absPath}`,
      {
        hint: looksLikeOtherFormat
          ? `文件扩展名是 ${ext}，请确认传入的是 PDF 简历。`
          : '文件内容缺少 PDF 文件头（%PDF-），可能已损坏或只是改了扩展名。',
      },
    );
  }

  return { absPath, bytes: fileStat.size };
}

/**
 * 把 pdfjs 的一页内容还原成"行"。
 *
 * 直接 `items.map(i => i.str).join('')` 会丢掉所有版面信息，
 * 姓名、公司、时间会连成一坨，既不利于人看，也会拉低大模型抽取的准确率。
 * 所以这里按 y 坐标切行、按 x 间隙决定是否补空格。
 */
function rebuildLayout(items: unknown[]): string {
  const textItems = items.filter((item): item is TextItem => typeof (item as TextItem).str === 'string');

  const lines: Array<{ y: number; parts: Array<{ x: number; width: number; size: number; str: string }> }> = [];
  let current: (typeof lines)[number] | undefined;

  for (const item of textItems) {
    const [, , , scaleY, x, y] = item.transform;
    const size = Math.abs(item.height || scaleY || 10);
    // 纵向位移超过半个字高就算换行；hasEOL 是 pdfjs 给的显式换行信号，优先采信
    if (!current || (item.hasEOL && current.parts.length > 0) || Math.abs(y - current.y) > size * 0.5) {
      current = { y, parts: [] };
      lines.push(current);
    }
    if (item.str.length > 0) {
      current.parts.push({ x, width: item.width || 0, size, str: item.str });
    }
  }

  const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

  return lines
    .map((line) => {
      const parts = [...line.parts].sort((a, b) => a.x - b.x);
      let out = '';
      let previous: (typeof parts)[number] | undefined;
      for (const part of parts) {
        if (previous) {
          const gap = part.x - (previous.x + previous.width);
          const threshold = Math.max(previous.size, part.size) * 0.28;
          // 中文排版本来就不靠空格分词，两侧都是 CJK 时不补空格，避免"张 伟"这种切口
          const bothCjk = CJK.test(previous.str.slice(-1)) && CJK.test(part.str.slice(0, 1));
          if (gap > threshold && !bothCjk) out += ' ';
        }
        out += part.str;
        previous = part;
      }
      return out;
    })
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

/**
 * 读取本地 PDF 并提取干净文本。
 *
 * @throws CliError FILE_NOT_FOUND | NOT_A_PDF | PDF_UNREADABLE | PDF_EMPTY_TEXT
 */
export async function parsePdf(inputPath: string): Promise<PdfParseResult> {
  const { absPath, bytes } = await assertReadablePdf(inputPath);
  logger.debug(`读取文件 ${absPath}（${(bytes / 1024).toFixed(0)} KB）`);

  const data = new Uint8Array(await readFile(absPath));

  // 动态 import：pdfjs 体积不小，只在真正需要解析时才加载，--help 之类的路径不受影响
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let doc;
  try {
    doc = await pdfjs.getDocument({
      data,
      // 简历是外部输入，关掉 eval 和字体下载，避免 PDF 内嵌脚本执行
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      // Node 环境没有 worker，显式声明避免 pdfjs 去找 worker 文件
      useWorkerFetch: false,
      verbosity: 0,
    }).promise;
  } catch (error) {
    const name = (error as Error)?.name;
    if (name === 'PasswordException') {
      throw new CliError('PDF_UNREADABLE', `PDF 已加密，无法读取：${absPath}`, {
        hint: '请先用阅读器去掉密码保护，或导出为无密码的 PDF。',
        cause: error,
      });
    }
    if (name === 'InvalidPDFException') {
      throw new CliError('PDF_UNREADABLE', `PDF 结构损坏，无法解析：${absPath}`, {
        hint: '尝试用阅读器重新"另存为 PDF"修复文件结构。',
        cause: error,
      });
    }
    throw new CliError('PDF_UNREADABLE', `PDF 解析失败：${absPath}`, {
      hint: '文件可能已损坏或使用了不兼容的加密方式。',
      cause: error,
    });
  }

  try {
    const pageTexts: string[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(rebuildLayout(content.items));
      page.cleanup();
    }

    const text = cleanExtractedText(pageTexts.join('\n\n'));
    let metadata: PdfMetadata = {};
    try {
      const raw = await doc.getMetadata();
      const info = (raw.info ?? {}) as Record<string, unknown>;
      metadata = {
        title: typeof info.Title === 'string' ? info.Title : undefined,
        author: typeof info.Author === 'string' ? info.Author : undefined,
        creator: typeof info.Creator === 'string' ? info.Creator : undefined,
        producer: typeof info.Producer === 'string' ? info.Producer : undefined,
        creationDate: typeof info.CreationDate === 'string' ? info.CreationDate : undefined,
      };
    } catch {
      // 元数据缺失不影响主流程，静默降级
      logger.debug('未能读取 PDF 元数据，已跳过');
    }

    // 只有图片没有文字的 PDF 提不出内容，这里区分"真空白"和"扫描件"，
    // 因为两者给用户的建议完全不同（前者查文件，后者做 OCR）
    const suspectedScanned = text.length < 30 && doc.numPages > 0;
    if (text.trim().length === 0) {
      throw new CliError('PDF_EMPTY_TEXT', `未能从 PDF 中提取到任何文本：${absPath}`, {
        hint: suspectedScanned
          ? `该 PDF 共 ${doc.numPages} 页，很可能是扫描件或纯图片版。请改用可选中文字的 PDF，或先做 OCR。`
          : '文件内容为空，请确认 PDF 中包含文字内容。',
      });
    }

    return {
      path: absPath,
      bytes,
      pages: doc.numPages,
      chars: text.length,
      text,
      metadata,
      suspectedScanned,
    };
  } finally {
    await doc.destroy();
  }
}
