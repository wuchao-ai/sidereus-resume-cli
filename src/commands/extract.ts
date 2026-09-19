/**
 * `resume-cli extract <pdf_path>`
 *
 * 调用大模型把简历文本抽成结构化 JSON。
 * 输出遵循题目给定的字段契约，不多不少 —— 下游可以直接按这个 schema 消费。
 */

import { parsePdf } from '../core/pdf.js';
import { emitResult } from '../core/emit.js';
import { logger } from '../core/logger.js';
import * as ui from '../core/ui.js';
import { AiClient } from '../core/ai.js';
import { resolveAiConfig, describeAiConfig } from '../core/config.js';
import { parseModelJson } from '../core/json.js';
import { buildExtractPrompt, MAX_RESUME_CHARS } from '../core/prompts.js';
import { CliError } from '../core/errors.js';
import { mockResumeProfile } from '../core/mock.js';
import { normalizeResumeProfile, type ResumeProfile } from '../core/schema.js';
import type { CommonOptions } from './common.js';

export interface ExtractOptions extends CommonOptions {}

/** 把技能列表折成每行不超过终端宽度的多行 */
function renderSkills(skills: string[]): string {
  if (skills.length === 0) return `  ${ui.c.dim('未提取到技能')}`;
  const maxWidth = ui.contentWidth() - 4;
  const lines: string[] = [];
  let current = '';
  for (const skill of skills) {
    const candidate = current ? `${current}  ${skill}` : skill;
    if (ui.displayWidth(candidate) > maxWidth) {
      lines.push(current);
      current = skill;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => `  ${ui.c.cyan(line)}`).join('\n');
}

function renderEducation(profile: ResumeProfile): string {
  if (profile.education.length === 0) return `  ${ui.c.dim('未提取到教育经历')}`;

  return profile.education
    .map((item, index) => {
      const head = [item.school, item.major, item.degree].filter(Boolean).join(' · ') || ui.c.dim('(信息缺失)');
      const time = item.graduation_time ? ui.c.gray(`  ${item.graduation_time}`) : '';
      return `  ${ui.c.gray(`${index + 1}.`)} ${head}${time}`;
    })
    .join('\n');
}

export async function runExtract(pdfPath: string, options: ExtractOptions): Promise<void> {
  const parsed = await parsePdf(pdfPath);

  let profile: ResumeProfile;
  let source: string;
  let durationMs = 0;
  const warnings: string[] = [];

  if (options.mock) {
    logger.info('离线模式：使用内置规则引擎抽取，不调用大模型');
    const startedAt = Date.now();
    profile = normalizeResumeProfile(mockResumeProfile(parsed.text)).data;
    durationMs = Date.now() - startedAt;
    source = '离线规则引擎 (--mock)';
  } else {
    const config = resolveAiConfig({ ...(options.model ? { model: options.model } : {}) });
    logger.debug(`AI 配置：${describeAiConfig(config)}`);
    logger.info(`正在调用 ${config.model} 提取结构化信息…`);

    const client = new AiClient(config);
    const { system, user, budget } = buildExtractPrompt(parsed.text);
    if (budget.resume.truncated) {
      logger.warn(
        `简历文本 ${budget.resume.originalChars} 字符，超出单次上限 ${MAX_RESUME_CHARS}，已截断至前 ${budget.resume.usedChars} 字符，结果可能不完整`,
      );
    }
    const response = await client.complete({ system, user, jsonMode: true });
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
      throw new CliError('AI_INVALID_JSON', '模型返回的内容不是合法 JSON，且自动修复未能成功', {
        hint: `原始返回片段：${snippet}${response.content.length > 200 ? '…' : ''}\n可重试一次，或换一个指令遵循能力更强的模型（OPENAI_MODEL）。`,
        cause: error,
      });
    }

    const outcome = normalizeResumeProfile(raw);
    profile = outcome.data;
    warnings.push(...outcome.warnings);
    source = `${response.model}${response.usage ? ` · ${response.usage.totalTokens} tokens` : ''}`;
  }

  for (const warning of warnings) logger.warn(warning);

  await emitResult(profile, {
    json: options.json === true,
    output: options.output,
    label: '结构化信息',
    render: () => {
      const lines: string[] = [
        ui.resultHeader('简历结构化提取', `${parsed.path}`),
        // mock 模式的耗时取决于本机 CPU，没有参考价值，不展示
        `  ${ui.c.gray(options.mock ? `${source} · ${parsed.pages} 页` : `${source} · ${(durationMs / 1000).toFixed(2)}s · ${parsed.pages} 页`)}`,
        '',
        ui.sectionTitle('基本信息'),
        ui.keyValueList([
          ['姓名', profile.name ?? ui.c.dim('未提取到')],
          ['电话', profile.phone ?? ui.c.dim('未提取到')],
          ['邮箱', profile.email ?? ui.c.dim('未提取到')],
          ['所在城市', profile.city ?? ui.c.dim('未提取到')],
        ]),
        '',
        ui.sectionTitle(`教育经历（${profile.education.length}）`),
        renderEducation(profile),
        '',
        ui.sectionTitle(`技能（${profile.skills.length}）`),
        renderSkills(profile.skills),
        '',
        ui.divider(),
        ui.sectionTitle('JSON 输出'),
        '',
        JSON.stringify(profile, null, 2),
      ];

      if (options.mock) {
        lines.push('', ui.statusLine('warn', '以上为离线规则引擎结果，仅用于无 API Key 时演示，不代表模型效果。'));
      }
      return lines.join('\n');
    },
  });
}
