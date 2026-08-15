// src/utils/cohortXlsxParser.js
//
// 관리자 탭 "데이터 관리" 서브탭에서 업로드하는 curriculum-cohorts.xlsx 형식의
// 엑셀 파일을 브라우저에서 직접 파싱해 semester_courses 행 배열로 변환한다.
//
// 관리자 업로드가 교육과정 데이터를 DB에 반영하는 기준 경로다.
// 이 파일의 매핑 테이블(AREA_BY_GUN 등)을 바꾸면 업로드 미리보기와 DB 반영 결과가
// 함께 달라지므로, 템플릿 변경과 같이 검증해야 한다.
//
// xlsx 파싱 자체는 SheetJS(xlsx 패키지)를 esm.sh CDN에서 동적 import한다 — 이
// 모듈은 "데이터 관리" 탭을 실제로 열고 파일을 선택했을 때만 로드되므로, 이
// 기능을 쓰지 않는 대부분의 사용자에게는 번들 크기 영향이 없다.

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toIntOrDefault(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function toNumberOrDefault(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ── 교육과정 엑셀 파싱용 매핑 테이블 ──────────────────

const AREA_BY_GUN = {
  '국어': 'korean',
  '수학': 'math',
  '영어': 'english',
  '사회': 'social',
  '사회(역사/도덕 포함)': 'social',
  '과학': 'science',
  '기술·가정': 'home',
  '기술·가정/정보': 'home',
  '기술가정': 'home',
  '제2외국어': 'language',
  '제2외국어/한문': 'language',
  '한문': 'language',
  '교양': 'liberal',
  '체육': 'pe',
  '예술': 'arts',
  '음악': 'arts',
  '미술': 'arts',
};

const AREA_OVERRIDE_BY_NAME = {
  '정보': 'info',
  '소프트웨어와 생활': 'info',
  '인공지능 기초': 'info',
};

const COHORT_TYPE_MAP = {
  '공통 과목': '지정',
  '일반 선택': '일반',
  '진로 선택': '진로',
  '융합 선택': '융합',
};

// [열 인덱스(0-based, SheetJS header:1 배열 기준), 학기 라벨]
// 교육과정 템플릿의 학기별 학점 열 위치. 열이 늘어나거나 순서가 바뀌면 함께 갱신해야 한다.
const COHORT_SEMESTER_COLUMNS = [
  [8, '1학년 1학기'],
  [9, '1학년 2학기'],
  [10, '2학년 1학기'],
  [11, '2학년 2학기'],
  [12, '3학년 1학기'],
  [13, '3학년 2학기'],
];

const SEMESTER_ORDER = COHORT_SEMESTER_COLUMNS.map(([, label]) => label);

const COMMON_NAME_OVERRIDES = {
  '국어': '공통국어',
  '수학': '공통수학',
  '영어': '공통영어',
};

const COMMON_NAME_BY_GUN_CREDIT = new Map([
  [['사회', 3].join('::'), '한국사'],
  [['사회', 4].join('::'), '통합사회'],
  [['사회(역사/도덕 포함)', 3].join('::'), '한국사'],
  [['사회(역사/도덕 포함)', 4].join('::'), '통합사회'],
  [['과학', 4].join('::'), '통합과학'],
  [['과학', 1].join('::'), '과학탐구실험'],
]);

// 과목명(C열)이 비어 있어도 "교과(군)+학점"으로 실제 과목명을 역추론할 수 있는
// 교과(군, B열) 값들 — COMMON_NAME_OVERRIDES / COMMON_NAME_BY_GUN_CREDIT의 키와
// 1:1 대응. 실제 과목 행 중 과목명이 비어 있는 경우는 이 "1학년 공통과목 역추론"
// 케이스뿐이므로, 과목명이 비어 있는데 교과(군)가 이 목록에도 없다면 그 행은 진짜
// 과목 행이 아니라 "학기별 이수 과목수(지정/선택/합계)" 같은 표 하단 합계·각주
// 행이라고 판단한다 (아래 dataRows 순회의 break 조건 참고).
const BLANK_NAME_ELIGIBLE_GUNS = new Set([
  ...Object.keys(COMMON_NAME_OVERRIDES),
  ...[...COMMON_NAME_BY_GUN_CREDIT.keys()].map(key => key.split('::')[0]),
]);

function resolveCommonCourseName(gun, credit) {
  const gunClean = text(gun);
  if (COMMON_NAME_OVERRIDES[gunClean]) return COMMON_NAME_OVERRIDES[gunClean];
  if (!credit) return '';
  const creditInt = toIntOrDefault(credit, null);
  if (creditInt === null) return '';
  return COMMON_NAME_BY_GUN_CREDIT.get(`${gunClean}::${creditInt}`) || '';
}

function mapArea(gun, courseName, unmappedGunSet) {
  const gunClean = text(gun);
  const nameClean = text(courseName);
  if (AREA_OVERRIDE_BY_NAME[nameClean]) return AREA_OVERRIDE_BY_NAME[nameClean];
  if (AREA_BY_GUN[gunClean]) return AREA_BY_GUN[gunClean];
  if (gunClean && unmappedGunSet) unmappedGunSet.add(gunClean);
  return 'liberal';
}

function mapType(ctype) {
  const clean = text(ctype);
  return COHORT_TYPE_MAP[clean] || clean;
}

// python re.search(r"(\d{4})학년도\s*입학생\s*3개년", sheet_name) — 앵커 없이 부분 일치.
const COHORT_SHEET_PATTERN = /(\d{4})학년도\s*입학생\s*3개년/;

export function detectCohortYear(sheetName) {
  const match = COHORT_SHEET_PATTERN.exec(String(sheetName || ''));
  if (!match) return null;
  return Number(match[1]);
}

/**
 * curriculum-cohorts.xlsx 형식의 워크북(ArrayBuffer)을 파싱해
 * { cohorts: [{ cohortYear, sheetName, rows }], warnings: string[], skippedSheets: string[] } 반환.
 * rows의 각 항목은 semester_courses 테이블 컬럼과 1:1 대응한다
 * (cohort_year 제외 — cohort_year는 항목 자체에 이미 포함됨).
 */
export async function parseCohortWorkbook(arrayBuffer) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const targetSheets = [];
  const skippedSheets = [];
  for (const sheetName of workbook.SheetNames) {
    const cohortYear = detectCohortYear(sheetName);
    if (cohortYear === null) {
      skippedSheets.push(sheetName);
    } else {
      targetSheets.push({ sheetName, cohortYear });
    }
  }

  if (!targetSheets.length) {
    throw new Error(
      '"○○○○학년도 입학생 3개년" 형식의 시트를 찾지 못했습니다. curriculum-cohorts.xlsx와 같은 형식의 파일인지 확인해 주세요.'
    );
  }

  const warnings = [];
  const unmappedGunSet = new Set();
  const cohortBuckets = new Map(); // cohortYear -> { sheetNames: Set, rows: [] }
  let sortOrder = 1;

  for (const { sheetName, cohortYear } of targetSheets) {
    if (!cohortBuckets.has(cohortYear)) {
      cohortBuckets.set(cohortYear, { sheetNames: new Set(), rows: [] });
    }
    const bucket = cohortBuckets.get(cohortYear);
    bucket.sheetNames.add(sheetName);

    const ws = workbook.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    const dataRows = grid.slice(4); // min_row=5(1-indexed) 이후 — 상단 4행은 헤더

    // ⚠ 완전 공백 행(교과(군)·과목명 모두 빈 행)만으로 "표 끝"을 판단해 그 뒤를 통째로
    // 무시하면 안 된다 — 일부 코호트 시트(예: data/curriculum-cohorts.xlsx의 2024학년도
    // 입학생 시트)는 실제 헤더가 5행이 아니라 6행부터 시작해서 min_row=5 스캔 범위 안에
    // "헤더의 일부인 공백 행"이 먼저 나오는 경우가 있고, 이 경우 그 뒤의 진짜 과목 행을
    // 전부 건너뛰는 심각한 데이터 유실 버그로 이어진다(실측: 이 최적화를 넣었다가 2024
    // 학년도 코호트가 0행으로 빠지는 회귀를 발견해 되돌림).
    //
    // 반면 "과목명(C열)은 비어 있지만 교과(군, B열)은 채워져 있는" 행은 성격이 다르다.
    // 실제 과목 표에서 이런 조합이 나오는 유일한 경우는 1학년 공통과목 역추론
    // (BLANK_NAME_ELIGIBLE_GUNS)뿐이고, 그 외에는 "학기별 이수 과목수(지정 과목)" /
    // "(선택 과목)" / "(합계)" 같은 표 하단 합계·각주 행이다(실측: 업로드 파일의 학년별
    // 시트 141~143행 부근). 이런 행은 과목 표가 이미 끝났다는 확실한 신호이므로, 이후
    // 행은 (같은 시트 안에서) 전부 무시하고 다음 시트로 넘어간다 — 매 행을 독립적으로
    // "스킵"만 하던 이전 방식은 이런 합계 행마다 "공통과목 매핑 없음" 경고를 학기 수만큼
    // 반복 출력해 실제로는 문제 없는 파일도 경고투성이로 보이게 만들었다.
    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const row = dataRows[rowIdx];
      const excelRowNo = rowIdx + 5;
      const gun = text(row?.[1]);
      const courseNameRaw = text(row?.[2]);
      const ctype = text(row?.[3]);
      const groupName = text(row?.[4]);
      const pickRaw = row?.[6];

      if (!courseNameRaw && !gun) continue; // 완전 공백 행 스킵 (표 끝으로 단정하지 않음)

      if (!courseNameRaw && !BLANK_NAME_ELIGIBLE_GUNS.has(gun)) {
        // 과목명이 비어 있는데 교과(군)도 "공통과목 역추론 대상"이 아님 → 합계/각주 행.
        // 과목 표는 여기서 끝난 것으로 보고 이 시트의 나머지 행은 더 이상 보지 않는다.
        break;
      }

      const dbType = mapType(ctype);
      const pick = toIntOrDefault(pickRaw, 0);

      for (const [colIdx, semesterLabel] of COHORT_SEMESTER_COLUMNS) {
        const creditRaw = row?.[colIdx];
        if (!creditRaw) continue;

        let courseName = courseNameRaw;
        if (!courseName) {
          const resolved = resolveCommonCourseName(gun, creditRaw);
          if (!resolved) {
            warnings.push(
              `[${cohortYear}학년도 입학생, "${sheetName}" ${excelRowNo}행] 과목명이 비어 있고 교과(군) "${gun}" + 학점 ${creditRaw}에 대한 공통과목 매핑이 없어 "${semesterLabel}" 항목을 건너뛰었습니다.`
            );
            continue;
          }
          const suffix = semesterLabel.endsWith('1학기') ? '1' : '2';
          courseName = `${resolved}${suffix}`;
        }

        const area = mapArea(gun, courseName, unmappedGunSet);
        bucket.rows.push({
          cohort_year: cohortYear,
          semester: semesterLabel,
          name: courseName,
          area,
          type: dbType,
          group_name: groupName,
          pick,
          credit: toNumberOrDefault(creditRaw, 0),
          sort_order: sortOrder++,
        });
      }
    }
  }

  if (unmappedGunSet.size) {
    warnings.push(
      `다음 교과(군)에 대한 매핑이 없어 "교양"으로 분류되었습니다: ${[...unmappedGunSet].join(', ')}. ` +
      `의도한 분류가 아니라면 cohortXlsxParser.js의 AREA_BY_GUN에 추가해 주세요.`
    );
  }

  for (const [cohortYear, bucket] of cohortBuckets.entries()) {
    if (bucket.sheetNames.size > 1) {
      warnings.push(
        `${cohortYear}학년도 입학생으로 인식된 시트가 여러 개입니다(${[...bucket.sheetNames].join(', ')}) — 모두 함께 반영됩니다.`
      );
    }
    if (!bucket.rows.length) {
      warnings.push(`${cohortYear}학년도 입학생 시트에서 유효한 과목 행을 찾지 못했습니다.`);
    }
  }

  const cohorts = [...cohortBuckets.entries()]
    .map(([cohortYear, bucket]) => ({
      cohortYear,
      sheetNames: [...bucket.sheetNames],
      rows: bucket.rows,
    }))
    .sort((a, b) => a.cohortYear - b.cohortYear);

  return { cohorts, warnings, skippedSheets };
}

/** 미리보기용: 코호트 1개 분의 rows를 학기별 과목 수로 집계 (표준 학기 순서 고정). */
export function summarizeCohortSemesters(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.semester, (counts.get(row.semester) || 0) + 1);
  }
  return SEMESTER_ORDER
    .filter(semester => counts.has(semester))
    .map(semester => ({ semester, count: counts.get(semester) }))
    .concat(
      [...counts.entries()]
        .filter(([semester]) => !SEMESTER_ORDER.includes(semester))
        .map(([semester, count]) => ({ semester, count }))
    );
}
