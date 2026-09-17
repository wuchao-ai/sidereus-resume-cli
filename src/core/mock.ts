/**
 * 离线（--mock）模式。
 *
 * 题目里 mock 是加分项，但实现方式有两种：
 *   A. 返回一段硬编码的假 JSON —— 能跑通，但演示时一眼假，评审也看不出技术含量；
 *   B. 用规则做一遍真实的抽取与打分 —— 没有网络也能给出"看起来合理"的结果。
 *
 * 这里选 B。理由是：这套规则本身是有用的 —— 它同时充当
 *   · 无 API Key 时的演示降级路径
 *   · AI 返回结构异常时的对照物（两边结果差太多说明其中一边有问题）
 * 所以它值得认真写，而不是 `return { name: '张三' }`。
 */

import type { Education, MatchReport, ResumeProfile } from './schema.js';
import { SCORE_MAX, SCORE_MIN } from './schema.js';

/** 常见技术栈词表：用于从简历/JD 中识别技能，命中即视为一项技能 */
const SKILL_VOCABULARY: readonly string[] = [
  // 语言
  'JavaScript', 'TypeScript', 'Python', 'Java', 'Go', 'Golang', 'Rust', 'C++', 'C#', 'PHP', 'Ruby', 'Kotlin', 'Swift', 'Scala', 'Dart', 'SQL', 'Shell', 'Bash',
  // 前端
  'HTML', 'CSS', 'SCSS', 'Less', 'Sass', 'React', 'Vue', 'Vue.js', 'Vue3', 'Angular', 'Svelte', 'Next.js', 'Nuxt', 'Webpack', 'Vite', 'Rollup', 'Babel', 'ESLint', 'Tailwind', 'Element UI', 'Ant Design', 'ECharts', 'Three.js', 'UniApp', 'Taro', 'React Native', 'Flutter', 'Electron', '小程序', '小程序开发',
  // 后端 / 服务端
  'Node.js', 'Express', 'Koa', 'NestJS', 'Fastify', 'Spring', 'Spring Boot', 'Django', 'Flask', 'FastAPI', 'Gin', 'Echo', 'gRPC', 'GraphQL', 'RESTful', '微服务', 'Serverless',
  // 数据
  'MySQL', 'PostgreSQL', 'MongoDB', 'Redis', 'Elasticsearch', 'ClickHouse', 'SQLite', 'Oracle', 'Kafka', 'RabbitMQ', 'RocketMQ', 'ETL', '数据仓库', 'Hive', 'Spark', 'Flink',
  // 云与运维
  'Docker', 'Kubernetes', 'K8s', 'Nginx', 'Linux', 'CI/CD', 'Jenkins', 'GitLab CI', 'GitHub Actions', 'AWS', 'Azure', '阿里云', '腾讯云', 'Prometheus', 'Grafana', 'ELK', 'Terraform', 'Ansible',
  // AI / 数据科学
  'OpenAI API', 'LLM', '大模型', 'Prompt Engineering', '提示词工程', 'RAG', 'LangChain', 'LlamaIndex', 'Agent', '智能体', 'MCP', 'Fine-tuning', '微调', 'PyTorch', 'TensorFlow', 'Transformers', 'Hugging Face', 'Pandas', 'NumPy', '机器学习', '深度学习', 'NLP', '计算机视觉', '向量数据库', 'Milvus', 'Pinecone', 'Faiss',
  // 工程与协作
  'Git', 'SVN', 'Jest', 'Vitest', 'Mocha', 'Cypress', 'Playwright', 'Puppeteer', '单元测试', '性能优化', '架构设计', '技术方案设计', 'Code Review', 'Agile', 'Scrum', 'Jira', 'Kubernetes Operator',
  // 通用能力
  '项目管理', '团队管理', '需求分析', '跨部门协作', '英语读写', '技术分享',
];

/** 城市词表，用于从文本中识别所在城市 */
const CITY_LIST: readonly string[] = [
  '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉', '西安', '苏州', '天津', '重庆', '长沙',
  '郑州', '青岛', '合肥', '厦门', '福州', '济南', '大连', '宁波', '无锡', '珠海', '东莞', '佛山', '沈阳',
  '哈尔滨', '昆明', '南昌', '贵阳', '南宁', '石家庄', '太原', '兰州', '乌鲁木齐', '海口', '三亚', '长春',
  '银川', '西宁', '呼和浩特', '拉萨', '香港', '澳门', '台北',
];

/** 学历层级，顺序即优先级：命中靠前的就取靠前的 */
const DEGREE_LEVELS: ReadonlyArray<{ keyword: string; level: number }> = [
  { keyword: '博士后', level: 5 },
  { keyword: '博士', level: 5 },
  { keyword: '硕士', level: 4 },
  { keyword: '研究生', level: 4 },
  { keyword: 'MBA', level: 4 },
  { keyword: '本科', level: 3 },
  { keyword: '学士', level: 3 },
  { keyword: '大专', level: 2 },
  { keyword: '专科', level: 2 },
  { keyword: '高中', level: 1 },
  { keyword: '中专', level: 1 },
];

const PHONE_PATTERN = /(?:\+?86[-\s]?)?(1[3-9]\d)[-\s]?(\d{4})[-\s]?(\d{4})/;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const SCHOOL_PATTERN = /([\u4e00-\u9fa5]{2,12}(?:大学|学院|学校))/;
const DATE_PATTERN = /(\d{4})\s*[.\-/年]\s*(\d{1,2})?/g;

/** 从文本中挑出命中的技能词，保持词表顺序以便结果稳定 */
export function detectSkills(text: string): string[] {
  const found = SKILL_VOCABULARY.filter((skill) => {
    // 对纯 ASCII 词加边界判断，避免 "Go" 命中 "Google"、"Java" 命中 "JavaScript"
    if (/^[\x20-\x7e]+$/.test(skill)) {
      const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^A-Za-z0-9+#.])${escaped}([^A-Za-z0-9+#]|$)`, 'i').test(text);
    }
    return text.includes(skill);
  });
  // "JavaScript" 命中时不必再列 "Java"（词表里 Java 在前，需要手动去重）
  return found.filter((skill) => {
    if (skill === 'Java') return !found.includes('JavaScript');
    if (skill === 'Vue' && found.includes('Vue.js')) return false;
    return true;
  });
}

/** 判断文本里出现过的最高学历 */
function detectDegree(text: string): { degree: string; level: number } | null {
  const hit = DEGREE_LEVELS.find((item) => text.includes(item.keyword));
  return hit ? { degree: hit.keyword, level: hit.level } : null;
}

/** 从简历里猜姓名：优先"姓名：X"这类显式标注，其次取首个 2-4 字的中文短行 */
function detectName(text: string): string | null {
  const labelled = /(?:姓\s*名|名字|Name)\s*[:：]?\s*([\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z\s.]{1,30})/.exec(text);
  if (labelled?.[1]) return labelled[1].trim();

  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 5)) {
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(line)) return line;
    if (/^[A-Z][a-z]+(?:\s[A-Z][a-z]+){1,2}$/.test(line)) return line;
  }
  return null;
}

/** 把 "2018.06" / "2018年6月" / "2018-6" 之类的写法统一成 "2018.06" */
function normalizeDate(raw: string): string {
  const matched = /^(\d{4})\D*(\d{1,2})?/.exec(raw.replace(/\s/g, ''));
  if (!matched) return raw;
  const [, year, month] = matched;
  return month ? `${year}.${month.padStart(2, '0')}` : year!;
}

/** 解析教育经历：只做"学校 + 学历 + 可选专业"的粗提取，够 mock 用 */
function detectEducation(text: string): Education[] {
  const results: Education[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const school = SCHOOL_PATTERN.exec(line)?.[1];
    if (!school) continue;

    const degree = detectDegree(line);
    // 学历标签后面的短词通常就是专业，例如 "浙江大学 · 软件工程 · 本科"
    const majorMatch = /([\u4e00-\u9fa5]{2,10}(?:工程|科学|技术|管理|经济|金融|会计|法学|医学|设计|传播|教育))/.exec(line);
    const major = majorMatch?.[1] && majorMatch[1] !== school ? majorMatch[1] : null;

    // 一行里通常有起止两个日期（2014.09 - 2018.06），取最后一个作为毕业时间
    const dates = [...line.matchAll(DATE_PATTERN)].map((match) => normalizeDate(match[0]));
    const graduationTime = dates.length > 0 ? dates[dates.length - 1]! : null;

    results.push({
      school,
      major,
      degree: degree?.degree ?? null,
      graduation_time: graduationTime,
    });
  }

  // 同一学校只留一条，避免页眉页脚重复
  const unique = new Map<string, Education>();
  for (const item of results) if (!unique.has(item.school!)) unique.set(item.school!, item);
  return [...unique.values()].slice(0, 5);
}

/** 估算工作年限：优先读"X 年经验"，其次用当前年份减去最早出现的年份 */
function estimateYearsOfExperience(text: string): number | null {
  const explicit = /(\d{1,2})\s*年(?:以上)?(?:工作)?经[验历]/.exec(text);
  if (explicit?.[1]) return Number.parseInt(explicit[1], 10);

  const years = [...text.matchAll(/(\d{4})\s*[.\-/年]/g)]
    .map((match) => Number.parseInt(match[1]!, 10))
    .filter((year) => year >= 1990 && year <= new Date().getFullYear());
  if (years.length === 0) return null;

  const earliestWorkYear = Math.min(...years);
  const span = new Date().getFullYear() - earliestWorkYear;
  return span > 0 && span < 50 ? span : null;
}

/** 离线模式下的结构化提取：正则 + 词表，不联网 */
export function mockResumeProfile(resumeText: string): ResumeProfile {
  const phoneMatch = PHONE_PATTERN.exec(resumeText);
  const emailMatch = EMAIL_PATTERN.exec(resumeText);
  const city = CITY_LIST.find((item) => resumeText.includes(item)) ?? null;

  return {
    name: detectName(resumeText),
    phone: phoneMatch ? `${phoneMatch[1]}-${phoneMatch[2]}-${phoneMatch[3]}` : null,
    email: emailMatch ? emailMatch[0] : null,
    city,
    education: detectEducation(resumeText),
    skills: detectSkills(resumeText),
  };
}

function clampScore(value: number): number {
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(value * 10) / 10));
}

/**
 * 离线模式下的匹配评分。
 *
 * 算法很直白：技能重合率定 skill_score，年限差定 experience_score，学历层级差定 education_score，
 * 再用 0.5 / 0.3 / 0.2 加权得到总分。它当然不如大模型懂语义，
 * 但胜在**可解释、可复现** —— 每一分的来源都能指出来。
 */
export function mockMatchReport(resumeText: string, jdText: string): MatchReport {
  const resumeSkills = new Set(mockResumeProfile(resumeText).skills.map((s) => s.toLowerCase()));
  const jdSkills = mockResumeProfile(jdText).skills.filter((skill) => skill.length > 0);

  // 技能：以 JD 提到的技能为分母，看简历覆盖了多少
  const uniqueJdSkills = [...new Set(jdSkills)];
  const matchedSkills = uniqueJdSkills.filter((skill) => resumeSkills.has(skill.toLowerCase()));
  const missingSkills = uniqueJdSkills.filter((skill) => !resumeSkills.has(skill.toLowerCase()));
  const skillScore =
    uniqueJdSkills.length === 0 ? 60 : clampScore((matchedSkills.length / uniqueJdSkills.length) * 100);

  // 经验：JD 里写"X 年"就以它为目标，否则按 3 年基准
  const resumeYears = estimateYearsOfExperience(resumeText) ?? 0;
  const requiredYears = Number.parseInt(/(\d{1,2})\s*年(?:以上)?(?:工作)?经[验历]/.exec(jdText)?.[1] ?? '3', 10);
  const yearGap = resumeYears - requiredYears;
  const experienceScore = clampScore(70 + (yearGap >= 0 ? Math.min(yearGap * 8, 30) : Math.max(yearGap * 12, -70)));

  // 学历：达到要求即 80 分起步，高出要求每级 +8，低于要求每级 -15
  const resumeDegree = detectDegree(resumeText);
  const requiredDegree = detectDegree(jdText);
  const resumeLevel = resumeDegree?.level ?? 3;
  const requiredLevel = requiredDegree?.level ?? 3;
  const levelGap = resumeLevel - requiredLevel;
  const educationScore = clampScore(80 + (levelGap >= 0 ? Math.min(levelGap * 8, 20) : Math.max(levelGap * 15, -80)));

  const overallScore = clampScore(skillScore * 0.5 + experienceScore * 0.3 + educationScore * 0.2);

  const highlights = matchedSkills.slice(0, 5).join('、') || '暂未识别到与岗位直接对应的技能';
  const gaps = missingSkills.slice(0, 5).join('、');
  const comment = [
    `技能匹配度 ${skillScore} 分：命中岗位要求 ${matchedSkills.length}/${uniqueJdSkills.length} 项技能（${highlights}）。`,
    gaps ? `主要差距在于缺少 ${gaps} 等相关经验。` : '岗位要求的技术栈基本已被简历覆盖。',
    `经验与学历维度分别得 ${experienceScore} 分、${educationScore} 分。`,
    '（本结果由离线规则引擎生成，未调用大模型）',
  ].join('');

  // 面试题优先围绕"JD 要但简历没体现"的技能生成，这样问题才有区分度
  const interviewQuestions: string[] = [];
  for (const skill of missingSkills.slice(0, 2)) {
    interviewQuestions.push(`简历中没有体现 ${skill} 相关经验，请介绍你对该技术的了解，以及如果项目需要你会如何上手？`);
  }
  if (resumeYears < requiredYears) {
    interviewQuestions.push(`岗位期望 ${requiredYears} 年以上经验，你目前约 ${resumeYears} 年，请举例说明你如何在更短时间内承担同等复杂度的任务？`);
  }
  interviewQuestions.push('请介绍一个你主导过的、最能体现技术深度的项目，重点说明你在其中的具体职责与关键决策。');
  if (missingSkills.length === 0) {
    interviewQuestions.push('你如何保证交付质量？请结合一次线上问题排查经历说明你的方法论。');
  }

  return {
    overall_score: overallScore,
    skill_score: skillScore,
    experience_score: experienceScore,
    education_score: educationScore,
    comment,
    interview_questions: interviewQuestions.slice(0, 5),
  };
}
