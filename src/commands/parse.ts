/**
 * `resume-cli parse <pdf_path>`
 *
 * 只做一件事：把 PDF 变成文本并展示出来。
 * 刻意不调用 AI —— 这样用户能先把"文件到底能不能读"这件事确认掉，
 * 再去关心模型效果。排障时这一步能省掉很多来回。
 */

import { parsePdf } from '../core/pdf.js';
import { emitResult } from '../core/emit.js';
import { logger } from '../core/logger.js';
import * as ui from '../core/ui.js';
import { type CommonOptions, formatBytes } from './common.js';

export interface ParseOptions extends CommonOptions {
  /** 打印完整文本，不做行数截断 */
  full?: boolean;
  /** 预览最大行数 */
  lines?: number;
}

export async function runParse(pdfPath: string, options: ParseOptions): Promise<void> {
  const result = await parsePdf(pdfPath);
  logger.debug(`解析完成：${result.pages} 页，${result.chars} 字符`);

  if (result.suspectedScanned) {
    logger.warn('提取到的文本非常少，该 PDF 可能是扫描件或图片版');
  }

  const payload = {
    path: result.path,
    bytes: result.bytes,
    pages: result.pages,
    chars: result.chars,
    metadata: result.metadata,
    suspectedScanned: result.suspectedScanned,
    text: result.text,
  };

  await emitResult(payload, {
    json: options.json === true,
    output: options.output,
    label: '文本',
    render: () => {
      const maxLines = options.full ? Number.POSITIVE_INFINITY : options.lines ?? 40;
      const lines: string[] = [
        ui.resultHeader('PDF 文本解析', result.path),
        '',
        ui.keyValueList([
          ['文件大小', formatBytes(result.bytes)],
          ['页数', String(result.pages)],
          ['字符数', String(result.chars)],
          ['文档标题', result.metadata.title ?? null],
          ['作者', result.metadata.author ?? null],
          ['生成工具', result.metadata.producer ?? result.metadata.creator ?? null],
        ]),
        '',
        ui.divider(),
        ui.sectionTitle(`文本预览（前 ${Number.isFinite(maxLines) ? maxLines : result.pages} 行以内）`),
        '',
        ui.renderTextPreview(result.text, Number.isFinite(maxLines) ? maxLines : Number.MAX_SAFE_INTEGER),
      ];

      if (result.suspectedScanned) {
        lines.push('', ui.statusLine('warn', '文本极少，可能是扫描件。如需处理图片版简历，请先做 OCR。'));
      }
      return lines.join('\n');
    },
  });
}
