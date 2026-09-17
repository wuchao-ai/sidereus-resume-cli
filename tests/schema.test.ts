import { describe, expect, it } from 'vitest';
import { CliError } from '../src/core/errors';
import { normalizeMatchReport, normalizeResumeProfile } from '../src/core/schema';

describe('normalizeResumeProfile - 正常输入', () => {
  it('完整字段原样通过', () => {
    const { data, warnings } = normalizeResumeProfile({
      name: '张伟',
      phone: '138-0000-1234',
      email: 'zhangwei@example.com',
      city: '杭州',
      education: [{ school: '浙江大学', major: '软件工程', degree: '本科', graduation_time: '2018.06' }],
      skills: ['TypeScript', 'React'],
    });

    expect(data.name).toBe('张伟');
    expect(data.education).toHaveLength(1);
    expect(data.education[0]!.school).toBe('浙江大学');
    expect(warnings).toEqual([]);
  });

  it('查不到的字段置为 null，而不是编造或填空字符串', () => {
    const { data } = normalizeResumeProfile({ name: '张伟', phone: '', email: null, city: undefined });
    expect(data.phone).toBeNull();
    expect(data.email).toBeNull();
    expect(data.city).toBeNull();
    expect(data.education).toEqual([]);
    expect(data.skills).toEqual([]);
  });
});

describe('normalizeResumeProfile - 容错与告警', () => {
  it('education 返回单个对象时包装成数组', () => {
    const { data, warnings } = normalizeResumeProfile({
      education: { school: '浙江大学', major: '软件工程', degree: '本科', graduation_time: '2018' },
    });
    expect(data.education).toHaveLength(1);
    expect(warnings.join()).toContain('包装为单元素数组');
  });

  it('skills 返回逗号串时按分隔符拆分', () => {
    const { data, warnings } = normalizeResumeProfile({ skills: 'React, Vue、Node.js；TypeScript' });
    expect(data.skills).toEqual(['React', 'Vue', 'Node.js', 'TypeScript']);
    expect(warnings.join()).toContain('已按分隔符拆成');
  });

  it('兼容模型用的字段别名（university / graduationDate）', () => {
    const { data } = normalizeResumeProfile({
      education: [{ university: '清华大学', major: '计算机', degree: '硕士', graduationDate: '2020-06' }],
    });
    expect(data.education[0]!.school).toBe('清华大学');
    expect(data.education[0]!.graduation_time).toBe('2020-06');
  });

  it('缺姓名时给出告警但不报错', () => {
    const { data, warnings } = normalizeResumeProfile({ name: null });
    expect(data.name).toBeNull();
    expect(warnings.join()).toContain('未能从简历中提取到姓名');
  });

  it('邮箱格式可疑时告警但保留原值', () => {
    const { data, warnings } = normalizeResumeProfile({ email: 'zhangwei#example' });
    expect(data.email).toBe('zhangwei#example');
    expect(warnings.join()).toContain('邮箱格式可能不合法');
  });
});

describe('normalizeResumeProfile - 非法输入', () => {
  it('收到数组时抛出 AI_INVALID_SHAPE', () => {
    try {
      normalizeResumeProfile([1, 2, 3]);
      throw new Error('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe('AI_INVALID_SHAPE');
    }
  });

  it('收到字符串时抛出 AI_INVALID_SHAPE', () => {
    expect(() => normalizeResumeProfile('不是对象')).toThrow(CliError);
  });
});

describe('normalizeMatchReport', () => {
  it('完整评分原样通过', () => {
    const { data } = normalizeMatchReport({
      overall_score: 82,
      skill_score: 88,
      experience_score: 80,
      education_score: 75,
      comment: '匹配度较好',
      interview_questions: ['问题一', '问题二'],
    });
    expect(data.overall_score).toBe(82);
    expect(data.interview_questions).toHaveLength(2);
  });

  it('把越界分数夹取到 0-100 并记录告警', () => {
    const { data, warnings } = normalizeMatchReport({
      overall_score: 120,
      skill_score: -5,
      experience_score: 80,
      education_score: 60,
      comment: '测试',
      interview_questions: [],
    });
    expect(data.overall_score).toBe(100);
    expect(data.skill_score).toBe(0);
    expect(warnings.join()).toContain('夹取到上限');
    expect(warnings.join()).toContain('夹取到下限');
  });

  it('把 "85分" 这类字符串分数解析为数值', () => {
    const { data, warnings } = normalizeMatchReport({
      overall_score: '85分',
      skill_score: '88%',
      experience_score: 80,
      education_score: 75,
      comment: '测试',
      interview_questions: [],
    });
    expect(data.overall_score).toBe(85);
    expect(data.skill_score).toBe(88);
    expect(warnings.join()).toContain('已解析为数值');
  });

  it('缺字段时置 0 并告警，保证结构始终完整', () => {
    const { data, warnings } = normalizeMatchReport({ comment: '只有理由' });
    expect(data.overall_score).toBe(0);
    expect(data.skill_score).toBe(0);
    expect(warnings.join()).toContain('缺失');
  });

  it('缺 comment 时告警，缺面试问题时置空数组', () => {
    const { data, warnings } = normalizeMatchReport({ overall_score: 80 });
    expect(data.comment).toBe('');
    expect(data.interview_questions).toEqual([]);
    expect(warnings.join()).toContain('缺少评分理由');
  });

  it('兼容 questions / interviewQuestions 别名', () => {
    const { data } = normalizeMatchReport({ overall_score: 80, interviewQuestions: ['问题一'] });
    expect(data.interview_questions).toEqual(['问题一']);
  });
});
