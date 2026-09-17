/**
 * 文本清洗。
 *
 * ## 为什么需要单独一层
 *
 * PDF 里存的不是"字符"，而是"字形 + 编码映射"。生成 PDF 的工具经常把汉字
 * 映射到 Unicode 的兼容区，提出来看着像汉字、实际却是另一个码点。
 * 典型例子：「业务页面」的「页」可能是 U+2EDA（CJK 部首·页）而不是 U+9875（页）。
 *
 * 这类字符有三个实际危害：
 *   1. 传到 JSON 里，姓名/学校/技能看着"有脏字符"，评审会以为是程序 bug；
 *   2. `grep`、`===`、数据库唯一索引这类精确匹配全部失效；
 *   3. 字宽计算、排版对齐跟着一起错位。
 * 所以必须在进入业务层之前归一化。
 *
 * ## 处理策略：三层，按"能否用标准手段解决"排序
 *
 *   L1 单字符 NFKC     —— 覆盖康熙部首（U+2F00–U+2FDF）、CJK 兼容汉字（U+F900–U+FAFF）
 *                          这些码点在 Unicode 里本来就定义了等价映射，直接用标准能力。
 *   L2 显式等价表      —— 覆盖 CJK 部首补充（U+2E80–U+2EF3）。**这批字符大多没有 NFKC 映射**，
 *                          只能靠显式表，见下方 RADICAL_EQUIVALENTS。
 *   L3 全角/半角收敛   —— 全角 ASCII 折半角，但保留「，：；！？（）」这几个中文标点，
 *                          否则「注意，这是重点」会变成「注意,这是重点」，中文排版就散了。
 *
 * 刻意**不**对整串调用 `String.normalize('NFKC')`：那会顺手把「（）」压成「()」、
 * 把「㎡」拆成「m2」、把「IX」变成「IX」，对中文简历属于过度处理。
 * 逐字符折叠才能控制影响范围。
 */

/**
 * CJK 部首补充（U+2E80–U+2EF3）→ 等价汉字的显式映射。
 *
 * 生成方式（可复现）：先用 Unicode 字符名把「CJK RADICAL X」与「KANGXI RADICAL X」
 * 对齐，再取康熙部首的 NFKC 结果得到等价汉字；随后**人工逐条复核**，
 * 剔除 3 处名称子串误匹配（`⺀`REPEAT 误中 EAT、`⺤`PAW ONE/TWO 误中 ONE/TWO），
 * 并把 `C-SIMPLIFIED` / `J-SIMPLIFIED` 系列直接落到中文简体字
 * —— 因为这类部首本身就是简体字形（`⻚` 出现在简体文本里，折成繁体「頁」仍然不对）。
 *
 * 未收录的码点（如 U+2E80 重复符、U+2E82 等纯变体符号）没有等价汉字，保持原样。
 */
const RADICAL_EQUIVALENTS: ReadonlyMap<number, string> = new Map(
  [
    '2E81:厂', '2E84:乙', '2E87:几', '2E8A:卜', '2E8B:卩', '2E90:尢', '2E91:尢', '2E93:幺',
    '2E98:手', '2E99:攴', '2E9C:日', '2E9D:月', '2E9E:歹', '2EA3:火', '2EA4:爪', '2EA5:爪',
    '2EA6:爿', '2EA7:牛', '2EA8:犬', '2EA9:玉', '2EAA:疋', '2EAB:目', '2EAE:竹', '2EAF:糸',
    '2EB0:纟', '2EB3:网', '2EB4:网', '2EB6:羊', '2EB9:老', '2EBC:肉', '2EBD:臼', '2EC0:艹',
    '2EC1:虍', '2EC2:衣', '2EC5:见', '2EC6:角', '2EC7:角', '2EC8:讠', '2EC9:贝', '2ECA:足',
    '2ECB:车', '2ECC:辶', '2ECF:邑', '2ED3:长', '2ED4:门', '2ED7:雨', '2ED8:青', '2EDA:页',
    '2EDB:风', '2EDC:飞', '2EDF:食', '2EE0:饣', '2EE1:首', '2EE2:马', '2EE3:骨', '2EE4:鬼',
    '2EE5:鱼', '2EE6:鸟', '2EE7:卤', '2EE8:麦', '2EE9:黄', '2EEA:黾', '2EEB:齐', '2EEC:齐',
    '2EED:齿', '2EEE:齿', '2EF1:龟', '2EF2:龟', '2EF3:龟',
  ].map((entry) => {
    const [code, char] = entry.split(':') as [string, string];
    return [Number.parseInt(code, 16), char] as const;
  }),
);

/** 判断某个码点是否存在显式等价汉字 */
export function hasRadicalEquivalent(codePoint: number): boolean {
  return RADICAL_EQUIVALENTS.has(codePoint);
}

/** 该码点是否属于"需要归一化的兼容/部首字符"，用于测试与体检 */
export function isCompatibilityCodePoint(codePoint: number): boolean {
  return (
    RADICAL_EQUIVALENTS.has(codePoint) ||
    (codePoint >= 0x2e80 && codePoint <= 0x2fdf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff01 && codePoint <= 0xff5e) ||
    (codePoint >= 0xff66 && codePoint <= 0xffdc)
  );
}

/** 能否用标准 NFKC 折叠（康熙部首、兼容汉字） */
function hasNfkcMapping(codePoint: number): boolean {
  if (codePoint >= 0x2f00 && codePoint <= 0x2fdf) return true; // 康熙部首
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return true; // CJK 兼容汉字
  return false;
}

/**
 * 中文语境下必须保留的全角标点。
 * 折成半角会让排版变味（「注意，这是重点」变成「注意,这是重点」），所以只放过字母数字和符号。
 */
const PRESERVED_FULLWIDTH_PUNCTUATION = new Set([
  0xff01, // ！
  0xff08, // （
  0xff09, // ）
  0xff0c, // ，
  0xff1a, // ：
  0xff1b, // ；
  0xff1f, // ？
]);

/** 全角 ASCII → 半角：字母数字和符号都折，中文标点保留 */
function foldFullwidthAscii(codePoint: number): string | null {
  if (codePoint < 0xff01 || codePoint > 0xff5e) return null;
  if (PRESERVED_FULLWIDTH_PUNCTUATION.has(codePoint)) return null;
  return String.fromCharCode(codePoint - 0xfee0);
}

/** 半角片假名 / 半角谚文 → 全角形式 */
function foldHalfwidthKana(codePoint: number): string | null {
  if ((codePoint >= 0xff66 && codePoint <= 0xff9f) || (codePoint >= 0xffa0 && codePoint <= 0xffdc)) {
    return String.fromCharCode(codePoint).normalize('NFKC');
  }
  return null;
}

/**
 * 归一化 PDF 文本中的兼容字符。
 * 逐字符处理 —— 单字符折叠不会波及相邻字符，因此不会误伤中文标点。
 */
export function normalizeCompatibilityChars(input: string): string {
  let output = '';
  for (const char of input) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      output += char;
      continue;
    }

    const explicit = RADICAL_EQUIVALENTS.get(codePoint);
    if (explicit !== undefined) {
      output += explicit;
      continue;
    }
    if (hasNfkcMapping(codePoint)) {
      output += char.normalize('NFKC');
      continue;
    }
    const fullwidth = foldFullwidthAscii(codePoint);
    if (fullwidth !== null) {
      output += fullwidth;
      continue;
    }
    const kana = foldHalfwidthKana(codePoint);
    output += kana ?? char;
  }
  return output;
}

/** 软连字符、零宽字符、不换行空格、拉丁连字等零散噪声的清理 */
export function repairCommonArtifacts(input: string): string {
  return input
    // 软连字符 / 零宽字符：PDF 分页或断词时会插入，肉眼不可见但会污染 JSON
    .replace(/[\u00ad\u200b\u200c\u200d\ufeff]/g, '')
    // 不换行空格与各类窄空格统一成普通空格
    .replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    // 常见拉丁连字
    .replace(/\ufb00/g, 'ff')
    .replace(/\ufb01/g, 'fi')
    .replace(/\ufb02/g, 'fl')
    .replace(/\ufb03/g, 'ffi')
    .replace(/\ufb04/g, 'ffl');
}

/**
 * 规整空白：行内连续空格压成一个，三个以上连续换行压成两个。
 * 不做更激进的合并 —— 换行本身是简历的版面信息，对后续分段有帮助。
 */
export function normalizeWhitespace(input: string): string {
  return input
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 业务层统一入口，顺序有意义：先去零宽字符，再折兼容字，最后规整空白。 */
export function cleanExtractedText(input: string): string {
  return normalizeWhitespace(normalizeCompatibilityChars(repairCommonArtifacts(input)));
}
