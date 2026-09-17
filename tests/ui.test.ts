import { beforeEach, describe, expect, it } from 'vitest';
import { displayWidth, padDisplay, truncateDisplay, wrapLines, wrapWithIndent, scoreBar, setColorEnabled } from '../src/core/ui';

beforeEach(() => {
  // 测试里固定关闭颜色，保证断言的是纯文本
  setColorEnabled(false);
});

describe('displayWidth', () => {
  it('汉字按 2 格计算', () => {
    expect(displayWidth('姓名')).toBe(4);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('张伟abc')).toBe(7);
  });

  it('全角标点按 2 格计算', () => {
    expect(displayWidth('（a）')).toBe(5);
  });

  it('忽略 ANSI 颜色码', () => {
    expect(displayWidth('\u001b[32mabc\u001b[0m')).toBe(3);
  });

  it('空字符串为 0', () => {
    expect(displayWidth('')).toBe(0);
  });
});

describe('padDisplay', () => {
  it('按显示宽度右侧补空格，中英混排也能对齐', () => {
    expect(padDisplay('姓名', 10)).toBe('姓名' + ' '.repeat(6));
    expect(padDisplay('abc', 10)).toBe('abc' + ' '.repeat(7));
    // 两者补到同一宽度
    expect(displayWidth(padDisplay('姓名', 10))).toBe(displayWidth(padDisplay('abc', 10)));
  });

  it('超宽时原样返回，不截断', () => {
    expect(padDisplay('超长文本内容', 4)).toBe('超长文本内容');
  });
});

describe('truncateDisplay', () => {
  it('不超宽时原样返回', () => {
    expect(truncateDisplay('abc', 10)).toBe('abc');
  });

  it('超宽时截断并加省略号，且总宽度不超标', () => {
    const result = truncateDisplay('这是一段很长的中文文本内容', 10);
    expect(displayWidth(result)).toBeLessThanOrEqual(10);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('wrapLines', () => {
  it('按宽度折行', () => {
    const lines = wrapLines('0123456789abcdefghij', 10);
    expect(lines).toEqual(['0123456789', 'abcdefghij']);
  });

  it('不把英文单词从中间切断', () => {
    const lines = wrapLines('hello TypeScript world', 12);
    expect(lines).toEqual(['hello', 'TypeScript', 'world']);
  });

  it('避免标点出现在行首（避头尾）', () => {
    // 宽度刚好让「，」落在行首位置，此时应把标点留在上一行
    const lines = wrapLines('一二三四五，六七', 6);
    expect(lines[0]!.endsWith('，')).toBe(true);
    expect(lines.some((line) => line.startsWith('，'))).toBe(false);
  });

  it('保留显式换行', () => {
    expect(wrapLines('第一行\n第二行', 20)).toEqual(['第一行', '第二行']);
  });

  it('空行保留', () => {
    expect(wrapLines('a\n\nb', 20)).toEqual(['a', '', 'b']);
  });

  it('非法宽度会被兜底到最小值，不会死循环', () => {
    expect(wrapLines('abcdefghij', 0).length).toBeGreaterThan(0);
  });
});

describe('wrapWithIndent', () => {
  it('首行和续行使用不同缩进，保持视觉对齐', () => {
    const lines = wrapWithIndent('一二三四五六七八九十', '1. ', '   ', 8);
    expect(lines[0]!.startsWith('1. ')).toBe(true);
    for (const line of lines.slice(1)) {
      expect(line.startsWith('   ')).toBe(true);
    }
  });
});

describe('scoreBar', () => {
  it('包含分数数值', () => {
    const bar = scoreBar('技能匹配', 88);
    expect(bar).toContain('88.0');
    expect(bar).toContain('█');
    expect(bar).toContain('░');
  });

  it('0 分与 100 分都不越界', () => {
    expect(scoreBar('a', 0)).toContain('0.0');
    expect(scoreBar('b', 100)).toContain('100.0');
    // 越界值被夹取
    expect(scoreBar('c', 150)).toContain('100.0');
  });
});
