import { describe, expect, it } from 'vitest';
import { parseModelJson } from '../src/core/json';

/** 便捷断言：解析成功且值符合预期 */
function expectParsed<T>(raw: string, expected: T): void {
  const result = parseModelJson<T>(raw);
  expect(result.value).toEqual(expected);
}

describe('parseModelJson - 正常输入', () => {
  it('直接解析合法 JSON，不记录任何修复', () => {
    const result = parseModelJson('{"name":"张伟"}');
    expect(result.value).toEqual({ name: '张伟' });
    expect(result.repairs).toEqual([]);
  });

  it('忽略首尾空白', () => {
    expectParsed('  \n {"a":1} \n ', { a: 1 });
  });
});

describe('parseModelJson - 自动修复', () => {
  it('剥离 Markdown 代码围栏', () => {
    const raw = '```json\n{"name":"张伟","skills":["React"]}\n```';
    expectParsed(raw, { name: '张伟', skills: ['React'] });
  });

  it('剥离没有语言标记的围栏', () => {
    expectParsed('```\n{"a":1}\n```', { a: 1 });
  });

  it('从解释性文字中截出 JSON', () => {
    const raw = '好的，以下是根据简历提取的信息：\n{"name":"张伟"}\n希望有帮助！';
    expectParsed(raw, { name: '张伟' });
  });

  it('字符串里出现花括号时不会误判边界', () => {
    const raw = '结果如下：{"comment":"他写过 if (a) { return b } 这样的代码"} 完成';
    expectParsed(raw, { comment: '他写过 if (a) { return b } 这样的代码' });
  });

  it('移除 // 注释', () => {
    expectParsed('{\n  // 姓名\n  "name": "张伟"\n}', { name: '张伟' });
  });

  it('移除 /* */ 注释', () => {
    expectParsed('{ /* 块注释 */ "name": "张伟" }', { name: '张伟' });
  });

  it('把中文引号还原成直引号', () => {
    expectParsed('{“name”：“张伟”}', { name: '张伟' });
  });

  it('把单引号转成双引号', () => {
    expectParsed("{'name': '张伟', 'skills': ['React']}", { name: '张伟', skills: ['React'] });
  });

  it('移除对象结尾的尾随逗号', () => {
    expectParsed('{"name":"张伟","skills":["React",],}', { name: '张伟', skills: ['React'] });
  });

  it('转义字符串里的裸换行', () => {
    const raw = '{"comment":"第一行\n第二行"}';
    expectParsed(raw, { comment: '第一行\n第二行' });
  });

  it('把 Python 字面量转成 JSON', () => {
    expectParsed('{"a":True,"b":False,"c":None}', { a: true, b: false, c: null });
  });

  it('补全被 max_tokens 截断的 JSON', () => {
    const raw = '{"overall_score": 82, "comment": "候选人具备较好的全栈开发基础", "interview_questions": ["问题一", "问题二';
    const result = parseModelJson<{ overall_score: number; interview_questions: string[] }>(raw);
    expect(result.value.overall_score).toBe(82);
    expect(Array.isArray(result.value.interview_questions)).toBe(true);
  });

  it('对嵌套结构截断也能补全', () => {
    const raw = '{"education":[{"school":"浙江大学","major":"软件工程"},{"school":"某中学"';
    const result = parseModelJson<{ education: Array<{ school: string }> }>(raw);
    expect(result.value.education.length).toBeGreaterThanOrEqual(1);
    expect(result.value.education[0]!.school).toBe('浙江大学');
  });

  it('组合多个问题也能一次修好', () => {
    const raw = [
      '```json',
      '{',
      "  'name': '张伟',   // 姓名",
      "  'city': “杭州”,",
      "  'skills': ['React', 'TypeScript',],",
      '}',
      '```',
    ].join('\n');
    expectParsed(raw, { name: '张伟', city: '杭州', skills: ['React', 'TypeScript'] });
  });

  it('记录实际生效的修复步骤', () => {
    const result = parseModelJson('```json\n{"a":1}\n```');
    expect(result.repairs.length).toBeGreaterThan(0);
    expect(result.repairs.join(',')).toContain('围栏');
  });

  it('合法 JSON 即使带中文标点也不应被改写', () => {
    // 引号内的内容必须原样保留，修复不能动正文
    const raw = '{"comment":"他说：\\"这个方案（A）更好，但成本上升 30%。\\""}';
    expectParsed(raw, { comment: '他说："这个方案（A）更好，但成本上升 30%。"' });
  });
});

describe('parseModelJson - 无法修复', () => {
  it('完全不是 JSON 时抛出 SyntaxError', () => {
    expect(() => parseModelJson('抱歉，我无法完成这个请求。')).toThrow(SyntaxError);
  });

  it('空字符串抛出 SyntaxError', () => {
    expect(() => parseModelJson('')).toThrow(SyntaxError);
  });
});
