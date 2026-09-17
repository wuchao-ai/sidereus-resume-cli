import { describe, expect, it } from 'vitest';
import {
  cleanExtractedText,
  isCompatibilityCodePoint,
  normalizeCompatibilityChars,
  normalizeWhitespace,
  repairCommonArtifacts,
} from '../src/core/text';

describe('normalizeCompatibilityChars', () => {
  it('把康熙部首折回标准汉字', () => {
    // U+2F2F KANGXI RADICAL WORK → 工（注意 U+2F27 是「宀」，容易记错）
    expect(normalizeCompatibilityChars('\u2F2F程师')).toBe('工程师');
    expect(normalizeCompatibilityChars('\u2F27')).toBe('宀');
  });

  it('把 CJK 部首补充里的简体部首折回简体汉字', () => {
    // U+2EDA CJK RADICAL C-SIMPLIFIED LEAF → 页（不是繁体「頁」）
    expect(normalizeCompatibilityChars('业务\u2EDA面')).toBe('业务页面');
    expect(normalizeCompatibilityChars('\u2EE2\u2EAF')).toBe('马糸');
    expect(normalizeCompatibilityChars('\u2EDB\u2EDC')).toBe('风飞');
  });

  it('把 CJK 兼容汉字折回统一汉字', () => {
    expect(normalizeCompatibilityChars('\uFA0C')).toBe('兀');
  });

  it('保留中文全角标点，只折全角字母数字', () => {
    // 全角标点必须原样保留，否则中文排版会被破坏
    expect(normalizeCompatibilityChars('（测试）：Ｒｅａｃｔ ２０％')).toBe('（测试）：React 20%');
  });

  it('不动普通汉字与英文', () => {
    const input = '浙江大学 · Software Engineering';
    expect(normalizeCompatibilityChars(input)).toBe(input);
  });

  it('isCompatibilityCodePoint 能识别需要处理的码点', () => {
    expect(isCompatibilityCodePoint(0x2eda)).toBe(true);
    expect(isCompatibilityCodePoint(0x2f27)).toBe(true);
    expect(isCompatibilityCodePoint(0xff21)).toBe(true);
    expect(isCompatibilityCodePoint(0x5de5)).toBe(false); // 工
  });
});

describe('repairCommonArtifacts', () => {
  it('移除零宽字符与软连字符', () => {
    expect(repairCommonArtifacts('张\u200b伟\u00ad')).toBe('张伟');
  });

  it('把不换行空格统一成普通空格', () => {
    expect(repairCommonArtifacts('张伟\u00a0前端')).toBe('张伟 前端');
  });

  it('还原拉丁连字', () => {
    // U+FB03 = LATIN SMALL LIGATURE FFI；用 fromCharCode 写避免转义序列难读
    expect(repairCommonArtifacts(`o${String.fromCharCode(0xfb03)}ce`)).toBe('office');
  });
});

describe('normalizeWhitespace', () => {
  it('压缩行内多余空格', () => {
    expect(normalizeWhitespace('a    b')).toBe('a b');
  });

  it('把三个以上换行压成两个', () => {
    expect(normalizeWhitespace('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('去掉行首行尾空白', () => {
    expect(normalizeWhitespace('  \n a \n  ')).toBe('a');
  });
});

describe('cleanExtractedText', () => {
  it('端到端清洗一段带多种噪声的文本', () => {
    const dirty = '  业务\u2EDA面\u200b   开发\t\n\n\n\n工程师  ';
    expect(cleanExtractedText(dirty)).toBe('业务页面 开发\n\n工程师');
  });
});
