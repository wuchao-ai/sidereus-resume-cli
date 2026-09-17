/**
 * `resume-cli score <pdf_path> --jd <jd_path>`
 *
 * 把简历与岗位描述一起交给大模型，拿到带理由的匹配评分。
 * 评分口径（各维度怎么算）写在 prompts.ts 里，这里只负责编排与展示。
 */

import { parsePdf } from '../core/pdf.js';
import { readJdFile } from '../core/io.js';
import { emitResult } from '../core/emit.js';
import { logger } from '../core/logger.js';
import * as ui from '../core/ui.js';
import { AiClient } from '../core/ai.js';
import { resolveAiConfig, describeAiConfig } from '../core/config.js';
import { parseModelJson } from '../core/json.js';
import { buildScorePrompt } from '../core/prompts.js';
import { CliError } from '../core/errors.js';
import { mockMatchReport } from '../core/mock.js';
import { normalizeMatchReport, type MatchReport } from '../core/schema.js';
import type { CommonOptions } from './common.js';

export interface ScoreOptions extends CommonOptions {
  /** JD 文件路径（必填） */
  jd: string;
}

export async function runScore(pdfPath: string, options: ScoreOptions): Promise<void> {
  const [parsed, jd] = await Promise.all([parsePdf(pdfPath), readJdFile(options.jd)]);
  logger.debug(`简历 ${parsed.chars} 字符，JD ${jd.chars} 字符`);

  let report: MatchReport;
  let source: string;
  let durationMs = 0;

  if (options.mock) {
    logger.info('离线模式：使用内置规则引擎评分，不调用大模型');
    const startedAt = Date.now();
    report = normalizeMatchReport(mockMatchReport(parsed.text, jd.text)).data;
    durationMs = Date.now() - startedAt;
    source = '离线规则引擎 (--mock)';
  } else {
    const config = resolveAiConfig({ ...(options.model ? { model: options.model } : {}) });
    logger.debug(`AI 配置：${describeAiConfig(config)}`);
    logger.info(`正在调用 ${config.model} 进行匹配评分…`);

    const client = new AiClient(config);
    const prompt = buildScorePrompt(parsed.text, jd.text);
    const response = await client.complete({ ...prompt, jsonMode: true });
    durationMs = response.durationMs;

    let raw: unknown;
    try {
      const outcome = parseModelJson(response.content);
      raw = outcome.value;
      if (outcome.repairs.length > 0) {
        logger.warn(`模型返回的 JSON 需要修复，已自动处理：${outcome.repairs.join(' → ')}`);
      }
    } catch (error) {
      const snippet = response.content.slice(0, 200).replace(/\s+/g, ' ');
      throw new CliError('AI_INVALID_JSON', '模型返回的评分结果不是合法 JSON，且自动修复未能成功', {
        hint: `原始返回片段：${snippet}${response.content.length > 200 ? '…' : ''}`,
        cause: error,
      });
    }

    const outcome = normalizeMatchReport(raw);
    report = outcome.data;
    for (const warning of outcome.warnings) logger.warn(warning);
    source = `${response.model}${response.usage ? ` · ${response.usage.totalTokens} tokens` : ''}`;
  }

  await emitResult(report, {
    json: options.json === true,
    output: options.output,
    label: '评分结果',
    render: () => {
      const labelWidth = 12;
      const lines: string[] = [
        ui.resultHeader('JD 匹配评分', `${parsed.path}`),
        `  ${ui.c.gray(`对比岗位：${jd.path}`)}`,
        // mock 模式的耗时取决于本机 CPU，没有参考价值，不展示
        `  ${ui.c.gray(options.mock ? source : `${source} · ${(durationMs / 1000).toFixed(2)}s`)}`,
        '',
        ui.scoreBar('综合匹配度', report.overall_score, labelWidth),
        '',
        ui.scoreBar('技能匹配', report.skill_score, labelWidth),
        ui.scoreBar('工作经验', report.experience_score, labelWidth),
        ui.scoreBar('教育背景', report.education_score, labelWidth),
        '',
        ui.sectionTitle('评分理由'),
        ...ui.wrapWithIndent(report.comment || ui.c.dim('（模型未给出理由）'), '  ', '  ', ui.contentWidth()),
        '',
        ui.sectionTitle(`建议面试问题（${report.interview_questions.length}）`),
      ];

      if (report.interview_questions.length === 0) {
        lines.push(`  ${ui.c.dim('（未生成面试问题）')}`);
      } else {
        report.interview_questions.forEach((question, index) => {
          const marker = `  ${ui.c.gray(`${index + 1}.`)} `;
          // 续行缩进 = 序号占用的宽度，保证视觉上问题正文左对齐
          lines.push(...ui.wrapWithIndent(question, marker, ' '.repeat(ui.displayWidth(marker)), ui.contentWidth()));
        });
      }

      lines.push('', ui.divider(), ui.sectionTitle('JSON 输出'), '', JSON.stringify(report, null, 2));

      if (options.mock) {
        lines.push('', ui.statusLine('warn', '以上为离线规则引擎结果，仅用于无 API Key 时演示，不代表模型效果。'));
      }
      return lines.join('\n');
    },
  });
}
