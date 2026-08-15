// src/utils/universityXlsxParser.js
//
// 관리자 탭 "데이터 관리" 서브탭에서 업로드하는 두 엑셀 파일을 브라우저에서 직접
// 파싱한다:
//   - university-recommendations.xlsx        (Sheet1)   → university_recommendations 테이블
//   - university-recommendations-series.xlsx (반영과목) → series_reflected_matrix 테이블
//
// 관리자 업로드가 대학 추천과목/계열별 반영과목 데이터를 DB에 반영하는 기준 경로다.
// 이 파일의 매핑 테이블/정규식을 바꾸면 업로드 미리보기와 DB 반영 결과가 함께 달라진다.
//
// 브라우저에서는 SheetJS가 파싱한 워크시트의 `!merges` 배열로 병합 셀을 판별한다.

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function uniqueKeepOrder(values) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ── 모집단위명 기반 계열 자동 분류 키워드 ──────

const SERIES_KEYWORDS = [
  ['교육', ['교육', '사범대학']],
  ['의약', [
    '의예', '의학과', '의학부', '의과대학', '치의', '한의', '약학', '약과학', '약학대학',
    '간호', '간호대학', '수의', '보건', '임상', '재활', '의생명', '안경광학',
  ]],
  ['공학', [
    '컴퓨터', '전자', '기계', '화학공학', '건축', '토목', '산업공학', '정보통신',
    '소프트웨어', '신소재', '로봇', '에너지', '반도체', '원자력', '원자핵', '항공', '조선',
    '환경공학', '도시공학', '전기', '정보보호', '데이터', '인공지능', '공과대학',
    '바이오', '생명공학', '사이버', '보안', '융합공학', '시스템공학', '디스플레이',
    '모빌리티', '정보융합', '의공학', '화공', '재료', '자동차', '가상현실', '네트워크',
    '안전공학', '교통공학', '조경', '공간정보', '인프라', '고분자', '이차전지',
    '스마트팜', '생태공학', 'AI학',
  ]],
  ['자연', [
    '물리학', '화학과', '화학부', '생명과학', '생물', '수학과', '수학부', '통계학',
    '지구과학', '천문', '농업', '수산', '축산', '식품', '환경학', '이과대학',
    '자연과학대학', '우주과학', '지구환경', '해양', '산림', '식물생산', '원예',
    '수리과학', '정보통계', '보험수리',
  ]],
  ['예체능', [
    '디자인', '미술', '음악', '체육', '스포츠', '무용', '연극', '영화', '사진',
    '공연', '패션', '실용음악', '만화', '애니메이션', '조형', '공연예술',
    '예술대학', '디자인대학', '경기지도', '운동건강', '태권도',
  ]],
  ['사회', [
    '경영', '경제', '행정', '법학', '법과대학', '법무', '정치', '외교', '사회복지',
    '심리', '사회학', '신문방송', '언론', '광고', '무역', '통상', '관광', '호텔',
    '부동산', '세무', '회계', '국제학', '국제관계', '미디어', '사회과학대학',
    '경영대학', '지리학', '아동', '의류', '가정', '문화산업', '북한학', '금융',
    '벤처', '중소기업', 'Business',
  ]],
  ['인문', [
    '국어', '영어', '중어', '중국', '일어', '일본', '불어', '프랑스', '독어', '독일',
    '러시아', '노어', '스페인', '철학', '사학', '역사', '문헌정보', '문예창작',
    '언어', '인류', '종교', '신학', '문학', '자유전공', '문과대학', '불교', '기독교',
    '문화유산', '미학', '인문계열',
  ]],
];

const CHEMISTRY_KEYWORDS = new Set(['화학과', '화학부']);

export function classifySeries(deptName) {
  const name = text(deptName);
  if (!name) return '';
  // "문화학과"/"문화학부"가 "화학과"/"화학부"의 부분 문자열로 우연히 걸리는 문제 방지
  // (예: "중국언어문화학과"가 자연(화학)으로 잘못 분류되면 안 됨).
  const isCultureDept = name.includes('문화');
  for (const [series, keywords] of SERIES_KEYWORDS) {
    for (const keyword of keywords) {
      if (isCultureDept && CHEMISTRY_KEYWORDS.has(keyword)) continue;
      if (name.includes(keyword)) return series;
    }
  }
  return '';
}

const DEPT_SUFFIX_PATTERN = /(학과|학부|학전공|전공|계열|과|부|학)$/;

export function normalizeDeptName(value) {
  let name = text(value).replace(/\s+/g, '');
  let prev = null;
  while (prev !== name) {
    prev = name;
    name = name.replace(DEPT_SUFFIX_PATTERN, '');
  }
  return name;
}

const SENTENCE_LEN_THRESHOLD = 16;
const LABEL_PREFIX_PATTERN = /^[-•]?\s*[가-힣]{1,6}선택\s*[:：]\s*/;

/** 핵심/권장과목 셀 하나를 과목명 태그 배열 또는 안내 문장(note)으로 분리. */
function splitSubjectCell(value) {
  const raw = text(value);
  if (!raw || raw === '-') return { tags: [], note: '' };

  const tokens = [];
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim().replace(LABEL_PREFIX_PATTERN, '');
    if (!line) continue;
    for (const part of line.split(',')) {
      const p = part.trim();
      if (p) tokens.push(p);
    }
  }
  if (!tokens.length) return { tags: [], note: raw };
  if (tokens.some(t => t.length > SENTENCE_LEN_THRESHOLD)) return { tags: [], note: raw };
  return { tags: uniqueKeepOrder(tokens), note: '' };
}

// F열(핵심과목, 0-based col5) ~ G열(권장과목, 0-based col6)이 한 행 안에서 병합된
// 행 번호(0-based, sheet_to_json 배열 인덱스 기준) 집합을 구한다.
function findMergedFGRows(worksheet) {
  const rows = new Set();
  const merges = worksheet?.['!merges'] || [];
  for (const m of merges) {
    if (m.s.r === m.e.r && m.s.c <= 5 && m.e.c >= 6) {
      rows.add(m.s.r);
    }
  }
  return rows;
}

// ── university-recommendations.xlsx (Sheet1) ────────────────────────────────

/**
 * university-recommendations.xlsx 형식의 워크북(ArrayBuffer)을 파싱해
 * university_recommendations 행 배열로 변환한다.
 * @param {ArrayBuffer} arrayBuffer
 * @param {Map<string,string[]>} [reflectedLookup] - `${normalizeDeptName(department)}::${university}` → 과목명 배열.
 *   series_reflected_matrix(계열별 대표 모집단위 반영과목)에서 만든 보조 데이터로,
 *   없으면 reflected는 병합 셀(F:G)에서 나온 값만 채워진다.
 */
export async function parseUniversityRecommendationsWorkbook(arrayBuffer, reflectedLookup = new Map()) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const sheetName = workbook.SheetNames.includes('Sheet1') ? 'Sheet1' : workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('시트를 찾을 수 없습니다. university-recommendations.xlsx와 같은 형식의 파일인지 확인해 주세요.');
  }

  const ws = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const dataRows = grid.slice(4); // min_row=5(1-indexed) 이후 — 상단 4행은 헤더
  const mergedFGRows = findMergedFGRows(ws);

  const rows = [];
  let sortOrder = 1;
  let unmatchedSeriesCount = 0;

  dataRows.forEach((row, offset) => {
    const sheetRowIndex0 = 4 + offset; // grid의 0-based 인덱스 = merges의 행 인덱스와 동일 기준
    const region = text(row?.[0]);
    const area = text(row?.[1]);
    const university = text(row?.[2]);
    if (!university) return;

    const unitPart1 = text(row?.[3]);
    const unitPart2 = text(row?.[4]);
    let department;
    let detailDepartment;
    if (unitPart2) {
      department = unitPart2;
      detailDepartment = unitPart1;
    } else {
      department = unitPart1;
      detailDepartment = unitPart1;
    }

    const isMergedFG = mergedFGRows.has(sheetRowIndex0);
    let mergedTags = [];
    let mergedNote = '';
    let coreTags = [];
    let coreNote = '';
    let recTags = [];
    let recNote = '';
    if (isMergedFG) {
      const merged = splitSubjectCell(row?.[5]);
      mergedTags = merged.tags;
      mergedNote = merged.note;
    } else {
      const core = splitSubjectCell(row?.[5]);
      coreTags = core.tags;
      coreNote = core.note;
      const rec = splitSubjectCell(row?.[6]);
      recTags = rec.tags;
      recNote = rec.note;
    }

    let baseNote = text(row?.[7]);
    if (baseNote === '-') baseNote = '';

    const note = uniqueKeepOrder([baseNote, coreNote, recNote, mergedNote].filter(Boolean)).join(' / ');

    const series = classifySeries(department);
    if (!series) unmatchedSeriesCount += 1;

    const reflectedFromSeries = reflectedLookup.get(`${normalizeDeptName(department)}::${university}`) || [];
    const reflected = uniqueKeepOrder([...mergedTags, ...reflectedFromSeries]);

    rows.push({
      university,
      region_area: (region || area) ? `${region}-${area}` : '',
      series,
      department,
      detail_department: detailDepartment,
      tags: '',
      core: coreTags.join('|'),
      recommended: recTags.join('|'),
      reflected: reflected.join('|'),
      note,
      sort_order: sortOrder++,
    });
  });

  const warnings = [];
  if (!rows.length) {
    warnings.push('유효한 대학 추천과목 행을 찾지 못했습니다. 시트 이름("Sheet1")과 열 구성을 확인해 주세요.');
  }
  if (unmatchedSeriesCount > 0) {
    warnings.push(
      `${unmatchedSeriesCount}개 행은 학과명으로 계열을 자동 분류하지 못했습니다(빈 값으로 저장됨) — ` +
      `필터 기능에만 영향이 있고 표시 자체는 정상 동작합니다.`
    );
  }
  if (!reflectedLookup.size) {
    warnings.push(
      '계열별 대표 모집단위 반영과목 데이터가 없어 "반영과목" 보강이 적용되지 않았습니다. ' +
      '아래 "계열별 대표 모집단위 반영과목" 업로드를 먼저(또는 함께) 적용하면 일부 학과의 반영과목이 채워집니다.'
    );
  }

  return { rows, warnings, sheetName };
}

// ── university-recommendations-series.xlsx (반영과목) ───────────────────────

// 반영과목 시트 C~R열(16개) 세부 과목명 — 헤더(3행 대분류: 국어/수학[5]/영어/사회[4]/과학[4]/기타,
// 4행 세부)을 펼친 leaf 목록.
const SERIES_MATRIX_LEAF_SUBJECTS = [
  '국어', '대수', '확률과 통계', '미적분Ⅰ', '미적분Ⅱ', '기하', '영어',
  '일반사회', '역사', '지리', '윤리', '물리학', '화학', '생명과학', '지구과학', '기타',
];

const UNIV_NAME_SPLIT_PATTERN = /[,\n、]/;

/**
 * university-recommendations-series.xlsx 형식의 워크북(ArrayBuffer)을 파싱해
 * { rows, reflectedLookup, warnings, sheetName } 반환.
 * - rows: series_reflected_matrix 테이블 행 배열 (16개 대표 모집단위 × 대학).
 * - reflectedLookup: `${normalizeDeptName(department)}::${university}` → 과목명 배열.
 *   university_recommendations.reflected 보강에 사용(parseUniversityRecommendationsWorkbook 참고).
 */
export async function parseSeriesMatrixWorkbook(arrayBuffer) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  if (!workbook.SheetNames.includes('반영과목')) {
    throw new Error(
      '"반영과목" 시트를 찾지 못했습니다. university-recommendations-series.xlsx와 같은 형식의 파일인지 확인해 주세요.'
    );
  }

  const ws = workbook.Sheets['반영과목'];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const dataRows = grid.slice(4); // min_row=5(1-indexed) 이후

  const rows = [];
  let sortOrder = 1;
  let lastSeries = '';

  for (const row of dataRows) {
    const seriesRaw = text(row?.[0]);
    const series = seriesRaw || lastSeries;
    lastSeries = series || lastSeries;

    const department = text(row?.[1]);
    if (!department) continue;

    const leafValues = SERIES_MATRIX_LEAF_SUBJECTS.map((_, i) => (row ? row[2 + i] : null) ?? null);
    const required = SERIES_MATRIX_LEAF_SUBJECTS.filter((_, i) => {
      const v = text(leafValues[i]);
      return v && v !== '-';
    });
    if (!required.length) continue;

    let university = '';
    for (const v of leafValues) {
      const cleaned = text(v);
      if (cleaned && cleaned !== '-') {
        university = cleaned;
        break;
      }
    }

    rows.push({
      series,
      department,
      university,
      required_subjects: required.join('|'),
      sort_order: sortOrder++,
    });
  }

  const reflectedLookup = buildReflectedLookup(grid);

  const warnings = [];
  if (!rows.length) {
    warnings.push('유효한 반영과목 행을 찾지 못했습니다. "반영과목" 시트의 열 구성을 확인해 주세요.');
  }

  return { rows, reflectedLookup, warnings, sheetName: '반영과목' };
}

/** parse_reflected_lookup() 이식 — 헤더(3~4행)에서 열별 세부 과목명을 동적으로 읽어,
 *  (정규화된 학과명, 대학명) 키로 그 대학이 요구하는 과목명 목록을 만든다.
 *  buildSeriesMatrixRows()의 하드코딩 목록(SERIES_MATRIX_LEAF_SUBJECTS)과 별개로,
 *  실제 헤더 텍스트를 그대로 사용한다(python 원본과 동일하게 이원화된 구현). */
function buildReflectedLookup(grid) {
  const lookup = new Map();
  if (grid.length < 5) return lookup;

  const groupHeader = grid[2] || []; // 3행(대분류)
  const subHeader = grid[3] || [];   // 4행(세부)
  const maxCols = Math.max(groupHeader.length, subHeader.length);

  const subjectCols = [];
  let lastGroup = '';
  for (let col = 2; col < maxCols; col++) {
    const group = text(groupHeader[col]);
    const sub = text(subHeader[col]);
    if (group) lastGroup = group;
    const subjectName = sub || lastGroup;
    if (subjectName) subjectCols.push([col, subjectName]);
  }

  let lastSeries = '';
  for (let i = 4; i < grid.length; i++) {
    const row = grid[i] || [];
    const seriesRaw = text(row[0]);
    const series = seriesRaw || lastSeries;
    lastSeries = series || lastSeries;

    const dept = text(row[1]);
    if (!dept) continue;
    const deptKey = normalizeDeptName(dept);

    for (const [col, subjectName] of subjectCols) {
      const cell = text(row[col]);
      if (!cell || cell === '-') continue;
      for (const univRaw of cell.split(UNIV_NAME_SPLIT_PATTERN)) {
        // python: univ.strip().rstrip("*").strip() — ASCII 마침표성 '*'만 제거(예: "단국대⁎"의
        // 유니코드 별표 ⁎(U+204E)는 그대로 유지 — 원본과 동일한 동작).
        const univName = univRaw.trim().replace(/\*+$/, '').trim();
        if (!univName) continue;
        const key = `${deptKey}::${univName}`;
        if (!lookup.has(key)) lookup.set(key, []);
        const list = lookup.get(key);
        if (!list.includes(subjectName)) list.push(subjectName);
      }
    }
  }

  return lookup;
}

/** DB에 이미 저장된 series_reflected_matrix 행(sheets.js의 fetchSeriesMatrix() 결과,
 *  { department, university, requiredSubjects: string[] } 형태)으로부터 위와 동일한 구조의
 *  reflectedLookup을 재구성한다. 반영과목 파일 없이 대학 추천과목 파일만 갱신할 때,
 *  방금 새로 파싱한 원본 대신 "이미 DB에 저장된" 반영과목 데이터를 보강 소스로 쓰기 위함. */
export function buildReflectedLookupFromStoredRows(seriesRows) {
  const lookup = new Map();
  for (const row of seriesRows || []) {
    const department = row.department || '';
    const university = row.university || '';
    if (!department || !university) continue;
    const subjects = Array.isArray(row.requiredSubjects) ? row.requiredSubjects : [];
    if (!subjects.length) continue;
    const key = `${normalizeDeptName(department)}::${university}`;
    if (!lookup.has(key)) lookup.set(key, []);
    const list = lookup.get(key);
    for (const s of subjects) {
      if (s && !list.includes(s)) list.push(s);
    }
  }
  return lookup;
}
