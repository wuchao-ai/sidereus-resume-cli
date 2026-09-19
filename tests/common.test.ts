import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { formatBytes, parsePositiveInt } from '../src/commands/common';

describe('parsePositiveInt', () => {
  it('接受正常正整数（并容忍前后空格）', () => {
    expect(parsePositiveInt('40')).toBe(40);
    expect(parsePositiveInt(' 12 ')).toBe(12);
    expect(parsePositiveInt('1')).toBe(1);
  });

  it('拒绝 0 与负数', () => {
    // -5 必须被拦住：它会一路流进 slice(0, -5)，把末尾 5 行悄悄吃掉，
    // 用户拿到的结果不完整却看不到任何提示。
    expect(() => parsePositiveInt('0')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('-5')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('-0')).toThrow(InvalidArgumentError);
  });

  it('拒绝非数字、小数与带尾巴的输入', () => {
    // parseInt('12abc') 会返回 12，这种"猜用户意图"的行为在参数校验里是隐患
    expect(() => parsePositiveInt('abc')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('3.5')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('12abc')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('1e3')).toThrow(InvalidArgumentError);
    expect(() => parsePositiveInt('0x10')).toThrow(InvalidArgumentError);
  });

  it('错误信息里带原始输入，方便用户定位到是哪个参数写错了', () => {
    expect(() => parsePositiveInt('-5')).toThrow(/"-5"/);
    expect(() => parsePositiveInt('abc')).toThrow(/"abc"/);
  });
});

describe('formatBytes', () => {
  it('按量级切换单位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });
});
