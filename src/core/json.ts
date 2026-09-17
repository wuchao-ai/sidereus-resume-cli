/**
 * 大模型返回值的 JSON 解析与自动修复。
 *
 * 现实情况：即使提示词里写死"只返回 JSON"，模型仍然会时不时给你——
 *   · 包一层 ```json 代码围栏
 *   · 前面加一句"好的，以下是根据简历提取的信息："
 *   · 尾随逗号、中文引号、单引号
 *   · 在字符串里写裸换行
 *   · 被 max_tokens 截断，缺右括号
 *
 * 这些东西不该让命令直接失败。所以这里做一条"逐级尝试"的修复管线：
 * 每一步都先试着按当前文本 JSON.parse，成功就停 —— 这样修复记录是准确的，
 * 不会出现"明明能解析却报告修了十处"的误报。
 *
 * 设计取向：**修复要保守**。每一条修复规则都只处理确定能识别的模式，
 * 宁可报错让人看到原文，也不要把内容改成另一个意思。
 */

export interface ParsedModelJson<T = unknown> {
  value: T;
  /** 实际生效的修复步骤描述，用于日志与 --verbose 展示 */
  repairs: string[];
}

/** 去掉 UTF-8 BOM 等不可见前缀 */
function stripBom(input: string): string {
  return input.replace(/^\uFEFF/, '');
}

/** 剥掉 ```json ... ``` 围栏；只有确实成对出现时才动 */
function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenced = /^```(?:json|JSON|javascript|js)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return fenced?.[1] ? fenced[1].trim() : input;
}

/**
 * 从一段自由文本里截出第一个完整的 JSON 值。
 * 用栈扫描而不是正则，因为字符串里出现的 { } 不能算数。
 */
function extractBalancedJson(input: string): string | null {
  const start = input.search(/[{[]/);
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      stack.pop();
      if (stack.length === 0) return input.slice(start, i + 1);
    }
  }
  // 走到结尾仍未闭合：返回剩余全部，交给后面的补全逻辑处理
  return input.slice(start);
}

/** 去掉 // 与 /* *\/ 两种注释（引号内不处理） */
function stripComments(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i += 1;
      output += '\n';
      continue;
    }
    if (char === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    output += char;
  }
  return output;
}

/**
 * 把全角语法字符折成半角：引号、冒号、逗号。
 *
 * 中文输入法下敲出的 `{“name”：“张伟”}` 是模型返回里最常见的一种"非法 JSON"，
 * 它的问题不止引号 —— 中间那个全角冒号 `：` 同样不被 JSON 语法接受。
 *
 * 替换范围严格限制在**字符串之外**：引号内的中文标点是正文（比如评语里的「……」），
 * 折成半角就改变了内容。
 */
function normalizeFullwidthSyntax(input: string): string {
  // 先统一引号，后面才能正确判断哪些区域属于"字符串内部"
  const withStraightQuotes = input
    .replace(/[\u201c\u201d\u2033\uff02]/g, '"')
    .replace(/[\u2018\u2019\u2032\uff07]/g, "'");

  const CHAR_MAP: Record<string, string> = {
    '\uff1a': ':', // ：
    '\uff0c': ',', // ，
    '\u3001': ',', // 、
    '\uff1b': ';', // ；
  };

  let output = '';
  let inString = false;
  let escaped = false;

  for (const char of withStraightQuotes) {
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    output += CHAR_MAP[char] ?? char;
  }
  return output;
}

/**
 * 单引号 → 双引号。
 *
 * 难点在于区分"引号"和"撇号"：`{'name': '张三'}` 里的单引号是定界符，
 * 而 `{"comment": "it's fine"}` 里的单引号是内容的一部分，不能动。
 *
 * 判据是位置：只有当单引号出现在「值的开始处」（前一个有效字符是 `:` `,` `[` `{`）
 * 或「值的结束处」（后一个有效字符是 `:` `,` `]` `}`）时，才认定它是定界符。
 * 这样 `it's` 这种夹在字母之间的撇号会被自然放过。
 */
function convertSingleQuotes(input: string): string {
  const valueBoundaryBefore = new Set(['', ':', ',', '[', '{']);
  const valueBoundaryAfter = new Set(['', ':', ',', ']', '}']);

  let output = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;

    // 转义序列整体跳过，避免把 \" 里的引号误判成字符串边界
    if (char === '\\' && i + 1 < input.length) {
      const next = input[i + 1]!;
      // 单引号字符串里的 \' 在目标格式（双引号）中不需要转义
      output += inSingle && next === "'" ? "'" : char + next;
      i += 1;
      continue;
    }

    if (inDouble) {
      output += char;
      if (char === '"') inDouble = false;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      output += char;
      continue;
    }

    if (char === "'") {
      if (inSingle) {
        inSingle = false;
        output += '"';
        continue;
      }
      const prev = output.replace(/\s+$/, '').slice(-1);
      const next = input.slice(i + 1).trimStart().charAt(0);
      if (valueBoundaryBefore.has(prev) || valueBoundaryAfter.has(next)) {
        inSingle = true;
        output += '"';
        continue;
      }
      // 撇号，保持原样
      output += "'";
      continue;
    }

    output += char;
  }
  return output;
}

/** 去掉对象/数组结尾多余的逗号（引号内不处理） */
function stripTrailingCommas(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ',') {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j += 1;
      if (input[j] === '}' || input[j] === ']') continue; // 丢弃这个逗号
    }
    output += char;
  }
  return output;
}

/** 字符串内部的裸换行/制表符 → 转义写法 */
function escapeRawControlChars(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }
      if (char === '\\') {
        output += char;
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
        output += char;
        continue;
      }
      if (char === '\n') {
        output += '\\n';
        continue;
      }
      if (char === '\r') continue;
      if (char === '\t') {
        output += '\\t';
        continue;
      }
      output += char;
      continue;
    }
    if (char === '"') inString = true;
    output += char;
  }
  return output;
}

/** Python 风格字面量 → JSON 字面量（引号内不处理，避免误伤正文） */
function normalizeLiterals(input: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    const rest = input.slice(i);
    const literal = /^(True|False|None|NaN|Infinity)\b/.exec(rest);
    if (literal) {
      const word = literal[1]!;
      output += word === 'True' ? 'true' : word === 'False' ? 'false' : 'null';
      i += word.length - 1;
      continue;
    }
    output += char;
  }
  return output;
}

/**
 * 补全被截断的 JSON。
 *
 * 场景：模型输出很长，撞上 max_tokens 被硬切断，右括号没来得及写。
 * 策略是先砍掉最后一个"不完整片段"，再按括号栈补齐收尾 ——
 * 宁可丢掉最后一个字段，也不要把半个字符串当成合法值。
 */
function repairTruncatedJson(input: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafeIndex = -1; // 最后一个"可以安全收尾"的位置（逗号或开括号之后）

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      stack.pop();
      if (stack.length === 0) return input.slice(0, i + 1); // 本来就完整
    } else if (char === ',' && stack.length > 0) lastSafeIndex = i;
  }

  if (stack.length === 0) return input;

  // 从头截到最后一个安全位置，避免把 `"name": "张` 这种半截值留下
  let body = lastSafeIndex >= 0 ? input.slice(0, lastSafeIndex) : input;
  // 重算截断后的括号栈
  const reopened: string[] = [];
  let inStr = false;
  let esc = false;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (char === '\\') esc = true;
      else if (char === '"') inStr = false;
      continue;
    }
    if (char === '"') inStr = true;
    else if (char === '{' || char === '[') reopened.push(char);
    else if (char === '}' || char === ']') reopened.pop();
  }
  if (inStr) body = `${body}"`; // 截断处正好落在字符串中间，补个收尾引号

  const closing = reopened
    .reverse()
    .map((open) => (open === '{' ? '}' : ']'))
    .join('');
  return body + closing;
}

interface RepairStep {
  label: string;
  apply: (input: string) => string;
}

/**
 * 逐级尝试的修复管线。顺序从"最保守、最可能无损"到"侵入性较强"。
 * 每一次变换后都会尝试解析，一旦成功立即返回，保证 repairs 描述的是真实生效的步骤。
 */
const REPAIR_PIPELINE: RepairStep[] = [
  { label: '去掉 UTF-8 BOM', apply: stripBom },
  { label: '剥离 Markdown 代码围栏', apply: stripCodeFence },
  // 必须排在截取边界之前：中文引号不先归一化，扫描器会把引号里的 } 当成结构结束符
  { label: '全角引号/冒号/逗号转半角', apply: normalizeFullwidthSyntax },
  { label: '截取首个平衡的 JSON 片段', apply: (s) => extractBalancedJson(s) ?? s },
  { label: '移除注释', apply: stripComments },
  { label: '单引号转双引号', apply: convertSingleQuotes },
  { label: '移除对象/数组尾随逗号', apply: stripTrailingCommas },
  { label: '转义字符串内裸控制字符', apply: escapeRawControlChars },
  { label: 'Python 字面量转 JSON（True/False/None）', apply: normalizeLiterals },
  { label: '补全被截断的括号', apply: repairTruncatedJson },
];

/**
 * 解析模型返回的 JSON，必要时自动修复。
 *
 * @throws SyntaxError 当所有修复手段都无法得到合法 JSON 时抛出（由调用方包装成 CliError）
 */
export function parseModelJson<T = unknown>(raw: string): ParsedModelJson<T> {
  const repairs: string[] = [];
  let text = raw.trim();

  const attempt = (candidate: string): T | undefined => {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return undefined;
    }
  };

  const direct = attempt(text);
  if (direct !== undefined) return { value: direct, repairs };

  // 渐进式修复：每一步都在上一步结果上叠加，但只有真正改变了文本才记录
  let current = text;
  for (const step of REPAIR_PIPELINE) {
    const next = step.apply(current);
    if (next === current) continue;
    current = next;
    repairs.push(step.label);

    const parsed = attempt(current);
    if (parsed !== undefined) return { value: parsed, repairs };
  }

  // 全部失败：把最终形态抛出去，方便上层在报错里展示原文片段
  text = current;
  const error = new SyntaxError('无法将模型返回内容解析为 JSON');
  (error as SyntaxError & { raw?: string }).raw = text;
  throw error;
}
