/**
 * 终端渲染。
 *
 * 刻意不引 chalk / ora / cli-table 这类库：这个工具的输出样式很有限，
 * 手写几十行就能覆盖，还能顺手解决两个库不一定帮你处理的问题：
 *
 *   1. **中日韩字符宽度**：`'姓名'.length` 是 2，但它占 4 个终端格。
 *      直接用 padEnd 对齐必然错位 —— 所以这里自己算显示宽度。
 *   2. **颜色开关**：NO_COLOR / --no-color / 非 TTY 三种情况都要退化成纯文本，
 *      否则管道里会混进一堆 \u001b[32m。
 */

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
} as const;

type ColorName = keyof typeof CODES;

let colorEnabled = process.stdout.isTTY === true;

/** 由 CLI 入口根据 --no-color / NO_COLOR 统一控制 */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

export function isColorEnabled(): boolean {
  return colorEnabled;
}

function paint(text: string, color: ColorName): string {
  if (!colorEnabled) return text;
  return `\u001b[${CODES[color]}m${text}\u001b[${CODES.reset}m`;
}

export const c = {
  bold: (text: string) => paint(text, 'bold'),
  dim: (text: string) => paint(text, 'dim'),
  red: (text: string) => paint(text, 'red'),
  green: (text: string) => paint(text, 'green'),
  yellow: (text: string) => paint(text, 'yellow'),
  blue: (text: string) => paint(text, 'blue'),
  magenta: (text: string) => paint(text, 'magenta'),
  cyan: (text: string) => paint(text, 'cyan'),
  gray: (text: string) => paint(text, 'gray'),
};

/**
 * 计算字符串在终端里的显示宽度。
 * 全角字符（CJK、全角标点）占 2 格，组合字符占 0 格，其余占 1 格。
 */
export function displayWidth(text: string): number {
  let width = 0;
  // 去掉 ANSI 转义序列，否则颜色码会被算进宽度
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  for (const char of plain) {
    const code = char.codePointAt(0)!;
    if (code >= 0x1100 && (
      code <= 0x115f ||                        // 谚文字母
      code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || // CJK 部首 ~ 注音
      (code >= 0xac00 && code <= 0xd7a3) ||    // 谚文音节
      (code >= 0xf900 && code <= 0xfaff) ||    // CJK 兼容汉字
      (code >= 0xfe30 && code <= 0xfe6f) ||    // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) ||    // 全角形式
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x3fffd)     // CJK 扩展 B 及以上
    )) {
      width += 2;
    } else if (code >= 0x0300 && code <= 0x036f) {
      width += 0; // 组合变音符
    } else {
      width += 1;
    }
  }
  return width;
}

/** 按显示宽度右侧补空格 */
export function padDisplay(text: string, targetWidth: number): string {
  const padding = targetWidth - displayWidth(text);
  return padding > 0 ? text + ' '.repeat(padding) : text;
}

/** 按显示宽度截断，超出部分用省略号代替 */
export function truncateDisplay(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  let output = '';
  let width = 0;
  for (const char of text) {
    const charWidth = displayWidth(char);
    if (width + charWidth > maxWidth - 1) break;
    output += char;
    width += charWidth;
  }
  return `${output}…`;
}

/** 输出宽度：跟随终端，但限制在 40-100 之间，避免超宽终端里排版散架 */
export function contentWidth(): number {
  const columns = process.stdout.columns ?? 80;
  return Math.max(40, Math.min(columns, 100));
}

export function divider(char = '─'): string {
  return c.gray(char.repeat(contentWidth()));
}

/** 区块标题：左侧竖线 + 加粗标题 */
export function sectionTitle(title: string): string {
  return `${c.cyan('▌')} ${c.bold(title)}`;
}

/** 键值列表，键按显示宽度对齐 */
export function keyValueList(pairs: Array<[string, string | null | undefined]>, indent = 2): string {
  const visible = pairs.filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (visible.length === 0) return `${' '.repeat(indent)}${c.dim('(无)')}`;

  const labelWidth = Math.max(...visible.map(([key]) => displayWidth(key))) + 2;
  return visible
    .map(([key, value]) => `${' '.repeat(indent)}${c.gray(padDisplay(key, labelWidth))}${value}`)
    .join('\n');
}

const BAR_SEGMENTS = 20;

/** 0-100 的分数条，同时给出颜色语义。越界分数在这里夹取，保证条形与数字一致。 */
export function scoreBar(label: string, score: number, labelWidth?: number): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  const filled = Math.round((clamped / 100) * BAR_SEGMENTS);
  const bar = '█'.repeat(filled) + '░'.repeat(BAR_SEGMENTS - filled);

  const formatted = clamped.toFixed(1);
  const colored =
    clamped >= 80 ? c.green(bar) : clamped >= 60 ? c.yellow(bar) : c.red(bar);
  const scoreText = clamped >= 80 ? c.green(formatted) : clamped >= 60 ? c.yellow(formatted) : c.red(formatted);

  const width = labelWidth ?? Math.max(displayWidth(label), 12);
  return `  ${padDisplay(label, width)}  ${colored}  ${scoreText}`;
}

/** 带标题的结果头部 */
export function resultHeader(title: string, subtitle?: string): string {
  const lines = ['', `${c.cyan('◆')} ${c.bold(title)}`];
  if (subtitle) lines.push(`  ${c.gray(subtitle)}`);
  return lines.join('\n');
}

/** 把长文本按行折叠成带行号的预览，适配终端宽度 */
export function renderTextPreview(text: string, maxLines = 40): string {
  const lines = text.split('\n');
  const shown = lines.slice(0, maxLines);
  const width = contentWidth() - 8;
  const numberWidth = String(lines.length).length;

  const body = shown
    .map((line, index) => {
      const number = c.gray(padDisplay(String(index + 1), numberWidth));
      return `  ${number} ${c.gray('│')} ${truncateDisplay(line, width)}`;
    })
    .join('\n');

  const omitted = lines.length - shown.length;
  const suffix = omitted > 0 ? `\n  ${c.dim(`… 其余 ${omitted} 行已省略（使用 --full 查看全部）`)}` : '';
  return body + suffix;
}

/** 一行状态提示：成功 / 警告 / 提示 */
export function statusLine(kind: 'ok' | 'warn' | 'info', message: string): string {
  if (kind === 'ok') return `${c.green('✔')} ${message}`;
  if (kind === 'warn') return `${c.yellow('▲')} ${message}`;
  return `${c.cyan('·')} ${message}`;
}

/**
 * 按显示宽度折行。
 *
 * 中文可以逐字断，但英文单词、路径、URL 被从中间切开会很难读（`Pytho` / `n`），
 * 所以这里先按"拉丁词 / 空白 / 单个字符"切 token，再判断放不放得下。
 * 放不下时，如果当前行尾部是空格就退到空格处断行，否则才硬切。
 *
 * 另外实现了一条中日韩排版的"避头尾"规则：顿号、逗号、右括号等标点不允许出现在行首，
 * 宁可让上一行略超出 1 个字符宽度，也不要出现"、React"这种断法。
 */
const FORBIDDEN_LINE_START = /^[、。，；：！？）》」』】〕〉…—·,.;:!?)\]}]$/;

/** 硬切：把一段文本按显示宽度切成不超过 maxWidth 的片段（用于超长单词、URL） */
function hardSplit(segment: string, maxWidth: number): string[] {
  const parts: string[] = [];
  let current = '';
  for (const char of segment) {
    if (displayWidth(current) + displayWidth(char) > maxWidth && current.length > 0) {
      parts.push(current);
      current = '';
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

export function wrapLines(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }
    const tokens = paragraph.match(/[A-Za-z0-9_\-./+#%:@]+|\s+|[\s\S]/g) ?? [];
    let current = '';

    for (const token of tokens) {
      // 单个 token 比整行还宽（长 URL、长英文串）：先收尾当前行，再硬切
      if (displayWidth(token) > safeWidth) {
        if (current.trim().length > 0) {
          lines.push(current.replace(/\s+$/, ''));
          current = '';
        }
        const parts = hardSplit(token, safeWidth);
        lines.push(...parts.slice(0, -1));
        current = parts[parts.length - 1] ?? '';
        continue;
      }

      const overflows = displayWidth(current) + displayWidth(token) > safeWidth;
      if (overflows && current.trim().length > 0 && !FORBIDDEN_LINE_START.test(token)) {
        lines.push(current.replace(/\s+$/, ''));
        current = /^\s+$/.test(token) ? '' : token;
      } else {
        current += token;
      }
    }
    lines.push(current.replace(/\s+$/, ''));
  }
  return lines;
}

/**
 * 折行并保持缩进：首行用 firstIndent，续行用 indent。
 * 用于"1. 问题……（换行）继续内容"这类需要对齐的排版。
 */
export function wrapWithIndent(text: string, firstIndent: string, indent: string, width: number): string[] {
  const lines = wrapLines(text, width - displayWidth(firstIndent));
  return lines.map((line, index) => (index === 0 ? firstIndent + line : indent + line));
}
