import { supabase } from './supabaseClient.js';
import { CONFIG } from './config.js';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** 학급/번호(학년 포함) 표기 정규화 — "09" → "9", "03" → "3".
 *  숫자로 해석되지 않는 값(빈 문자열 등)은 trim한 원본을 그대로 반환.
 *  저장 시(saveStudentProfile/saveStudentSelection/adminUpdateStudent)와 조회 시
 *  (fetchStudentSelections) 양쪽에서 모두 거쳐가게 해서, 이미 "09"처럼 앞자리 0이
 *  붙어 저장된 기존 데이터와 새로 "9"로 저장되는 데이터가 같은 값으로 취급되도록 한다. */
function normalizeNumeric(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed === '') return '';
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return trimmed;
  return String(n);
}

function splitPipe(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  return text.split('|').map(v => v.trim()).filter(Boolean);
}

function splitLooseList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(/\r?\n|[|,·]/)
    .map(v => v.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function stableBySortOrder(rows) {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const sa = Number.isFinite(Number(a.row.sort_order)) ? Number(a.row.sort_order) : Number.MAX_SAFE_INTEGER;
      const sb = Number.isFinite(Number(b.row.sort_order)) ? Number(b.row.sort_order) : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.index - b.index;
    })
    .map(item => item.row);
}

function ensureSelectedMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, flag] of Object.entries(value)) {
    if (flag) result[key] = true;
  }
  return result;
}

async function selectAll(table, columns = '*') {
  const { data, error } = await supabase.from(table).select(columns);
  if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
  return data || [];
}

// 학기 카드가 항상 이 순서로 표시되도록 하는 기준 목록. semester_courses의 sort_order는
// "같은 학기 안에서 과목이 나열되는 순서"만 보장할 뿐, 학기 그룹 자체가 나열되는 순서는
// (fetchSemesterCourses()가 행을 훑어가며 처음 마주치는 (cohort_year, semester) 조합
// 순서대로) 원본 엑셀에서 과목들이 어떤 순서로 입력됐는지에 우연히 좌우된다 — 예를 들어
// 2024학년도 입학생 코호트 시트는 "2학년 2학기" 학점이 채워진 행이 "2학년 1학기" 학점
// 행보다 먼저 나와서, 실제 화면에 "2학년 2학기 | 2학년 1학기 | 3학년 2학기 | 3학년 1학기"
// 순서로(2026-07 발견) 뒤섞여 보이는 문제가 있었다. 학기 그룹은 항상 아래 정해진 순서로
// 재정렬해 이런 원본 데이터 순서에 좌우되지 않게 한다(목록에 없는 학기 라벨은 뒤로 보내되
// 서로 간의 상대 순서는 유지 — Array.prototype.sort는 안정 정렬이므로 보장됨).
const SEMESTER_DISPLAY_ORDER = [
  '1학년 1학기', '1학년 2학기',
  '2학년 1학기', '2학년 2학기',
  '3학년 1학기', '3학년 2학기',
];

function semesterSortIndex(semester) {
  const idx = SEMESTER_DISPLAY_ORDER.indexOf(semester);
  return idx === -1 ? SEMESTER_DISPLAY_ORDER.length : idx;
}

// 학년 → 입학년도(코호트) 환산. app_settings.current_academic_year 기준.
// 공식: cohort_year = currentAcademicYear - grade + 1
// 예: 2026학년도에 2학년이면 cohort_year = 2026 - 2 + 1 = 2025 (2025년 입학생)
export function getCohortYear(grade, currentAcademicYear) {
  const g = Number(grade);
  const y = Number(currentAcademicYear);
  if (!Number.isFinite(g) || !Number.isFinite(y) || g <= 0) return null;
  return y - g + 1;
}

/**
 * fetchSemesterCourses()가 반환하는, 모든 코호트가 섞인 (cohortYear, semester) 그룹 배열에서
 * 특정 코호트 1개만 골라 기존 컴포넌트들이 기대하는 [{ semester, courses }] 형태로 변환.
 */
export function pickCohortSemesters(allCohortGroups, cohortYear) {
  const target = String(cohortYear ?? '').trim();
  return (allCohortGroups || [])
    .filter(group => String(group.cohortYear ?? '') === target)
    .map(group => ({ semester: group.semester, courses: group.courses }));
}

export async function fetchSemesterCourses() {
  const cached = sessionStorage.getItem('cache_semester');
  if (cached) return JSON.parse(cached);

  const rows = await selectAll(
    'semester_courses',
    'cohort_year,semester,name,area,type,group_name,pick,credit,sort_order'
  );

  const ordered = stableBySortOrder(rows);
  const map = new Map();
  for (const row of ordered) {
    const semester = row.semester || '';
    if (!semester) continue;
    const cohortYear = row.cohort_year != null ? String(row.cohort_year) : '';
    const key = `${cohortYear}::${semester}`;
    if (!map.has(key)) map.set(key, { cohortYear, semester, courses: [] });

    map.get(key).courses.push({
      name: row.name || '',
      area: row.area || '',
      type: row.type || '',
      group: row.group_name || row.group || '',
      pick: Number(row.pick) || 0,
      credit: Number(row.credit) || 0,
    });
  }

  // ⚠ Map 삽입 순서(= 원본 엑셀에서 각 (코호트, 학기) 조합을 처음 마주친 순서) 그대로
  // 반환하지 않고, 항상 SEMESTER_DISPLAY_ORDER 기준으로 재정렬한다 — 위 주석 참고.
  // 같은 코호트끼리 묶이도록 cohortYear로 먼저 정렬한 뒤, 그 안에서 학기 순서를 정렬한다.
  const result = [...map.values()].sort((a, b) => {
    if (a.cohortYear !== b.cohortYear) return a.cohortYear < b.cohortYear ? -1 : 1;
    return semesterSortIndex(a.semester) - semesterSortIndex(b.semester);
  });
  sessionStorage.setItem('cache_semester', JSON.stringify(result));
  return result;
}

// ── 관리자 "데이터 관리" 서브탭: 교육과정(semester_courses) 엑셀 업로드 ──────

/** 코호트(입학년도)별 현재 DB에 등록된 과목 수 요약.
 *  업로드 전/후 비교("2025학년도: 214행 → 208행")나, "아직 등록된 과목이 없습니다"
 *  안내에 사용한다. */
export async function fetchSemesterCourseCohortSummary() {
  const rows = await selectAll('semester_courses', 'cohort_year');
  const counts = new Map();
  for (const row of rows) {
    const year = row.cohort_year != null && row.cohort_year !== '' ? Number(row.cohort_year) : null;
    if (year === null || !Number.isFinite(year)) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([cohortYear, count]) => ({ cohortYear, count }))
    .sort((a, b) => a.cohortYear - b.cohortYear);
}

/** 업로드 미리보기 비교용: 지정한 코호트들의 기존 교육과정 원본 행을 조회한다. */
export async function fetchSemesterCourseRowsForCohorts(cohortYears = []) {
  const years = unique((cohortYears || [])
    .map(year => Number(year))
    .filter(year => Number.isFinite(year)));
  if (!years.length) return [];

  const { data, error } = await supabase
    .from('semester_courses')
    .select('cohort_year,semester,name,area,type,group_name,pick,credit,sort_order')
    .in('cohort_year', years);
  if (error) throw new Error(`기존 교육과정 조회 실패: ${error.message}`);
  return stableBySortOrder(data || []);
}

/** 특정 입학년도(코호트)의 semester_courses를 통째로 교체("전체 교체" 방식).
 *  먼저 그 cohort_year의 기존 행을 모두 삭제한 뒤 새 rows를 삽입한다.
 *  upsert 대신 delete+insert를 쓰면 원본 엑셀에서 삭제된 과목도 DB에서 확실히 제거된다.
 *  대량 insert 시 요청 크기 문제를 피하려고 청크 단위로 나눠 보낸다.
 *  ⚠ RLS: semester_courses에 관리자(is_admin()) 대상 INSERT/DELETE 정책이 있어야 한다.
 *  신규 배포는 supabase/schema.sql 전체 실행으로 이 정책을 적용한다. */
export async function replaceSemesterCoursesForCohort(cohortYear, rows) {
  const year = Number(cohortYear);
  if (!Number.isFinite(year)) throw new Error('유효하지 않은 입학년도(cohort_year)입니다.');

  const { error: deleteError } = await supabase
    .from('semester_courses')
    .delete()
    .eq('cohort_year', year);
  if (deleteError) throw new Error(`${year}학년도 입학생 기존 교육과정 삭제 실패: ${deleteError.message}`);

  const payload = (rows || []).map(row => ({ ...row, cohort_year: year }));
  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error: insertError } = await supabase.from('semester_courses').insert(chunk);
    if (insertError) {
      throw new Error(
        `${year}학년도 입학생 교육과정 저장 실패(${i + 1}~${i + chunk.length}번째 행): ${insertError.message}`
      );
    }
  }

  sessionStorage.removeItem('cache_semester');
}

export async function fetchUniversityRecommendations() {
  // ⚠ 캐시 키에 버전(v2)을 붙여 둠 — 핵심/권장과목 병합 구조(반영과목) ETL 개편 이전에
  // 저장된 구버전 'cache_univ' 데이터가 sessionStorage에 남아 있어도 자동으로 무시되고
  // 새 구조로 다시 조회되도록 함. 다음에 university_recommendations 데이터 구조를 바꿀 때도
  // 이 버전 숫자를 올리면 동일하게 안전하게 무효화할 수 있음.
  sessionStorage.removeItem('cache_univ');
  const cached = sessionStorage.getItem('cache_univ_v2');
  if (cached) return JSON.parse(cached);

  const rows = await selectAll(
    'university_recommendations',
    'university,region_area,series,department,detail_department,tags,core,recommended,reflected,note,sort_order'
  );

  const ordered = stableBySortOrder(rows);
  const result = ordered.map(row => ({
    university: row.university || '',
    regionArea: row.region_area || row.regionArea || '',
    series: row.series || '',
    department: row.department || '',
    detailDepartment: row.detail_department || row.detailDepartment || '',
    tags: splitPipe(row.tags),
    core: splitPipe(row.core),
    recommended: splitPipe(row.recommended),
    reflected: splitPipe(row.reflected),
    note: row.note || '',
  }));

  sessionStorage.setItem('cache_univ_v2', JSON.stringify(result));
  return result;
}

export async function fetchSeriesMatrix() {
  const cached = sessionStorage.getItem('cache_series_matrix_v1');
  if (cached) return JSON.parse(cached);

  const rows = await selectAll(
    'series_reflected_matrix',
    'series,department,university,required_subjects,sort_order'
  );

  const ordered = stableBySortOrder(rows);
  const result = ordered.map(row => ({
    series: row.series || '',
    department: row.department || '',
    university: row.university || '',
    requiredSubjects: splitPipe(row.required_subjects || row.requiredSubjects),
  }));

  sessionStorage.setItem('cache_series_matrix_v1', JSON.stringify(result));
  return result;
}

// ── 관리자 "데이터 관리" 서브탭: 대학 추천과목 / 계열별 반영과목 엑셀 업로드 ────
// semester_courses와 달리 이 두 테이블은 코호트(입학년도) 구분이 없는 전역 테이블이라,
// "전체 교체"가 코호트 단위가 아니라 테이블 전체 단위로 이뤄진다.

/** 현재 university_recommendations에 등록된 총 행 수. */
export async function fetchUniversityRecommendationsSummary() {
  const { count, error } = await supabase
    .from('university_recommendations')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`대학 추천과목 현황 조회 실패: ${error.message}`);
  return { count: count || 0 };
}

/** 업로드 미리보기 비교용: 기존 대학 추천과목 전체 행을 조회한다. */
export async function fetchUniversityRecommendationRows() {
  const rows = await selectAll(
    'university_recommendations',
    'university,region_area,series,department,detail_department,tags,core,recommended,reflected,note,sort_order'
  );
  return stableBySortOrder(rows);
}

/** 현재 series_reflected_matrix에 등록된 총 행 수. */
export async function fetchSeriesMatrixSummary() {
  const { count, error } = await supabase
    .from('series_reflected_matrix')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`계열별 반영과목 현황 조회 실패: ${error.message}`);
  return { count: count || 0 };
}

/** 업로드 미리보기 비교용: 기존 계열별 반영과목 전체 행을 조회한다. */
export async function fetchSeriesMatrixRowsForCompare() {
  const rows = await selectAll(
    'series_reflected_matrix',
    'series,department,university,required_subjects,sort_order'
  );
  return stableBySortOrder(rows);
}

/** university_recommendations 테이블 전체를 새 rows로 교체("전체 교체").
 *  코호트 구분이 없는 전역 테이블이므로 semester_courses처럼 조건별 삭제가 아니라
 *  테이블 전체를 비운 뒤 다시 채운다. id는 identity(bigint, 항상 > 0)이므로
 *  `.gt('id', 0)`이 사실상 "조건 없이 전체 삭제"와 같다(Supabase는 delete에 filter가
 *  없으면 에러를 내므로 항상 참인 조건을 명시적으로 걸어준다). */
export async function replaceAllUniversityRecommendations(rows) {
  const { error: deleteError } = await supabase
    .from('university_recommendations')
    .delete()
    .gt('id', 0);
  if (deleteError) throw new Error(`기존 대학 추천과목 삭제 실패: ${deleteError.message}`);

  const chunkSize = 500;
  const payload = rows || [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error: insertError } = await supabase.from('university_recommendations').insert(chunk);
    if (insertError) {
      throw new Error(
        `대학 추천과목 저장 실패(${i + 1}~${i + chunk.length}번째 행): ${insertError.message}`
      );
    }
  }

  sessionStorage.removeItem('cache_univ');
  sessionStorage.removeItem('cache_univ_v2');
}

/** series_reflected_matrix 테이블 전체를 새 rows로 교체("전체 교체"). */
export async function replaceAllSeriesReflectedMatrix(rows) {
  const { error: deleteError } = await supabase
    .from('series_reflected_matrix')
    .delete()
    .gt('id', 0);
  if (deleteError) throw new Error(`기존 계열별 반영과목 삭제 실패: ${deleteError.message}`);

  const chunkSize = 500;
  const payload = rows || [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error: insertError } = await supabase.from('series_reflected_matrix').insert(chunk);
    if (insertError) {
      throw new Error(
        `계열별 반영과목 저장 실패(${i + 1}~${i + chunk.length}번째 행): ${insertError.message}`
      );
    }
  }

  sessionStorage.removeItem('cache_series_matrix_v1');
}

export async function fetchSubjectExamples() {
  const cached = sessionStorage.getItem('cache_subject_examples_v2');
  if (cached) return JSON.parse(cached);

  const rows = await selectAll(
    'subject_examples',
    'series,department,similar_departments,subjects,sort_order'
  );

  const ordered = stableBySortOrder(rows);
  const result = ordered
    .filter(row => row.series || row.department)
    .map(row => ({
      series: row.series || '',
      department: row.department || '',
      similarDepartments: unique(splitLooseList(row.similar_departments)),
      subjects: unique(splitLooseList(row.subjects)),
    }));

  sessionStorage.setItem('cache_subject_examples_v2', JSON.stringify(result));
  return result;
}

// ⚠ 현재 src/ 어디에서도 사용되지 않는 죽은 코드(dead code).
// selectionView.js/teacherView.js의 실제 그룹·선택개수 제한 로직은 semester_courses의
// 각 행에 있는 group_name/pick 값을 그대로 사용하므로 코호트별로 그룹 번호가 달라도
// 자동으로 대응됨(코호트에 의존하지 않음). 이 상수는 과거 일괄 마이그레이션 스크립트
// 작성 시 참고용으로 남겨둔 것이며, 새로 추가/변경하지 않아도 무방함.
export const STUDENT_SELECTION_GROUPS = [
  { semester: '2학년 1학기', group: '선택3', pick: 3 },
  { semester: '2학년 1학기', group: '선택4', pick: 1 },
  { semester: '2학년 2학기', group: '선택5', pick: 3 },
  { semester: '2학년 2학기', group: '선택6', pick: 1 },
  { semester: '3학년 1학기', group: '선택7', pick: 5 },
  { semester: '3학년 1학기', group: '선택8', pick: 2 },
  { semester: '3학년 1학기', group: '선택9', pick: 1 },
  { semester: '3학년 2학기', group: '선택10', pick: 8 },
  { semester: '3학년 2학기', group: '선택11', pick: 1 },
];

function selectedMapToItems(selectedMap) {
  const items = [];
  for (const key of Object.keys(selectedMap || {})) {
    const [semester, group, courseName] = key.split('::');
    if (!semester || !group || !courseName) continue;
    items.push({ semester, group, courseName });
  }

  return items.sort((a, b) => {
    const sem = String(a.semester).localeCompare(String(b.semester), 'ko');
    if (sem) return sem;
    const grp = String(a.group).localeCompare(String(b.group), 'ko');
    if (grp) return grp;
    return String(a.courseName).localeCompare(String(b.courseName), 'ko');
  });
}

function parseStudentEmail(email) {
  const localPart = String(email || '').split('@')[0] || '';
  const match = localPart.match(/^(\d{4})(\d)(\d{2})(\d{2})$/);
  if (!match) {
    return {
      entryYear: '',
      studentId: '',
      grade: '',
      classNo: '',
      number: '',
    };
  }

  return {
    entryYear: match[1],
    studentId: `${match[2]}${match[3]}${match[4]}`,
    grade: match[2],
    classNo: match[3],
    number: match[4],
  };
}

/** 본인 가입 신청 내역 조회 (승인 후 최초 로그인 시 학년·반·번호를 새로 입력받지 않고
 *  가입 신청 때 이미 적은 값으로 자동 채우는 데 사용). RLS의 student_requests_self_read
 *  정책으로 로그인한 본인 이메일 행만 조회 가능 — 관리자 권한 없이도 호출 가능. */
export async function fetchMyStudentRequest(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;
  try {
    const { data, error } = await supabase
      .from('student_requests')
      .select('name,grade,class_no,number')
      .eq('email', targetEmail)
      .maybeSingle();
    if (error || !data) return null;
    return {
      name: data.name || '',
      grade: data.grade || '',
      classNo: data.class_no || '',
      number: data.number || '',
    };
  } catch {
    return null;
  }
}

/** 로그인한 사용자 본인의 수강신청/결과 확인 바로가기 URL(student_requests.portal_url
 *  또는 teacher_requests.portal_url, 2026-07 추가). 상단 헤더의 "수강신청 바로가기"
 *  버튼 표시 여부/링크에 사용. RLS의 student_requests_self_read / teacher_requests_self_read
 *  정책으로 로그인한 본인 이메일 행만 조회 가능(관리자 권한 불필요).
 *  신청 기록이 없는 계정(직접 추가된 교사 등)은 빈 문자열을 반환한다. */
export async function fetchMyPortalUrl(email, role) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail || (role !== 'student' && role !== 'teacher')) return '';
  const table = role === 'teacher' ? 'teacher_requests' : 'student_requests';
  try {
    const { data, error } = await supabase
      .from(table)
      .select('portal_url')
      .eq('email', targetEmail)
      .maybeSingle();
    if (error || !data) return '';
    return data.portal_url || '';
  } catch {
    return '';
  }
}

export async function fetchStudentSelection(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;

  const { data, error } = await supabase
    .from('student_selections')
    .select('name,grade,class_no,number,selected_map')
    .eq('email', targetEmail)
    .maybeSingle();

  if (error) throw new Error(`학생 선택 조회 실패: ${error.message}`);
  if (!data) return null;
  return {
    name: data.name || '',
    grade: data.grade || '',
    classNo: data.class_no || '',
    number: data.number || '',
    selectedMap: ensureSelectedMap(data.selected_map),
  };
}

/** 학생 선택과목 저장 (프로필 포함) */
export async function saveStudentSelection(email, name, selectedMap, profile = {}) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');
  const payload = {
    email: targetEmail,
    name: String(name || '').trim(),
    grade: normalizeNumeric(profile.grade),
    class_no: normalizeNumeric(profile.classNo || profile.class_no),
    number: normalizeNumeric(profile.number),
    selected_map: ensureSelectedMap(selectedMap),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('student_selections')
    .upsert(payload, { onConflict: 'email' });

  if (error) throw new Error(`학생 선택 저장 실패: ${error.message}`);
}

/** 학생 프로필만 저장 (선택과목 건드리지 않음) */
export async function saveStudentProfile(email, { name, grade, classNo, number }) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');

  // 기존 selected_map 유지하면서 upsert
  const { data: existing } = await supabase
    .from('student_selections')
    .select('selected_map')
    .eq('email', targetEmail)
    .maybeSingle();

  const payload = {
    email: targetEmail,
    name: String(name || '').trim(),
    grade: normalizeNumeric(grade),
    class_no: normalizeNumeric(classNo),
    number: normalizeNumeric(number),
    selected_map: existing?.selected_map ?? {},
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('student_selections')
    .upsert(payload, { onConflict: 'email' });

  if (error) throw new Error(`프로필 저장 실패: ${error.message}`);
}

/** 관리자가 특정 학생의 정보 + 선택과목 수정.
 *  ⚠ student_selections에 아직 행이 없는 학생(승인은 됐지만 한 번도 선택을 저장하지
 *  않은 학생 — fetchStudentSelections()가 student_emails/student_requests로 보강해
 *  보여주는 "가짜" 행)도 수정 화면에 나타날 수 있으므로, update가 아니라 upsert를
 *  써야 한다. update는 일치하는 행이 없으면 조용히 0건 영향으로 끝나버려 "수정"이
 *  눌러도 아무 일도 안 일어나는 것처럼 보이는 문제가 있었음. */
export async function adminUpdateStudent(email, { name, grade, classNo, number, selectedMap }) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');

  const { data: existing } = await supabase
    .from('student_selections')
    .select('selected_map')
    .eq('email', targetEmail)
    .maybeSingle();

  const payload = {
    email: targetEmail,
    name: String(name || '').trim(),
    grade: normalizeNumeric(grade),
    class_no: normalizeNumeric(classNo),
    number: normalizeNumeric(number),
    selected_map: selectedMap !== undefined ? ensureSelectedMap(selectedMap) : (existing?.selected_map ?? {}),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from('student_selections')
    .upsert(payload, { onConflict: 'email' });

  if (error) throw new Error(`학생 정보 수정 실패: ${error.message}`);
}

/** 관리자: 학생 가입 신청 목록의 기본 정보를 수정한다.
 *  승인/저장 이력이 있는 학생은 student_selections의 기본 정보도 함께 맞춘다. */
export async function adminUpdateStudentRequestInfo(requestId, email, { name, grade, classNo, number }) {
  const targetEmail = normalizeEmail(email);
  if (!requestId) throw new Error('신청 ID가 없습니다.');
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');

  const clean = {
    name: String(name || '').trim(),
    grade: normalizeNumeric(grade),
    classNo: normalizeNumeric(classNo),
    number: normalizeNumeric(number),
  };

  const { error: requestError } = await supabase
    .from('student_requests')
    .update({
      name: clean.name,
      grade: clean.grade,
      class_no: clean.classNo,
      number: clean.number,
    })
    .eq('id', requestId);
  if (requestError) throw new Error(`학생 신청 정보 수정 실패: ${requestError.message}`);

  const [
    { data: allowed, error: allowedError },
    { data: existing, error: existingError },
  ] = await Promise.all([
    supabase.from('student_emails').select('email').eq('email', targetEmail).maybeSingle(),
    supabase.from('student_selections').select('selected_map').eq('email', targetEmail).maybeSingle(),
  ]);
  if (allowedError) throw new Error(`학생 승인 정보 확인 실패: ${allowedError.message}`);
  if (existingError) throw new Error(`학생 선택 정보 확인 실패: ${existingError.message}`);

  if (allowed || existing) {
    const { error: selectionError } = await supabase
      .from('student_selections')
      .upsert({
        email: targetEmail,
        name: clean.name,
        grade: clean.grade,
        class_no: clean.classNo,
        number: clean.number,
        selected_map: ensureSelectedMap(existing?.selected_map),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'email' });
    if (selectionError) throw new Error(`학생 선택 정보 동기화 실패: ${selectionError.message}`);
  }
}

/** 관리자: 수강신청 일괄 업로드 결과를 student_selections에 반영한다. */
export async function adminBulkUpdateStudentSelections(rows = []) {
  const payload = (rows || [])
    .map(row => {
      const targetEmail = normalizeEmail(row.email);
      if (!targetEmail) return null;
      return {
        email: targetEmail,
        name: String(row.name || '').trim(),
        grade: normalizeNumeric(row.grade),
        class_no: normalizeNumeric(row.classNo || row.class_no),
        number: normalizeNumeric(row.number),
        selected_map: ensureSelectedMap(row.selectedMap || row.selected_map),
        updated_at: new Date().toISOString(),
      };
    })
    .filter(Boolean);

  const chunkSize = 500;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('student_selections')
      .upsert(chunk, { onConflict: 'email' });
    if (error) {
      throw new Error(`학생 선택 일괄 저장 실패(${i + 1}~${i + chunk.length}번째 행): ${error.message}`);
    }
  }
}

/** 관리자: 학생의 수강신청/결과 확인 바로가기 URL 개별 수정(student_requests.portal_url,
 *  2026-07 추가). student_requests 행이 이미 있으면 update, 없으면(가입 신청 경로를
 *  거치지 않고 "계정 일괄 생성"으로만 만들어졌거나 그 전에 문제가 있었던 극히 드문
 *  경우) 최소 정보로 새 행을 insert한다 — adminUpdateStudent()가 upsert를 쓰는 것과
 *  같은 이유(update는 일치하는 행이 없으면 조용히 0건으로 끝남). */
export async function adminUpdateStudentPortalUrl(email, portalUrl) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');
  const cleanUrl = String(portalUrl || '').trim();

  const { error, count } = await supabase
    .from('student_requests')
    .update({ portal_url: cleanUrl }, { count: 'exact' })
    .eq('email', targetEmail);
  if (error) throw new Error(`URL 저장 실패: ${error.message}`);

  if (!count) {
    const { error: insError } = await supabase
      .from('student_requests')
      .insert({ email: targetEmail, name: '', status: 'approved', portal_url: cleanUrl, reviewed_at: new Date().toISOString() });
    if (insError) throw new Error(`URL 저장 실패: ${insError.message}`);
  }
}

/** 관리자: 교사의 수강신청/결과 확인 바로가기 URL 개별 수정(teacher_requests.portal_url,
 *  2026-07 추가). adminUpdateStudentPortalUrl()과 동일한 이유로 upsert처럼 동작한다
 *  (직접 추가된 교사는 teacher_requests에 행 자체가 없을 수 있음). */
export async function adminUpdateTeacherPortalUrl(email, portalUrl) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');
  const cleanUrl = String(portalUrl || '').trim();

  const { error, count } = await supabase
    .from('teacher_requests')
    .update({ portal_url: cleanUrl }, { count: 'exact' })
    .eq('email', targetEmail);
  if (error) throw new Error(`URL 저장 실패: ${error.message}`);

  if (!count) {
    const { error: insError } = await supabase
      .from('teacher_requests')
      .insert({ email: targetEmail, name: '', status: 'approved', portal_url: cleanUrl, reviewed_at: new Date().toISOString() });
    if (insError) throw new Error(`URL 저장 실패: ${insError.message}`);
  }
}

/** 관리자: "회원 관리" → "교사 계정 관리" 표의 "수정" 버튼(2026-08 추가)에서 개별 교사의
 *  이름/담당 교과/담임 학년·반/수강신청 URL을 한 번에 수정. teacher_requests는 이미
 *  admin(is_admin())에게 전체 접근 RLS 정책(teacher_requests_admin_all)이 열려 있으므로
 *  별도 마이그레이션 없이 바로 update할 수 있다. updateMyTeacherProfile()과 동일하게
 *  update 대상 행이 없으면(드묾 — "계정 일괄 생성" 등으로 다른 경로로 만들어진 계정)
 *  insert로 대체한다(upsert 유사 패턴). homeroomGrade/homeroomClass 판별 규칙은
 *  deriveTeacherHomeroomKind() 참고(homeroomClass가 비었거나 '0'이면 학년부장/비담임). */
export async function adminUpdateTeacherProfile(email, { name, subjectArea, homeroomGrade, homeroomClass, portalUrl }) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');
  const cleanName = String(name || '').trim();
  const cleanSubjectArea = String(subjectArea || '').trim();
  const cleanHomeroomGrade = String(homeroomGrade || '').trim();
  const cleanHomeroomClass = String(homeroomClass || '').trim();
  const cleanPortalUrl = String(portalUrl || '').trim();

  const patch = {
    name: cleanName,
    subject_area: cleanSubjectArea,
    homeroom_grade: cleanHomeroomGrade,
    homeroom_class: cleanHomeroomClass,
    portal_url: cleanPortalUrl,
  };

  const { error, count } = await supabase
    .from('teacher_requests')
    .update(patch, { count: 'exact' })
    .eq('email', targetEmail);
  if (error) throw new Error(`교사 정보 수정 실패: ${error.message}`);

  if (!count) {
    const { error: insError } = await supabase
      .from('teacher_requests')
      .insert({
        email: targetEmail,
        ...patch,
        auth_method: 'email',
        status: 'approved',
        reviewed_at: new Date().toISOString(),
      });
    if (insError) throw new Error(`교사 정보 수정 실패: ${insError.message}`);
  }
}

/** 학생 선택 현황 + 회원 명단 통합 조회.
 *  ⚠ 예전에는 student_selections 테이블만 조회했기 때문에, 관리자가 학생 가입을
 *  승인해도 그 학생이 "과목 선택하기"에서 한 번이라도 저장하기 전까지는
 *  student_selections에 행이 없어 교사용/관리자용 학생 목록(학생 회원 관리 포함)에
 *  전혀 나타나지 않는 문제가 있었음. 이제 student_emails(승인된 계정 전체)도 함께
 *  조회해서, 아직 선택을 저장하지 않은 학생도 빈 선택 상태("선택 없음")로 목록에
 *  포함시킨다. 이름/학년/반/번호는 student_selections에 값이 있으면 그것을 쓰고,
 *  없으면 가입 신청 시 입력한 student_requests 값으로 보강한다. */
export async function fetchStudentSelections() {
  const [selectionRows, emailRows, requestRows] = await Promise.all([
    selectAll('student_selections', 'email,name,grade,class_no,number,selected_map,updated_at'),
    selectAll('student_emails', 'email'),
    selectAll('student_requests', 'email,name,grade,class_no,number,status,portal_url'),
  ]);

  const selectionByEmail = new Map();
  selectionRows.forEach(row => selectionByEmail.set(normalizeEmail(row.email), row));

  // 같은 이메일로 여러 번 신청했을 수 있으므로, approved 신청 중 가장 마지막에 잡힌 것을 사용.
  // (selectAll에 정렬이 없으므로 순서는 보장하지 않지만, 신청 정보는 보조적 fallback일 뿐이라
  //  실질적 영향은 없음 — student_selections에 값이 있으면 항상 그것이 우선한다.)
  const requestByEmail = new Map();
  requestRows.forEach(row => {
    if (row.status === 'approved') requestByEmail.set(normalizeEmail(row.email), row);
  });

  // student_selections에는 있지만 student_emails 허용목록엔 없는 경우(권한 해제됐지만
  // 데이터는 남아있는 경우)도 그대로 보여준다 — 데이터 자체가 사라지는 건 아니므로.
  const allEmails = new Set([
    ...selectionRows.map(row => normalizeEmail(row.email)),
    ...emailRows.map(row => normalizeEmail(row.email)),
  ]);

  return [...allEmails]
    .map(email => {
      const row = selectionByEmail.get(email);
      const reqInfo = requestByEmail.get(email);
      const selectedMap = ensureSelectedMap(row?.selected_map);
      // DB 컬럼 우선 → 가입 신청 정보 → 이메일 파싱 순으로 fallback
      const fromEmail = parseStudentEmail(email);

      return {
        timestamp: row?.updated_at || '',
        email,
        name: row?.name || reqInfo?.name || '',
        grade:   normalizeNumeric(row?.grade    || reqInfo?.grade    || fromEmail.grade),
        classNo: normalizeNumeric(row?.class_no || reqInfo?.class_no || fromEmail.classNo),
        number:  normalizeNumeric(row?.number   || reqInfo?.number   || fromEmail.number),
        portalUrl: reqInfo?.portal_url || '',
        selectedMap,
        selections: selectedMapToItems(selectedMap),
        hasSavedSelection: Boolean(row),
      };
    })
    .sort((a, b) => {
      const gradeCompare = String(a.grade).localeCompare(String(b.grade), 'ko');
      if (gradeCompare) return gradeCompare;
      const classCompare = String(a.classNo).localeCompare(String(b.classNo), 'ko');
      if (classCompare) return classCompare;
      return String(a.number).localeCompare(String(b.number), 'ko');
    });
}

export async function fetchLinks() {
  const cached = sessionStorage.getItem('cache_links');
  if (cached) return JSON.parse(cached);

  const rows = await selectAll(
    'links',
    'category,name,url,description,tags,sort_order'
  );

  const ordered = stableBySortOrder(rows);
  const result = ordered
    .map(row => ({
      category: row.category || '',
      name: row.name || '',
      url: row.url || '',
      description: row.description || '',
      tags: row.tags || '',
    }))
    .filter(row => row.name);

  sessionStorage.setItem('cache_links', JSON.stringify(result));
  return result;
}

// ── 관리자 "데이터 관리" 서브탭: 참고사이트 엑셀 업로드 ────────────────────

/** 현재 links에 등록된 총 행 수. */
export async function fetchLinksSummary() {
  const { count, error } = await supabase
    .from('links')
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`참고사이트 현황 조회 실패: ${error.message}`);
  return { count: count || 0 };
}

/** 업로드 미리보기 비교용: 기존 참고사이트 전체 행을 조회한다. */
export async function fetchLinkRowsForCompare() {
  const rows = await selectAll(
    'links',
    'category,name,url,description,tags,sort_order'
  );
  return stableBySortOrder(rows);
}

/** links 테이블 전체를 새 rows로 교체("전체 교체"). */
export async function replaceAllLinks(rows) {
  const { error: deleteError } = await supabase
    .from('links')
    .delete()
    .gt('id', 0);
  if (deleteError) throw new Error(`기존 참고사이트 삭제 실패: ${deleteError.message}`);

  const chunkSize = 500;
  const payload = rows || [];
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const { error: insertError } = await supabase.from('links').insert(chunk);
    if (insertError) {
      throw new Error(`참고사이트 저장 실패(${i + 1}~${i + chunk.length}번째 행): ${insertError.message}`);
    }
  }

  sessionStorage.removeItem('cache_links');
}

export async function fetchConfig() {
  const cached = sessionStorage.getItem('cache_config');
  if (cached) return JSON.parse(cached);

  const rows = await selectAll('app_settings', 'key,value');
  const obj = {};
  for (const row of rows) {
    const key = String(row.key || '').trim();
    if (!key) continue;
    obj[key] = row.value ?? '';
  }

  sessionStorage.setItem('cache_config', JSON.stringify(obj));
  return obj;
}

export async function saveAppSettings(settings = {}) {
  const rows = Object.entries(settings)
    .map(([key, value]) => ({ key: String(key).trim(), value: String(value ?? '').trim() }))
    .filter(row => row.key);
  if (!rows.length) return;
  const { error } = await supabase
    .from('app_settings')
    .upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(`기본 설정 저장 실패: ${error.message}`);
  sessionStorage.removeItem('cache_config');
}

export async function fetchTeacherEmails() {
  const rows = await selectAll('teacher_emails', 'email');
  return rows
    .map(row => normalizeEmail(row.email))
    .filter(Boolean);
}

/** 승인된 학생 계정 수만 조회(전체 목록을 내려받지 않고 count만 사용 — "계정 일괄
 *  생성" 화면의 "현재 등록 현황" 표시용). */
export async function fetchStudentEmailsCount() {
  const { count, error } = await supabase
    .from('student_emails')
    .select('email', { count: 'exact', head: true });
  if (error) throw new Error(`학생 계정 수 조회 실패: ${error.message}`);
  return count || 0;
}

// ── 교사 신청 관련 (관리자 전용) ─────────────────────────

/** 교사 신청 목록 조회 (관리자만 접근 가능) */
export async function fetchTeacherRequests() {
  const { data, error } = await supabase
    .from('teacher_requests')
    // ⚠ subject_area는 renderTeacherRequestsPanel()(teacherView.js)이 교과군 열 표시에
    // 쓰는데도 기존 select 목록에 빠져 있었음(항상 '-'로 보이는 기존 버그) — 함께 보강.
    // homeroom_grade/homeroom_class는 담임/학년부장 구조화 정보(2026-07 추가, 아직 이
    // 관리자 화면에는 별도 노출하지 않지만 향후 표시/수정 UI를 위해 함께 조회해 둠).
    .select('id,email,name,subject_area,message,status,created_at,reviewed_at,portal_url,homeroom_grade,homeroom_class')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`교사 신청 목록 조회 실패: ${error.message}`);
  return data || [];
}

/** 교사 신청 승인: teacher_emails 추가 + 신청 상태 업데이트 */
export async function approveTeacherRequest(requestId, email) {
  // 1) teacher_emails 에 추가 (이미 있으면 무시)
  const { error: insertError } = await supabase
    .from('teacher_emails')
    .insert({ email: normalizeEmail(email) });
  if (insertError && insertError.code !== '23505') {
    // 23505 = unique violation (이미 등록된 교사) → 허용
    throw new Error(`교사 이메일 등록 실패: ${insertError.message}`);
  }
  // 2) teacher_requests 상태 업데이트
  const { error: updateError } = await supabase
    .from('teacher_requests')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', requestId);
  if (updateError) throw new Error(`신청 상태 업데이트 실패: ${updateError.message}`);
}

/** 교사 신청 거부 */
export async function rejectTeacherRequest(requestId) {
  const { error } = await supabase
    .from('teacher_requests')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) throw new Error(`신청 거부 실패: ${error.message}`);
}

/** 교사 등록 해제 */
export async function removeTeacherEmail(email) {
  const { error } = await supabase
    .from('teacher_emails')
    .delete()
    .eq('email', normalizeEmail(email));
  if (error) throw new Error(`교사 이메일 삭제 실패: ${error.message}`);
}

/** 관리자: 학생 강제 탈퇴 (선택 데이터 삭제 + 로그인 권한 회수).
 *  ⚠ 예전에는 student_selections만 지웠고 student_emails(로그인 허용목록)는 그대로
 *  뒀기 때문에, 강퇴된 학생이 여전히 로그인할 수 있었다. 로그인 후 "과목 선택하기"에서
 *  뭔가 저장하면(또는 프로필이 자동 upsert되면) student_selections 행이 다시 생겨서
 *  "삭제한 데이터가 자꾸 살아난다"는 증상으로 나타났음. 단순 권한 회수만 원하면
 *  removeStudentEmail()(학생 가입 신청 관리의 "해제")을 쓰고, 데이터까지 완전히
 *  지우는 강퇴는 이 함수를 쓴다. */
export async function adminDeleteStudent(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');

  // ⚠ Supabase는 RLS 정책이 막아서 실제로는 0건이 삭제돼도 error를 반환하지 않는다
  // (정책상 "내가 볼 수 없는/지울 수 없는 행"은 그냥 조용히 대상에서 빠질 뿐, 에러가 아님).
  // 그래서 error만 검사하면 "강퇴를 눌러도 새로고침하면 되살아난다"는 증상이 아무 단서도
  // 없이 재현된다 — count로 실제 삭제된 행 수를 확인해서, 0건이면 RLS 차단으로 간주하고
  // 명시적으로 에러를 던진다.
  const { error: selectionError, count: selectionCount } = await supabase
    .from('student_selections')
    .delete({ count: 'exact' })
    .eq('email', targetEmail);
  if (selectionError) throw new Error(`학생 데이터 삭제 실패: ${selectionError.message}`);

  const { error: emailError, count: emailCount } = await supabase
    .from('student_emails')
    .delete({ count: 'exact' })
    .eq('email', targetEmail);
  if (emailError) throw new Error(`학생 로그인 권한 회수 실패: ${emailError.message}`);

  if (!selectionCount && !emailCount) {
    throw new Error(
      '삭제된 행이 없습니다. Supabase의 student_selections/student_emails 테이블에 ' +
      '관리자가 DELETE할 수 있는 RLS(Row Level Security) 정책이 없을 가능성이 높습니다. ' +
      'Supabase 대시보드 → Authentication → Policies에서 두 테이블에 admin 역할(또는 ' +
      '로그인한 사용자 일반)의 DELETE를 허용하는 정책이 있는지 확인해 주세요.'
    );
  }
}

/** 교사 이메일 중복 확인 (신청 전 사전 검사) */
export async function checkTeacherEmailExists(email) {
  const target = normalizeEmail(email);
  if (!target) return { exists: false };

  // 1) 이미 승인된 교사
  const { data: te } = await supabase
    .from('teacher_emails')
    .select('email')
    .eq('email', target)
    .maybeSingle();
  if (te) return { exists: true, reason: '이미 교사로 등록된 이메일입니다.' };

  // 2) 기존 신청 내역
  const { data: tr } = await supabase
    .from('teacher_requests')
    .select('status')
    .eq('email', target)
    .maybeSingle();
  if (tr) {
    const msg = {
      pending:  '이미 승인 대기 중인 이메일입니다.',
      approved: '이미 승인 완료된 이메일입니다.',
      rejected: '이전에 거부된 이메일입니다. 관리자에게 문의하세요.',
    };
    return { exists: true, reason: msg[tr.status] ?? '이미 사용 중인 이메일입니다.' };
  }

  return { exists: false };
}

/** 관리자: 교사 이메일 직접 추가 (신청 없이) */
export async function directAddTeacherEmail(email) {
  const { error } = await supabase
    .from('teacher_emails')
    .insert({ email: normalizeEmail(email) });
  if (error) {
    if (error.code === '23505') throw new Error('이미 등록된 이메일입니다.');
    throw new Error(`교사 추가 실패: ${error.message}`);
  }
}

/** 교사 신청 제출 (anon/authenticated 모두 가능).
 *  homeroomGrade/homeroomClass: 담임/학년부장 구조화 정보(2026-07 추가). 회원가입 모달의
 *  "담임 학급" 선택 정보를 message(자유 텍스트)뿐 아니라 homeroom_grade/homeroom_class
 *  컬럼에도 함께 저장해, 로그인 후 탭별 데이터 제한(교육과정 탐색·과목 선택하기 학년 고정,
 *  과목 선택 현황 필터 고정 등)에 프로그램적으로 쓸 수 있게 한다. 자세한 규칙은
 *  deriveTeacherHomeroomKind() 참고. */
export async function submitTeacherRequest({
  email, name, subjectArea = '', authMethod = 'google', message = '',
  homeroomGrade = '', homeroomClass = '',
}) {
  const { error } = await supabase
    .from('teacher_requests')
    .insert({
      email: normalizeEmail(email),
      name: String(name).trim(),
      subject_area: String(subjectArea).trim(),
      auth_method: authMethod === 'email' ? 'email' : 'google',
      message: String(message).trim(),
      homeroom_grade: String(homeroomGrade || '').trim(),
      homeroom_class: String(homeroomClass || '').trim(),
    });
  if (error) {
    if (error.code === '23505') throw new Error('이미 신청된 이메일입니다.');
    throw new Error(`신청 실패: ${error.message}`);
  }
}

/** 담임/학년부장 판별 (2026-07 추가).
 *  - homeroomGrade가 비어 있으면 담임도 부장도 아닌 일반 교사 → null (탭별 데이터 제한 없음)
 *  - homeroomGrade가 있고 homeroomClass가 양의 정수면 → 'homeroom'(학급 담임,
 *    해당 학년+반으로 제한)
 *  - homeroomGrade가 있고 homeroomClass가 비어있거나 0이면 → 'head'(학년부장,
 *    해당 학년 전체로 제한, 반 제한 없음)
 *  accountsXlsxParser.js(계정 일괄 생성)·회원가입 모달과 동일한 규칙을 따른다. */
export function deriveTeacherHomeroomKind(homeroomGrade, homeroomClass) {
  const grade = String(homeroomGrade ?? '').trim();
  if (!grade) return null;
  const classNum = Number(homeroomClass);
  if (Number.isFinite(classNum) && classNum > 0) return 'homeroom';
  return 'head';
}

// ── 관리자 등록 (최초 1회 부트스트랩) ───────────────────────

/** admins 테이블에 등록된 관리자가 한 명도 없는지 확인 (anon 호출 가능) */
export async function checkAdminExists() {
  const { data, error } = await supabase.rpc('admin_exists');
  if (error) {
    // 함수가 아직 배포되지 않았거나 일시적 오류인 경우, 안전하게 "존재함"으로 간주해
    // 관리자 등록 화면이 잘못 노출되는 것을 막는다.
    console.error('admin_exists() 호출 실패:', error);
    return true;
  }
  return Boolean(data);
}

/** 최초 관리자 등록: admins 테이블이 비어 있을 때만 성공 (RLS가 강제) */
export async function registerFirstAdmin({ email, name = '', authMethod = 'email' }) {
  const { error } = await supabase
    .from('admins')
    .insert({
      email: normalizeEmail(email),
      name: String(name).trim(),
      auth_method: authMethod === 'google' ? 'google' : 'email',
    });
  if (error) {
    if (error.code === '23505') throw new Error('이미 관리자로 등록된 이메일입니다.');
    throw new Error(`관리자 등록 실패: ${error.message}`);
  }
}

// ── 학교 도메인 자동승인 설정 (관리자가 최초 등록 화면에서 결정) ──────

/** 관리자가 "학교 도메인 사용" 여부와 도메인 값을 app_settings에 저장 */
export async function saveSchoolDomainSettings({ enabled, domain = '', googleDomain = '' }) {
  const cleanDomain = normalizeEmail(domain);
  const cleanGoogleDomain = normalizeEmail(googleDomain) || cleanDomain;
  const rows = [
    { key: 'school_domain_enabled', value: enabled ? 'true' : 'false' },
    { key: 'school_domain', value: cleanDomain },
    { key: 'google_domain', value: cleanGoogleDomain },
    { key: 'id_suffix', value: String(CONFIG.ID_SUFFIX || 'ckfqhfl').trim().toLowerCase() || 'ckfqhfl' },
  ];
  const { error } = await supabase
    .from('app_settings')
    .upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(`학교 도메인 설정 저장 실패: ${error.message}`);
  sessionStorage.removeItem('cache_config');
}

/** 서버(DB) 기준으로 해당 이메일이 학교 도메인 사용 설정에 부합하는지 확인.
 *  (app_settings 캐시가 아니라 RPC로 확인 — RLS 정책과 동일한 판정 기준을 보장) */
export async function isSchoolDomainEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return false;
  const { data, error } = await supabase.rpc('is_school_domain_email', { target_email: target });
  if (error) {
    console.error('is_school_domain_email() 호출 실패:', error);
    return false;
  }
  return Boolean(data);
}

/** 학교 도메인 일치 가입: 교사를 승인 절차 없이 즉시 teacher_emails에 등록.
 *  (RLS가 도메인 일치 + 본인 이메일인지 다시 한번 검증함) */
export async function directRegisterTeacher({ email, name = '', subjectArea = '', homeroomGrade = '', homeroomClass = '' }) {
  const target = normalizeEmail(email);
  const { error: insertError } = await supabase
    .from('teacher_emails')
    .insert({ email: target });
  if (insertError && insertError.code !== '23505') {
    throw new Error(`교사 자동승인 등록 실패: ${insertError.message}`);
  }
  let message = '';
  if (homeroomGrade && homeroomClass) message = `담임: ${homeroomGrade}학년 ${homeroomClass}반`;
  else if (homeroomGrade) message = `담임: ${homeroomGrade}학년`;
  const { error: reqError } = await supabase
    .from('teacher_requests')
    .insert({
      email: target,
      name: String(name).trim(),
      subject_area: String(subjectArea).trim(),
      auth_method: 'email',
      message,
      status: 'approved',
      reviewed_at: new Date().toISOString(),
    });
  if (reqError && reqError.code !== '23505') {
    console.error('teacher_requests 기록 실패(무시 가능):', reqError.message);
  }
}

/** 학교 도메인 일치 가입: 학생을 승인 절차 없이 즉시 student_emails에 등록. */
export async function directRegisterStudent({ email, name = '', grade = '', classNo = '', number = '' }) {
  const target = normalizeEmail(email);
  const { error: insertError } = await supabase
    .from('student_emails')
    .insert({ email: target });
  if (insertError && insertError.code !== '23505') {
    throw new Error(`학생 자동승인 등록 실패: ${insertError.message}`);
  }
  const { error: reqError } = await supabase
    .from('student_requests')
    .insert({
      email: target,
      name: String(name).trim(),
      grade: String(grade || '').trim(),
      class_no: String(classNo || '').trim(),
      number: String(number || '').trim(),
      auth_method: 'email',
      status: 'approved',
      reviewed_at: new Date().toISOString(),
    });
  if (reqError && reqError.code !== '23505') {
    console.error('student_requests 기록 실패(무시 가능):', reqError.message);
  }
}

// ── 학생 가입 신청 / 승인 관련 (관리자 전용) ─────────────────

/** 학생 신청 목록 조회 (관리자만 접근 가능) */
export async function fetchStudentRequests() {
  const { data, error } = await supabase
    .from('student_requests')
    .select('id,email,name,grade,class_no,number,message,status,created_at,reviewed_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`학생 신청 목록 조회 실패: ${error.message}`);
  return data || [];
}

/** 학생 신청 제출 (anon/authenticated 모두 가능) */
export async function submitStudentRequest({ email, name, grade, classNo, number, authMethod = 'email', message = '' }) {
  const { error } = await supabase
    .from('student_requests')
    .insert({
      email: normalizeEmail(email),
      name: String(name).trim(),
      grade: String(grade || '').trim(),
      class_no: String(classNo || '').trim(),
      number: String(number || '').trim(),
      auth_method: authMethod === 'google' ? 'google' : 'email',
      message: String(message).trim(),
    });
  if (error) {
    if (error.code === '23505') throw new Error('이미 신청된 이메일입니다.');
    throw new Error(`신청 실패: ${error.message}`);
  }
}

/** 학생 신청 승인: student_emails 추가 + 신청 상태 업데이트 */
export async function approveStudentRequest(requestId, email) {
  const { error: insertError } = await supabase
    .from('student_emails')
    .insert({ email: normalizeEmail(email) });
  if (insertError && insertError.code !== '23505') {
    throw new Error(`학생 이메일 등록 실패: ${insertError.message}`);
  }
  const { error: updateError } = await supabase
    .from('student_requests')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('id', requestId);
  if (updateError) throw new Error(`신청 상태 업데이트 실패: ${updateError.message}`);
}

/** 학생 신청 거부 */
export async function rejectStudentRequest(requestId) {
  const { error } = await supabase
    .from('student_requests')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
    .eq('id', requestId);
  if (error) throw new Error(`신청 거부 실패: ${error.message}`);
}

/** 학생 로그인 권한 해제 (student_emails 허용목록에서 제거. student_selections 데이터는 유지) */
export async function removeStudentEmail(email) {
  const { error } = await supabase
    .from('student_emails')
    .delete()
    .eq('email', normalizeEmail(email));
  if (error) throw new Error(`학생 권한 해제 실패: ${error.message}`);
}

/** 학생 이메일 중복 확인 (신청 전 사전 검사) */
export async function checkStudentEmailExists(email) {
  const target = normalizeEmail(email);
  if (!target) return { exists: false };

  const { data: se } = await supabase
    .from('student_emails')
    .select('email')
    .eq('email', target)
    .maybeSingle();
  if (se) return { exists: true, reason: '이미 학생으로 등록된 이메일입니다.' };

  const { data: sr } = await supabase
    .from('student_requests')
    .select('status')
    .eq('email', target)
    .maybeSingle();
  if (sr) {
    const msg = {
      pending:  '이미 승인 대기 중인 이메일입니다.',
      approved: '이미 승인 완료된 이메일입니다.',
      rejected: '이전에 거부된 이메일입니다. 관리자에게 문의하세요.',
    };
    return { exists: true, reason: msg[sr.status] ?? '이미 사용 중인 이메일입니다.' };
  }

  return { exists: false };
}

// ── 마이페이지 (교사 본인 정보 수정, 2026-07 추가) ─────────────────
//
// 교사는 student_selections 같은 별도 "본인 정보" 테이블이 없고, 이름·담당 교과가
// 가입 신청 때 만들어진 teacher_requests 행에 그대로 저장되어 있다(관리자 "회원 관리"
// 탭도 이 테이블을 그대로 읽어 표시함). 그래서 마이페이지에서도 같은 테이블을 그대로
// 읽고/쓴다 — 별도 "teachers" 테이블을 새로 만들지 않음.

/** 로그인한 교사 본인의 이름/담당 교과 조회 (마이페이지 표시용).
 *  RLS의 teacher_requests_self_read 정책으로 본인 이메일 행만 조회 가능. */
export async function fetchMyTeacherProfile(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;
  try {
    const { data, error } = await supabase
      .from('teacher_requests')
      .select('name,subject_area,homeroom_grade,homeroom_class')
      .eq('email', targetEmail)
      .maybeSingle();
    if (error || !data) return null;
    return {
      name: data.name || '',
      subjectArea: data.subject_area || '',
      // 담임/학년부장 구조화 정보(2026-07 추가) — 탭별 데이터 제한(app.js)에 사용.
      // 마이페이지 화면 자체는 이 두 값을 표시/수정하지 않는다(관리자만 편집 가능한 값).
      homeroomGrade: data.homeroom_grade || '',
      homeroomClass: data.homeroom_class || '',
    };
  } catch {
    return null;
  }
}

/** 로그인한 교사 본인의 이름/담당 교과 수정 (마이페이지).
 *  ⚠ adminUpdateStudentPortalUrl()과 같은 이유로 update 후 count가 0이면(= teacher_requests에
 *  아직 본인 행이 없는 경우 — "계정 일괄 생성"으로만 만들어졌거나 그 밖의 드문 경로) insert로
 *  대체한다. RLS: teacher_requests_self_update 정책이 필요하며,
 *  신규 배포는 supabase/schema.sql 전체 실행으로 이 정책을 적용한다. */
export async function updateMyTeacherProfile(email, { name, subjectArea }) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');
  const cleanName = String(name || '').trim();
  const cleanSubjectArea = String(subjectArea || '').trim();

  const { error, count } = await supabase
    .from('teacher_requests')
    .update({ name: cleanName, subject_area: cleanSubjectArea }, { count: 'exact' })
    .eq('email', targetEmail);
  if (error) throw new Error(`정보 저장 실패: ${error.message}`);

  if (!count) {
    const { error: insError } = await supabase
      .from('teacher_requests')
      .insert({
        email: targetEmail,
        name: cleanName,
        subject_area: cleanSubjectArea,
        auth_method: 'email',
        status: 'approved',
        reviewed_at: new Date().toISOString(),
      });
    if (insError) throw new Error(`정보 저장 실패: ${insError.message}`);
  }
}

/** 본인의 승인된 학생 신청 내역 조회 (최초 로그인 시 학년·반·번호 자동 채움용) */
export async function fetchOwnApprovedStudentRequest(email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const { data, error } = await supabase
    .from('student_requests')
    .select('name,grade,class_no,number,status')
    .eq('email', target)
    .eq('status', 'approved')
    .maybeSingle();
  if (error || !data) return null;
  return {
    name: data.name || '',
    grade: data.grade || '',
    classNo: data.class_no || '',
    number: data.number || '',
  };
}

// ── 계정 일괄 생성 (관리자 전용, 서버리스 함수 경유) ────────────────────
//
// ⚠ 왜 여기서 직접 supabase.auth.signUp()을 쓰지 않는가: signUp()은 Supabase 기본
//   이메일 공급자 기준 시간당 2건(커스텀 SMTP 시 30건)으로 제한되어 수백 명 규모의
//   일괄 생성에는 쓸 수 없다. api/bulk-create-accounts.js가 service_role 키로
//   Supabase Admin API를 호출해 이 제한을 우회한다(자세한 설명은 그 파일 상단 주석 참고).
//
// accounts: accountsXlsxParser.js가 만든 { role, id, password, name, grade, classNo,
//   number, subjectArea, message, portalUrl } 배열. 서버 쪽 BATCH_LIMIT(50)보다 큰 배열은
//   batchSize 단위로 나눠 여러 번 호출한다(기본 20 — 각 호출이 Vercel 함수 실행 시간
//   제한 안에 끝나도록 여유를 둔 값).
//
// onProgress(processedCount, total, lastBatchResults): 배치가 끝날 때마다 호출되어
//   진행 상황 UI 갱신에 쓰인다.
//
// 반환값: 모든 배치의 결과를 이어붙인 { id, status, message } 배열. 네트워크 오류 등
// 배치 자체가 실패해도(throw 없이) 그 배치의 각 행을 status:'error'로 채워 계속
// 진행한다 — 일부 배치 실패로 전체 작업이 중단되지 않게 하기 위함.
export async function bulkCreateAccounts(accounts, { batchSize = 20, onProgress } = {}) {
  if (!Array.isArray(accounts) || !accounts.length) return [];

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error('로그인 세션을 확인할 수 없습니다. 새로고침 후 다시 로그인해 주세요.');
  }

  const allResults = [];
  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);
    let batchResults;
    try {
      const resp = await fetch('/api/bulk-create-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          accounts: batch.map(a => ({
            role: a.role,
            id: a.id,
            password: a.password,
            name: a.name,
            grade: a.grade,
            classNo: a.classNo,
            number: a.number,
            subjectArea: a.subjectArea,
            message: a.message,
            homeroomGrade: a.homeroomGrade,
            homeroomClass: a.homeroomClass,
            portalUrl: a.portalUrl,
          })),
        }),
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok) {
        throw new Error(payload?.error || `서버 오류 (HTTP ${resp.status})`);
      }
      batchResults = payload?.results || [];
    } catch (err) {
      batchResults = batch.map(a => ({ id: a.id, status: 'error', message: err.message || '알 수 없는 오류' }));
    }
    allResults.push(...batchResults);
    onProgress?.(allResults.length, accounts.length, batchResults);
  }

  return allResults;
}

// ── 관리자: 개별 계정 비밀번호 재설정 (서버리스 함수 경유, 2026-08 추가) ──────────
//
// ⚠ auth.js의 updateMyPassword()는 본인 세션만 바꿀 수 있어 관리자가 다른 학생/교사의
//   비밀번호를 대신 바꾸는 데는 쓸 수 없다. api/admin-reset-password.js가 service_role
//   키로 Supabase Admin API를 호출해 처리한다(자세한 설명은 그 파일 상단 주석 참고).
//   "회원 관리" 탭의 "학생 회원 관리"/"교사 계정 관리" 표의 "수정" 모달에서 새 비밀번호를
//   입력했을 때만 호출된다(비워두면 비밀번호는 그대로 유지).
export async function adminResetPassword(email, newPassword) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) throw new Error('이메일 정보가 없습니다.');
  const cleanPassword = String(newPassword || '');
  if (cleanPassword.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다.');

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (sessionError || !accessToken) {
    throw new Error('로그인 세션을 확인할 수 없습니다. 새로고침 후 다시 로그인해 주세요.');
  }

  const resp = await fetch('/api/admin-reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, targetEmail, newPassword: cleanPassword }),
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(payload?.error || `서버 오류 (HTTP ${resp.status})`);
  }
}
