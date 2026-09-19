import { beforeEach, describe, expect, it } from 'vitest';
import { displayWidth, padDisplay, truncateDisplay, wrapLines, wrapWithIndent, scoreBar, setColorEnabled } from '../src/core/ui';

beforeEach(() => {
  // 测试里固定关闭颜色，保证断言的是纯文本
  setColorEnabled(false);
});

/**
 * 是否出现了"孤立代理码元"。
 *
 * 一个 emoji 在 UTF-16 里是两个码元（高位 + 低位）。按码元切分字符串时，
 * 刀口正好落在中间就会切出半个字符，终端渲染成乱码方块。
 * 这里手动按码元走一遍，不依赖 String.prototype.isWellFormed（Node 版本较新才有）。
 */
function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i += 1; // 合法代理对，跳过低位
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // 低位代理，前面没有与之配对的高位
    }
  }
  return false;
}

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

  it('emoji 按 2 格计算（终端就是这么渲染的）', () => {
    expect(displayWidth('👍')).toBe(2);
    expect(displayWidth('a👍b')).toBe(4);
  });

  it('零宽字符不占格：变体选择符、ZWJ、肤色修饰符', () => {
    expect(displayWidth('\uFE0F')).toBe(0);
    expect(displayWidth('\u200D')).toBe(0);
    expect(displayWidth('👍\uFE0F')).toBe(2);
    expect(displayWidth('👍🏽')).toBe(2);
  });

  it('已知不精确之处：ZWJ 连字序列按码位数累加，会偏宽', () => {
    // 👨‍👩‍👧 由 3 个 emoji + 2 个 ZWJ 组成，实际渲染是 1 个 2 格字形，这里算出 6 格。
    // 这行断言记录的是"现状"而不是"正确"：简历正文不会出现连字序列，
    // 不值得为它引一张几百行的 emoji 宽度表。若哪天真的要对齐，先改这里。
    expect(displayWidth('👨\u200D👩\u200D👧')).toBe(6);
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

  it('截断 emoji 文本时不切出孤立代理码元', () => {
    const result = truncateDisplay('👍👍👍👍👍👍', 5);
    expect(hasLoneSurrogate(result)).toBe(false);
    expect(displayWidth(result)).toBeLessThanOrEqual(5);
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

  it('emoji 不会被拆成两个孤立半区', () => {
    // 回归用例：token 切分正则漏了 u 标志时，[\s\S] 按 UTF-16 码元匹配，
    // 代理对会被切开，拼回去就是乱码方块。
    const text = 'a👍🏽b👍🏽c👍🏽d';
    const lines = wrapLines(text, 4);

    for (const line of lines) {
      expect(hasLoneSurrogate(line)).toBe(false);
    }
    expect(hasLoneSurrogate(lines.join(''))).toBe(false);
  });

  it('折行后再拼接能还原原文', () => {
    const text = '一二三👍四五';
    expect(wrapLines(text, 6).join('')).toBe(text);
  });

  it('零宽修饰符永远跟着前一个字符，不会孤零零出现在行首', () => {
    const lines = wrapLines('abcd👍🏽ef', 5);
    expect(lines.some((line) => line.startsWith('🏽'))).toBe(false);
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
