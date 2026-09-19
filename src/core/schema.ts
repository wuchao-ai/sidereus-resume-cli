/**
 * 数据契约与校验。
 *
 * 大模型的输出是"概率性的"，但下游（脚本、页面、数据库）需要的是"确定的"。
 * 所以这一层做两件事：
 *   1. 规范化 —— 把模型常见的表达偏差收敛成统一形状（单对象转数组、字符串拆列表、数字转数值…）
 *   2. 校验   —— 用 zod 做结构校验，不通过就抛 AI_INVALID_SHAPE，绝不把脏数据放行
 *
 * 区分「规范化」和「校验」的原因：前者是可以容忍的偏差（记录 warning 即可），
 * 后者是不可接受的破坏（必须失败）。混在一起写，就分不清"该修"和"该报"。
 */

import { z } from 'zod';
import { CliError } from './errors.js';

/** 评分字段的取值范围，题目要求 0-100 */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

/**
 * 技能列表的约定上限。
 *
 * 定义在这里而不是只写在提示词里，是为了让"提示词里说的"和"代码里查的"是同一个数 ——
 * 两边各写一个字面量，早晚会漂移成一个说 20、一个查 30。
 */
export const MAX_SKILLS = 20;

export interface ValidationOutcome<T> {
  data: T;
  /** 规范化过程中发生的、值得让用户知道的事（未阻断流程） */
  warnings: string[];
}

/* ------------------------------------------------------------------ *
 * 结构化简历
 * ------------------------------------------------------------------ */

export const educationSchema = z.object({
  school: z.string().nullable(),
  major: z.string().nullable(),
  degree: z.string().nullable(),
  graduation_time: z.string().nullable(),
});

export const resumeProfileSchema = z.object({
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  city: z.string().nullable(),
  education: z.array(educationSchema),
  skills: z.array(z.string()),
});

export type Education = z.infer<typeof educationSchema>;
export type ResumeProfile = z.infer<typeof resumeProfileSchema>;

/** 把任意值收敛成"去空白的字符串或 null" */
function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** 把任意值收敛成字符串数组；模型返回逗号串时自动拆分 */
function toStringArray(value: unknown, warnings: string[], fieldName: string): string[] {
  if (value === null || value === undefined || value === '') return [];

  if (Array.isArray(value)) {
    // 只接受字符串项。这里刻意不用 toNullableString —— 它会把数字 42 变成 "42"，
    // 而 "42" 出现在技能列表里是无意义的噪声。宁可丢弃并告警，也不要留下看起来像数据的脏值。
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const dropped = value.length - items.length;
    if (dropped > 0) warnings.push(`${fieldName} 中有 ${dropped} 项不是有效文本，已忽略`);
    return items;
  }

  if (typeof value === 'string') {
    const parts = value
      .split(/[,，、;；|\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (parts.length > 1) warnings.push(`${fieldName} 是字符串，已按分隔符拆成 ${parts.length} 项`);
    return parts;
  }

  warnings.push(`${fieldName} 的类型不是数组（收到 ${typeof value}），已置为空列表`);
  return [];
}

/** 给人看的类型名：`typeof null` 是 "object"，直接打出来会把排查的人带偏 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  return typeof value;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 规范化简历字段。
 * 只做形状收敛，不做业务裁剪 —— "缺姓名"这种事记 warning，由调用方决定是否在意。
 */
export function normalizeResumeProfile(input: unknown): ValidationOutcome<ResumeProfile> {
  const warnings: string[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CliError('AI_INVALID_SHAPE', `期望模型返回 JSON 对象，实际收到 ${Array.isArray(input) ? '数组' : typeof input}`, {
      hint: '可以重试一次，或在提示词中更强调"只返回 JSON 对象"。',
    });
  }

  const raw = input as Record<string, unknown>;

  // education 的四种输入形状都要有明确归宿。漏掉任何一支都会变成"静默丢数据"：
  // 用户看到"未提取到教育经历"，却不知道是简历里没有，还是模型返回的格式被吃掉了。
  let educationRaw: unknown[];
  if (Array.isArray(raw.education)) {
    educationRaw = raw.education;
  } else if (raw.education && typeof raw.education === 'object') {
    educationRaw = [raw.education];
    warnings.push('education 不是数组，已包装为单元素数组');
  } else if (raw.education === null || raw.education === undefined || raw.education === '') {
    educationRaw = [];
    if (raw.education === null) warnings.push('education 为 null，已置为空数组');
  } else {
    educationRaw = [];
    warnings.push(`education 的类型是 ${describeType(raw.education)}，不是数组或对象，已忽略该字段`);
  }

  const education = educationRaw.flatMap((item, index) => {
    // 非对象项直接丢弃，不伪装成一行空记录 —— 凭空造出来的空行会让人以为
    // "模型返回过一条学历信息但不完整"，而事实是这一项根本不是学历。
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      warnings.push(`education[${index}] 不是对象（收到 ${describeType(item)}），已跳过`);
      return [];
    }
    const row = item as Record<string, unknown>;
    return [
      {
        school: toNullableString(row.school ?? row.university ?? row.schoolName),
        major: toNullableString(row.major ?? row.subject),
        degree: toNullableString(row.degree ?? row.education),
        // 模型有时把毕业时间写成 graduationDate / end_time 之类，这里做常见别名兼容
        graduation_time: toNullableString(
          row.graduation_time ?? row.graduationTime ?? row.graduationDate ?? row.graduation_date,
        ),
      },
    ];
  });

  const skills = toStringArray(raw.skills, warnings, 'skills');
  // 提示词里写了"最多 20 项"，但模型完全可以不听。这里只报告、不裁剪：
  // 裁剪会真的丢掉信息，而这一层的职责是形状收敛，数量是否超标由调用方判断。
  if (skills.length > MAX_SKILLS) {
    warnings.push(
      `skills 有 ${skills.length} 项，超过约定的 ${MAX_SKILLS} 项上限（未裁剪，如需收敛请在调用侧处理）`,
    );
  }

  const normalized = {
    name: toNullableString(raw.name),
    phone: toNullableString(raw.phone),
    email: toNullableString(raw.email),
    city: toNullableString(raw.city),
    education,
    skills,
  };

  const result = resumeProfileSchema.safeParse(normalized);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CliError('AI_INVALID_SHAPE', `简历字段校验未通过：${detail}`, {
      hint: '这类错误通常意味着模型返回的结构与约定差异较大，可重试或检查提示词。',
    });
  }

  if (!result.data.name) warnings.push('未能从简历中提取到姓名');
  if (result.data.email && !EMAIL_PATTERN.test(result.data.email)) {
    warnings.push(`邮箱格式可能不合法：${result.data.email}`);
  }
  if (result.data.education.length === 0) warnings.push('未提取到任何教育经历');
  if (result.data.skills.length === 0) warnings.push('未提取到任何技能');

  return { data: result.data, warnings };
}

/* ------------------------------------------------------------------ *
 * JD 匹配评分
 * ------------------------------------------------------------------ */

export const matchReportSchema = z.object({
  overall_score: z.number().min(SCORE_MIN).max(SCORE_MAX),
  skill_score: z.number().min(SCORE_MIN).max(SCORE_MAX),
  experience_score: z.number().min(SCORE_MIN).max(SCORE_MAX),
  education_score: z.number().min(SCORE_MIN).max(SCORE_MAX),
  comment: z.string(),
  interview_questions: z.array(z.string()),
});

export type MatchReport = z.infer<typeof matchReportSchema>;

/**
 * 把模型给的分数收敛到 0-100。
 * 模型经常返回 "85分"、"85%"、82.7 这类形式，全都折成数值；
 * 一旦越界就夹取并记 warning —— 直接报错会让一次可用的结果白白浪费。
 */
function toScore(value: unknown, field: string, warnings: string[]): number {
  let numeric: number;
  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const matched = /-?\d+(?:\.\d+)?/.exec(value);
    numeric = matched ? Number.parseFloat(matched[0]) : Number.NaN;
    if (matched) warnings.push(`${field} 是字符串（${value}），已解析为数值`);
  } else {
    numeric = Number.NaN;
  }

  if (!Number.isFinite(numeric)) {
    warnings.push(`${field} 不是有效数字，已置为 0`);
    return 0;
  }

  const rounded = Math.round(numeric * 10) / 10;
  if (rounded < SCORE_MIN) {
    warnings.push(`${field} 为 ${rounded}，已夹取到下限 ${SCORE_MIN}`);
    return SCORE_MIN;
  }
  if (rounded > SCORE_MAX) {
    warnings.push(`${field} 为 ${rounded}，已夹取到上限 ${SCORE_MAX}`);
    return SCORE_MAX;
  }
  if (rounded !== numeric) warnings.push(`${field} 已四舍五入到一位小数`);
  return rounded;
}

const SCORE_FIELDS = ['overall_score', 'skill_score', 'experience_score', 'education_score'] as const;

export function normalizeMatchReport(input: unknown): ValidationOutcome<MatchReport> {
  const warnings: string[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new CliError('AI_INVALID_SHAPE', '期望模型返回 JSON 对象作为评分结果', {
      hint: '可重试一次，或检查提示词是否要求返回单个 JSON 对象。',
    });
  }

  const raw = input as Record<string, unknown>;

  const scores = Object.fromEntries(
    SCORE_FIELDS.map((field) => {
      const value = raw[field];
      if (value === undefined || value === null) warnings.push(`${field} 缺失，已置为 0`);
      return [field, toScore(value, field, warnings)];
    }),
  ) as Record<(typeof SCORE_FIELDS)[number], number>;

  const comment = toNullableString(raw.comment ?? raw.reason ?? raw.summary) ?? '';
  if (!comment) warnings.push('缺少评分理由（comment），建议在提示词中强调"必须给出理由"');

  const questions = toStringArray(
    raw.interview_questions ?? raw.questions ?? raw.interviewQuestions,
    warnings,
    'interview_questions',
  );

  const normalized = { ...scores, comment, interview_questions: questions };

  const result = matchReportSchema.safeParse(normalized);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new CliError('AI_INVALID_SHAPE', `评分结果校验未通过：${detail}`);
  }

  return { data: result.data, warnings };
}
