// ─────────────────────────────────────────
//  utils/normalize.js  —  과목명 정규화 및 매칭 유틸
// ─────────────────────────────────────────

export function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .toLowerCase()
    .replace(/[Ⅱⅱ]/g, 'ii')
    .replace(/[Ⅰⅰ]/g, 'i');
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function ensureArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string') return value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
  return [];
}

// ── 교과 영역 레이블 ──────────────────────
export const areaLabels = {
  math: '수학', science: '과학', info: '정보', korean: '국어',
  english: '영어', social: '사회', language: '제2외국어',
  liberal: '교양', arts: '예술', home: '기술·가정',
  pe: '체육',
};

export const areaClass = {
  math: 'math', science: 'science', info: 'info', korean: 'science',
  english: 'info', social: 'science', language: 'info', liberal: 'science', arts: 'science', home: 'info',
  pe: 'science',
};

// ── 과목 그룹 aliases (대학 추천과목 → 학교 과목 매핑) ──
const subjectAreaAliases = {
  '국어': ['korean'], '수학': ['math'], '영어': ['english'],
  '사회': ['social'], '일반사회': ['social'], '역사': ['social'],
  '지리': ['social'], '윤리': ['social'], '과학': ['science'],
  '기술·가정/정보': ['info'], '제2외국어/한문': ['language'],
  '교양': ['liberal'], '예술·체육': ['arts'],
  '기타': ['info', 'language', 'liberal', 'arts'],
  '전 과목': ['korean', 'math', 'english', 'social', 'science', 'info', 'language', 'liberal', 'arts'],
  '전 교과': ['korean', 'math', 'english', 'social', 'science', 'info', 'language', 'liberal', 'arts'],
};

const subjectCourseAliases = {
  '국어': ['문학', '화법과 언어', '독서와 작문', '문학과 영상', '주제 탐구 독서', '독서 토론과 글쓰기', '매체의사소통', '언어생활 탐구'],
  '수학': ['대수', '미적분Ⅰ', '확률과 통계', '기하', '미적분Ⅱ', '경제 수학', '인공지능 수학', '수학과제 탐구', '전문 수학'],
  // 대학 추천과목 데이터에는 2022 개정 전 명칭인 "미적분"(Ⅰ/Ⅱ 구분 없음)으로 적힌
  // 곳이 많다. 2025·2026학년도 입학생 교육과정은 미적분Ⅰ/미적분Ⅱ로 분리되어 있어
  // 정확매칭이 실패하고 "추가 확인: 미적분"이 잘못 표시되는 문제가 있었음 — 학교가
  // 실제로 개설하는 과목이므로 양방향 별칭으로 묶어 해결한다.
  '미적분': ['미적분', '미적분Ⅰ', '미적분Ⅱ'],
  '미적분Ⅰ': ['미적분', '미적분Ⅰ'],
  '미적분Ⅱ': ['미적분', '미적분Ⅱ'],
  '영어': ['영어Ⅰ', '영어Ⅱ', '영어 독해와 작문', '영미 문학 읽기', '영어 발표와 토론', '심화 영어', '실생활 영어 회화', '미디어 영어', '세계 문화와 영어'],
  '과학': ['물리학', '화학', '생명과학', '지구과학', '융합과학 탐구', '역학과 에너지', '물질과 에너지', '세포와 물질대사', '행성우주과학', '전자기와 양자', '화학 반응의 세계', '생물의 유전', '지구시스템과학', '고급 물리학', '고급 화학', '고급 생명과학', '고급 지구과학', '과학과제 연구', '과학의 역사와 문화', '기후변화와 환경 생태'],
  '물리학(교과)': ['물리학', '역학과 에너지', '전자기와 양자', '고급 물리학'],
  '화학(교과)': ['화학', '물질과 에너지', '화학 반응의 세계', '고급 화학'],
  '생명과학(교과)': ['생명과학', '세포와 물질대사', '생물의 유전', '고급 생명과학'],
  '지구과학(교과)': ['지구과학', '지구시스템과학', '행성우주과학', '고급 지구과학'],
  '사회': ['현대사회와 윤리', '사회와 문화', '한국지리 탐구', '법과 사회', '동아시아 역사 기행', '세계사', '세계시민과 지리', '도시의 미래 탐구', '경제', '윤리와 사상', '인문학과 윤리', '기후변화와 지속가능한 세계', '사회문제 탐구', '역사로 탐구하는 현대 세계', '금융과 경제생활', '여행지리', '윤리문제 탐구'],
  '일반사회': ['사회와 문화', '법과 사회', '경제', '금융과 경제생활', '사회문제 탐구'],
  '역사': ['세계사', '동아시아 역사 기행', '역사로 탐구하는 현대 세계'],
  '지리': ['세계시민과 지리', '한국지리 탐구', '도시의 미래 탐구', '여행지리', '기후변화와 지속가능한 세계'],
  '윤리': ['현대사회와 윤리', '윤리와 사상', '인문학과 윤리', '윤리문제 탐구'],
  '기술·가정': ['생활과학 탐구'],
  '기술·가정(교과)': ['생활과학 탐구'],
  '정보': ['정보', '인공지능 기초', '소프트웨어와 생활'],
  '정보(교과)': ['정보', '인공지능 기초', '소프트웨어와 생활'],
  '제2외국어': ['중국어', '일본어', '중국어 회화', '일본어 회화', '심화 중국어', '심화 일본어', '일본 문화', '중국 문화'],
  '한문': ['한문', '한문 고전 읽기', '언어생활과 한자'],
  '한문(교과)': ['한문', '한문 고전 읽기', '언어생활과 한자'],
  '예술': ['음악 감상과 비평', '미술 감상과 비평'],
};

const normalizedAreaAliases = new Map(
  Object.entries(subjectAreaAliases).map(([k, v]) => [normalize(k), v])
);
const normalizedCourseAliases = new Map(
  Object.entries(subjectCourseAliases).map(([k, v]) => [normalize(k), v.map(normalize)])
);

// ── 과목명 매칭 엔진 ──────────────────────
let _allCoursesCache = null;

export function setAllCourses(courses) {
  _allCoursesCache = courses;
  courseMatchCache.clear();
}

function getAllCourses() {
  return _allCoursesCache || [];
}

const scienceCourseNames = new Set(['물리학', '화학', '생명과학', '지구과학']);
const courseMatchCache = new Map();

function uniqueCourses(courses) {
  const seen = new Set();
  return courses.filter(c => {
    const key = `${c.semester}-${c.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function getCourseMatches(subject) {
  const raw = String(subject || '').trim();
  const key = normalize(raw);
  if (!key) return [];
  if (courseMatchCache.has(key)) return courseMatchCache.get(key);

  const all = getAllCourses();

  // 과학 단일 과목 정확 매칭
  if (scienceCourseNames.has(raw)) {
    const matches = uniqueCourses(all.filter(c => normalize(c.name) === key));
    courseMatchCache.set(key, matches);
    return matches;
  }

  // 과목 그룹 alias 매칭
  const aliasMatches = normalizedCourseAliases.get(key);
  if (aliasMatches?.length) {
    const keySet = new Set(aliasMatches);
    const matches = uniqueCourses(all.filter(c => keySet.has(normalize(c.name))));
    courseMatchCache.set(key, matches);
    return matches;
  }

  // 정확 과목명 매칭
  const exact = uniqueCourses(all.filter(c => normalize(c.name) === key));
  if (exact.length) {
    courseMatchCache.set(key, exact);
    return exact;
  }

  // 교과 영역 매칭
  const areas = normalizedAreaAliases.get(key);
  if (areas?.length) {
    const matches = uniqueCourses(all.filter(c => areas.includes(c.area)));
    courseMatchCache.set(key, matches);
    return matches;
  }

  courseMatchCache.set(key, []);
  return [];
}

export function isCourseOpened(subject) {
  return getCourseMatches(subject).length > 0;
}
