import { describe, expect, it } from 'vitest';
import { detectSkills, mockMatchReport, mockResumeProfile } from '../src/core/mock';

const RESUME_TEXT = [
  '张伟',
  '前端 / 全栈工程师 | 8 年经验',
  '手机：138-0000-1234  邮箱：zhangwei.demo@example.com',
  '现居城市：杭州',
  '教育经历',
  '浙江大学 软件工程 本科 2014.09 - 2018.06',
  '工作经历',
  '熟悉 TypeScript / JavaScript / Node.js，使用过 React 与 Vue。',
  '了解 Docker，接触过 OpenAI API 与大模型应用开发。',
].join('\n');

const JD_TEXT = [
  '全栈工程师',
  '要求 3 年以上经验，本科及以上学历。',
  '熟练掌握 TypeScript、Node.js、React；',
  '有 LLM、RAG 应用经验；熟悉 PostgreSQL 与 Kubernetes。',
].join('\n');

describe('detectSkills', () => {
  it('识别出常见技术栈', () => {
    const skills = detectSkills('熟悉 TypeScript、React 和 Node.js');
    expect(skills).toContain('TypeScript');
    expect(skills).toContain('React');
    expect(skills).toContain('Node.js');
  });

  it('不会把 JavaScript 误判成两个技能', () => {
    const skills = detectSkills('精通 JavaScript');
    expect(skills).toContain('JavaScript');
    expect(skills).not.toContain('Java');
  });

  it('不会让 Go 命中 Google 这类单词', () => {
    expect(detectSkills('在 Google 工作过')).not.toContain('Go');
  });

  it('对纯中文技能词正常工作', () => {
    expect(detectSkills('负责大模型应用与提示词工程')).toContain('大模型');
  });
});

describe('mockResumeProfile', () => {
  it('用正则抽出联系方式与城市', () => {
    const profile = mockResumeProfile(RESUME_TEXT);
    expect(profile.name).toBe('张伟');
    expect(profile.phone).toBe('138-0000-1234');
    expect(profile.email).toBe('zhangwei.demo@example.com');
    expect(profile.city).toBe('杭州');
  });

  it('抽出教育经历并把日期规整成 YYYY.MM', () => {
    const profile = mockResumeProfile(RESUME_TEXT);
    expect(profile.education).toHaveLength(1);
    expect(profile.education[0]).toMatchObject({
      school: '浙江大学',
      major: '软件工程',
      degree: '本科',
      graduation_time: '2018.06',
    });
  });

  it('提取到的技能包含简历里写明的技术', () => {
    const skills = mockResumeProfile(RESUME_TEXT).skills;
    expect(skills).toContain('TypeScript');
    expect(skills).toContain('Docker');
    expect(skills).toContain('OpenAI API');
  });

  it('信息缺失时不编造，返回 null 与空数组', () => {
    const profile = mockResumeProfile('这里只有一段无结构的文字');
    expect(profile.phone).toBeNull();
    expect(profile.email).toBeNull();
    expect(profile.education).toEqual([]);
  });
});

describe('mockMatchReport', () => {
  it('四个分数都落在 0-100 之间', () => {
    const report = mockMatchReport(RESUME_TEXT, JD_TEXT);
    for (const field of ['overall_score', 'skill_score', 'experience_score', 'education_score'] as const) {
      expect(report[field]).toBeGreaterThanOrEqual(0);
      expect(report[field]).toBeLessThanOrEqual(100);
    }
  });

  it('评分理由里能看到具体的命中技能与差距', () => {
    const report = mockMatchReport(RESUME_TEXT, JD_TEXT);
    expect(report.comment).toContain('技能匹配度');
    expect(report.comment.length).toBeGreaterThan(20);
  });

  it('面试问题优先围绕 JD 有而简历没有的技能', () => {
    const report = mockMatchReport(RESUME_TEXT, JD_TEXT);
    expect(report.interview_questions.length).toBeGreaterThan(0);
    expect(report.interview_questions.join()).toMatch(/PostgreSQL|Kubernetes|LLM|RAG/);
  });

  it('同一份输入多次调用结果稳定（可复现）', () => {
    const first = mockMatchReport(RESUME_TEXT, JD_TEXT);
    const second = mockMatchReport(RESUME_TEXT, JD_TEXT);
    expect(first).toEqual(second);
  });

  it('JD 为空时不会崩，也不会给出满分', () => {
    const report = mockMatchReport(RESUME_TEXT, '');
    expect(report.overall_score).toBeLessThanOrEqual(100);
    expect(report.overall_score).toBeGreaterThanOrEqual(0);
  });
});
