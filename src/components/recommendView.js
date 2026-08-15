// ─────────────────────────────────────────
//  components/recommendView.js  —  대학별 추천 카드 / 계열·학과 예시 카드
// ─────────────────────────────────────────
import {
  escapeHtml,
  isCourseOpened,
  getCourseMatches,
  areaLabels,
  areaClass,
  normalize,
} from '../utils/normalize.js';

function subjectTag(name, tone = '') {
  const opened = isCourseOpened(name);
  const cls = opened && tone ? tone : '';
  return `<span class="tag ${cls}">${escapeHtml(name)}</span>`;
}

// ── 필터 상태 ─────────────────────────────
export const filterState = {
  search: '',
  region: new Set(),
  area: new Set(),
  university: new Set(),
  series: new Set(),
  department: new Set(),
  // 계열별 대표 모집단위 반영과목 매트릭스 표 전용(위 series/department와는 별개 —
  // 대학 반영과목 표·예시 모드와 카탈로그 구조가 달라 값 집합이 다를 수 있음)
  matrixSeries: new Set(),
  matrixDepartment: new Set(),
  sort: 'name',
};

// "권역-지역" 형식 문자열을 {region, area}로 분리 (예: "수도권-서울" → {region:"수도권", area:"서울"})
function splitRegionArea(value) {
  const text = String(value || '').trim();
  if (!text) return { region: '', area: '' };
  const idx = text.indexOf('-');
  if (idx === -1) return { region: text, area: '' };
  return { region: text.slice(0, idx).trim(), area: text.slice(idx + 1).trim() };
}

const UNSPECIFIED_SEMESTER = '학기 미지정';

const SEMESTER_ORDER = [
  '1학년 1학기', '1학년 2학기',
  '2학년 1학기', '2학년 2학기',
  '3학년 1학기', '3학년 2학기',
  UNSPECIFIED_SEMESTER,
];

const AREA_ORDER = [
  'korean', 'math', 'english', 'social', 'science',
  'info', 'home', 'language', 'liberal', 'arts', 'pe', 'etc',
];

const AREA_LABELS = {
  ...areaLabels,
  pe: '체육',
  etc: '기타',
};

const AREA_ALIASES = [
  ['기술·가정', 'home'], ['기술가정', 'home'], ['제2외국어', 'language'],
  ['국어', 'korean'], ['수학', 'math'], ['영어', 'english'],
  ['사회', 'social'], ['과학', 'science'], ['정보', 'info'],
  ['한문', 'language'], ['교양', 'liberal'],
  ['예술', 'arts'], ['미술', 'arts'], ['음악', 'arts'],
  ['체육', 'pe'],
];

const BROAD_SUBJECT_KEYS = new Set([
  '국어', '수학', '영어', '사회', '과학', '정보',
  '기술·가정', '기술가정', '기술·가정/정보', '기술가정정보',
  '제2외국어', '한문',
  '교양', '예술', '미술', '음악', '체육',
  '전 과목', '전 교과',
].map(normalize));

const DESIGNATED_SUBJECT_KEYS = new Set([
  '공통국어1', '공통국어2', '공통수학1', '공통수학2',
  '공통영어1', '공통영어2', '통합사회1', '통합사회2',
  '통합과학1', '통합과학2', '과학탐구실험1', '과학탐구실험2',
  '한국사1', '한국사2', '음악/미술', '미술/음악',
  '체육1', '체육2', '체육3', '체육4', '체육5', '체육6',
  '화법과 언어', '독서와 작문', '문학',
  '대수', '미적분Ⅰ', '영어Ⅰ',
].map(normalize));

// ── 필터 간 연계(캐스케이딩) ────────────────
// 특정 필터(key)의 "선택 가능한 옵션" 목록은 그 필터 자신을 제외한 나머지 모든 필터
// 조건으로 좁힌 카탈로그에서 뽑아낸다. 예) 대학을 고르면 계열·학과 드롭다운은 그
// 대학에 실제로 존재하는 값만 보이고, 거꾸로 계열을 고르면 대학·학과 드롭다운도 그
// 계열에 해당하는 값만 보인다 — 양방향으로 서로 좁혀지므로 어느 필터를 먼저 만져도
// 자연스럽게 연동된다.
function filterCatalogExcept(catalog, excludeKeys) {
  const exclude = new Set(excludeKeys);
  const query = filterState.search.replace(/\s/g, '').toLowerCase();
  return catalog.filter(item => {
    const { region, area } = splitRegionArea(item.regionArea);
    if (!exclude.has('region') && filterState.region.size && !filterState.region.has(region)) return false;
    if (!exclude.has('area') && filterState.area.size && !filterState.area.has(area)) return false;
    if (!exclude.has('university') && filterState.university.size && !filterState.university.has(item.university)) return false;
    if (!exclude.has('series') && filterState.series.size && !filterState.series.has(item.series)) return false;
    if (!exclude.has('department') && filterState.department.size && !filterState.department.has(item.department)) return false;
    if (query) {
      const text = [item.university, item.regionArea, item.series, item.department,
        ...item.core, ...item.recommended, ...item.reflected, item.note
      ].join('').replace(/\s/g, '').toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  });
}

// 예시 모드(계열·학과별 선택과목 예시)용 — series/department만 연계.
function filterExamplesExcept(examples, excludeKeys) {
  const exclude = new Set(excludeKeys);
  const query = filterState.search.replace(/\s/g, '').toLowerCase();
  return examples.filter(item => {
    if (!exclude.has('series') && filterState.series.size && !filterState.series.has(item.series)) return false;
    if (!exclude.has('department') && filterState.department.size && !filterState.department.has(item.department)) return false;
    if (query) {
      const text = [
        item.series,
        item.department,
        ...(item.similarDepartments || []),
        ...(item.subjects || []),
      ].join('').replace(/\s/g, '').toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  });
}

// ── 필터 옵션 렌더링 ──────────────────────
export function renderFilterOptions(catalog, { mode = 'recommend' } = {}) {
  const isExampleMode = mode === 'example';

  // 계열/학과 드롭다운(예시 모드 전용 상단 툴바)
  const toolbar = document.getElementById('multiFilterGroups');
  if (toolbar) toolbar.hidden = !isExampleMode;
  // 권역/지역/대학/계열/학과 드롭다운(비교 표 헤더 + 그 미러인 상단 툴바) — 예시 모드에서는 숨김.
  // 실제 표시 여부(매트릭스 모드 등)는 app.js의 updateExploreChrome()이 추가로 제어한다.
  const compareToolbar = document.getElementById('compareFilterGroups');
  if (compareToolbar) compareToolbar.hidden = isExampleMode;

  if (isExampleMode) {
    const seriesCatalog = filterExamplesExcept(catalog, ['series']);
    const departmentCatalog = filterExamplesExcept(catalog, ['department']);
    renderMultiFilter('exampleSeriesOptions', 'exampleSeriesSummary', 'series',
      [...new Set(seriesCatalog.map(i => i.series).filter(Boolean))].sort(), seriesCatalog);
    renderMultiFilter('exampleDepartmentOptions', 'exampleDepartmentSummary', 'department',
      [...new Set(departmentCatalog.map(i => i.department).filter(Boolean))].sort(), departmentCatalog);
    return;
  }

  // 각 필터마다 "자기 자신만 뺀" 나머지 조건으로 좁힌 카탈로그에서 옵션을 뽑아 서로
  // 연계되도록 한다(region/area는 item.regionArea에서 파생되는 값이라 카운트용으로
  // {region}/{area} 형태로 매핑해 둔다 — renderMultiFilter가 i[key]로 값을 비교하기 때문).
  const regionCatalog = filterCatalogExcept(catalog, ['region'])
    .map(i => ({ region: splitRegionArea(i.regionArea).region }));
  const areaCatalog = filterCatalogExcept(catalog, ['area'])
    .map(i => ({ area: splitRegionArea(i.regionArea).area }));
  const universityCatalog = filterCatalogExcept(catalog, ['university']);
  const seriesCatalog = filterCatalogExcept(catalog, ['series']);
  const departmentCatalog = filterCatalogExcept(catalog, ['department']);

  const regionOpts = [...new Set(regionCatalog.map(i => i.region).filter(Boolean))].sort();
  const areaOpts = [...new Set(areaCatalog.map(i => i.area).filter(Boolean))].sort();
  const universityOpts = [...new Set(universityCatalog.map(i => i.university).filter(Boolean))].sort();
  const seriesOpts = [...new Set(seriesCatalog.map(i => i.series).filter(Boolean))].sort();
  const departmentOpts = [...new Set(departmentCatalog.map(i => i.department).filter(Boolean))].sort();

  // 표 헤더 드롭다운(원본)
  renderMultiFilter('regionOptions', 'regionSummary', 'region', regionOpts, regionCatalog);
  renderMultiFilter('areaOptions', 'areaSummary', 'area', areaOpts, areaCatalog);
  renderMultiFilter('universityOptions', 'universitySummary', 'university', universityOpts, universityCatalog);
  renderMultiFilter('seriesOptions', 'seriesSummary', 'series', seriesOpts, seriesCatalog);
  renderMultiFilter('departmentOptions', 'departmentSummary', 'department', departmentOpts, departmentCatalog);

  // 상단 툴바 드롭다운(미러) — 같은 filterState를 공유하므로 둘 중 어느 쪽에서 체크박스를
  // 바꿔도 이 함수가 다시 호출될 때 양쪽 모두 같은 선택 상태로 다시 그려진다.
  renderMultiFilter('topRegionOptions', 'topRegionSummary', 'region', regionOpts, regionCatalog);
  renderMultiFilter('topAreaOptions', 'topAreaSummary', 'area', areaOpts, areaCatalog);
  renderMultiFilter('topUniversityOptions', 'topUniversitySummary', 'university', universityOpts, universityCatalog);
  renderMultiFilter('topSeriesOptions', 'topSeriesSummary', 'series', seriesOpts, seriesCatalog);
  renderMultiFilter('topDepartmentOptions', 'topDepartmentSummary', 'department', departmentOpts, departmentCatalog);
}

function renderMultiFilter(optionsId, summaryId, key, values, catalog) {
  const container = document.getElementById(optionsId);
  if (!container) return;

  container.innerHTML = values.map(val => {
    const count = catalog.filter(i => i[key] === val).length;
    const checked = filterState[key].has(val);
    return `
      <label class="filter-option">
        <input type="checkbox" data-filter-key="${key}" value="${escapeHtml(val)}" ${checked ? 'checked' : ''}>
        <div class="filter-option-text">
          <div class="filter-option-name">${escapeHtml(val)}</div>
          <div class="filter-option-count">${count}개</div>
        </div>
      </label>
    `;
  }).join('');

  updateFilterSummary(summaryId, key);
}

function updateFilterSummary(summaryId, key) {
  const el = document.getElementById(summaryId);
  if (!el) return;
  const sel = filterState[key];
  el.textContent = sel.size === 0 ? '전체' : [...sel].join(', ');
}

// ── 필터 적용 ─────────────────────────────
export function getFilteredCatalog(catalog) {
  const query = filterState.search.replace(/\s/g, '').toLowerCase();
  return catalog.filter(item => {
    const { region, area } = splitRegionArea(item.regionArea);
    if (filterState.region.size && !filterState.region.has(region)) return false;
    if (filterState.area.size && !filterState.area.has(area)) return false;
    if (filterState.university.size && !filterState.university.has(item.university)) return false;
    if (filterState.series.size && !filterState.series.has(item.series)) return false;
    if (filterState.department.size && !filterState.department.has(item.department)) return false;
    if (query) {
      const text = [item.university, item.regionArea, item.series, item.department,
        ...item.core, ...item.recommended, ...item.reflected, item.note
      ].join('').replace(/\s/g, '').toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (filterState.sort === 'core') return b.core.length - a.core.length;
    if (filterState.sort === 'match') {
      const openedA = [...a.core, ...a.recommended, ...a.reflected].filter(isCourseOpened).length;
      const openedB = [...b.core, ...b.recommended, ...b.reflected].filter(isCourseOpened).length;
      return openedB - openedA;
    }
    return (a.university + a.series + a.department).localeCompare(
      b.university + b.series + b.department, 'ko');
  });
}

export function getFilteredExamples(examples) {
  const query = filterState.search.replace(/\s/g, '').toLowerCase();
  return examples.filter(item => {
    if (filterState.series.size && !filterState.series.has(item.series)) return false;
    if (filterState.department.size && !filterState.department.has(item.department)) return false;
    if (query) {
      const text = [
        item.series,
        item.department,
        ...(item.similarDepartments || []),
        ...(item.subjects || []),
      ].join('').replace(/\s/g, '').toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  }).sort((a, b) =>
    (a.series + a.department).localeCompare(b.series + b.department, 'ko')
  );
}

// ── 헤더 드롭다운 필터 마크업 ──────────────
// rowspan: 원본 엑셀처럼 헤더를 2행으로 구성할 때(반영과목 위에 핵심/권장과목이 오는 구조)
// 필터 열들은 두 헤더 행에 걸쳐 1개 셀로 보이도록 rowspan="2"를 준다.
function thFilter(label, optionsId, summaryId, rowspan) {
  return `
    <th class="th-filter"${rowspan ? ` rowspan="${rowspan}"` : ''}>
      <details class="multi-filter table-filter">
        <summary>
          <span class="multi-filter-label">${escapeHtml(label)}</span>
          <span class="filter-summary" id="${summaryId}">전체</span>
        </summary>
        <div class="multi-filter-options" id="${optionsId}"></div>
      </details>
    </th>
  `;
}

// ── 대학 반영과목 표(테이블) 뼈대 렌더링 ───
// example 모드 전환 시 #recommendGrid 내용이 통째로 교체되므로, recommend 모드로
// 돌아올 때마다(=activeExploreMode 전환 시) 헤더(드롭다운 필터 포함)를 다시 만들어야 함.
export function renderRecommendTableShell() {
  const grid = document.getElementById('recommendGrid');
  if (!grid) return;

  grid.classList.remove('subject-example-grid');
  grid.classList.add('recommend-table-mode');
  grid.innerHTML = `
    <div class="recommend-table-wrap">
      <table class="recommend-table">
        <colgroup>
          <col style="width:6%">
          <col style="width:6%">
          <col style="width:12%">
          <col style="width:7%">
          <col style="width:15%">
          <col style="width:13%">
          <col style="width:13%">
          <col style="width:28%">
        </colgroup>
        <thead>
          <!-- 원본 엑셀 헤더(3행: 대분류 "반영과목"이 핵심·권장과목 두 열을 합쳐 위에 있고,
               4행: 핵심과목/권장과목 세부 라벨) 구조를 그대로 반영한 2행 헤더 -->
          <tr>
            ${thFilter('권역', 'regionOptions', 'regionSummary', 2)}
            ${thFilter('지역', 'areaOptions', 'areaSummary', 2)}
            ${thFilter('대학명', 'universityOptions', 'universitySummary', 2)}
            ${thFilter('계열', 'seriesOptions', 'seriesSummary', 2)}
            ${thFilter('학과', 'departmentOptions', 'departmentSummary', 2)}
            <th colspan="2">반영과목</th>
            <th rowspan="2">비고</th>
          </tr>
          <tr>
            <th>핵심과목</th>
            <th>권장과목</th>
          </tr>
        </thead>
        <tbody id="recommendTableBody"></tbody>
      </table>
    </div>
  `;
}

// ── 대학 반영과목 표(테이블) 본문 렌더링 ───
export function renderRecommendations(items) {
  const stats = document.getElementById('recommendStats');
  let body = document.getElementById('recommendTableBody');
  if (!body) {
    // 안전망: shell이 아직 없으면 새로 만든 뒤 다시 찾음
    renderRecommendTableShell();
    body = document.getElementById('recommendTableBody');
  }
  if (!body) return;

  if (stats) stats.textContent = `${items.length}개 대학 반영과목 행 표시 중`;

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">조건에 맞는 계열·모집단위 반영과목이 없습니다.</td></tr>`;
    return;
  }

  body.innerHTML = items.map(item => {
    const { region, area } = splitRegionArea(item.regionArea);
    // ⚠ 비고(note)는 원본 엑셀(university-recommendations.xlsx)의 "비고" 열 값을 그대로
    // 보여준다. 과거에는 학교 미개설 과목을 감지해 "추가 확인: ..." 문구를 자동으로
    // 덧붙였으나, 원본 데이터에 없는 문구를 표에 추가하는 것이므로 제거함(2026-06).
    const noteText = item.note || '';

    // 원본 엑셀에서 핵심·권장과목 셀이 합쳐져 "반영과목"으로만 작성된 대학·학과는
    // core/recommended가 모두 비어 있고 reflected만 채워짐 — 이 경우 핵심·권장 두 칸을
    // colspan으로 합쳐 반영과목을 그대로 보여줌(원본 구조 그대로 유지).
    const isMergedRow = !item.core.length && !item.recommended.length && item.reflected.length > 0;

    const subjectCellsHtml = isMergedRow
      ? `<td class="cell-subjects" colspan="2">
          <span class="subject-cloud">${item.reflected.map(s => subjectTag(s, isCourseOpened(s) ? 'reflected' : '')).join('')}</span>
        </td>`
      : `
        <td class="cell-subjects">${item.core.length
          ? `<span class="subject-cloud">${item.core.map(s => subjectTag(s, isCourseOpened(s) ? 'core' : '')).join('')}</span>`
          : '<span class="example-muted">-</span>'}</td>
        <td class="cell-subjects">${(item.recommended.length || item.reflected.length)
          ? `<span class="subject-cloud">
              ${item.recommended.map(s => subjectTag(s, isCourseOpened(s) ? 'recommended' : '')).join('')}
              ${item.reflected.map(s => subjectTag(s, isCourseOpened(s) ? 'reflected' : '')).join('')}
            </span>`
          : '<span class="example-muted">-</span>'}</td>
      `;

    return `
      <tr>
        <td>${escapeHtml(region || '-')}</td>
        <td>${escapeHtml(area || '-')}</td>
        <td class="cell-university">${escapeHtml(item.university || '-')}</td>
        <td>${escapeHtml(item.series || '-')}</td>
        <td class="cell-department">${escapeHtml(item.department || '-')}</td>
        ${subjectCellsHtml}
        <td class="cell-note">${noteText ? `<span class="match-note">${escapeHtml(noteText)}</span>` : '<span class="example-muted">-</span>'}</td>
      </tr>
    `;
  }).join('');
}

// ── 계열별 대표 모집단위 반영과목 매트릭스 표 ──────────
// university-recommendations-series.xlsx "반영과목" 시트 원본 그대로: 16개 대표
// (계열,모집단위)별 대학마다 어떤 세부 과목을 반영(요구)하는지 보여주는 표.
// 원본 헤더(3행 대분류: 국어/수학[5]/영어/사회[4]/과학[4]/기타, 4행 세부 과목명)를
// colspan으로 재현한다.
const SERIES_MATRIX_GROUPS = [
  { label: '국어', subjects: ['국어'] },
  { label: '수학', subjects: ['대수', '확률과 통계', '미적분Ⅰ', '미적분Ⅱ', '기하'] },
  { label: '영어', subjects: ['영어'] },
  { label: '사회', subjects: ['일반사회', '역사', '지리', '윤리'] },
  { label: '과학', subjects: ['물리학', '화학', '생명과학', '지구과학'] },
  { label: '기타', subjects: ['기타'] },
];
const SERIES_MATRIX_LEAF_SUBJECTS = SERIES_MATRIX_GROUPS.flatMap(g => g.subjects);

// 매트릭스 표의 계열/모집단위 필터도 대학 반영과목 표와 같은 방식으로 서로 캐스케이딩된다 —
// 계열을 고르면 모집단위 드롭다운이 그 계열에 실제 존재하는 값만 보이고, 반대도 마찬가지.
function filterMatrixCatalogExcept(catalog, excludeKeys) {
  const exclude = new Set(excludeKeys);
  return catalog.filter(item => {
    if (!exclude.has('matrixSeries') && filterState.matrixSeries.size &&
      !filterState.matrixSeries.has(item.series)) return false;
    if (!exclude.has('matrixDepartment') && filterState.matrixDepartment.size &&
      !filterState.matrixDepartment.has(item.department)) return false;
    return true;
  });
}

// ── 매트릭스 표 헤더 드롭다운(계열/모집단위) 옵션 렌더링 ──
export function renderSeriesMatrixFilterOptions(catalog) {
  const seriesCatalog = filterMatrixCatalogExcept(catalog, ['matrixSeries']);
  const departmentCatalog = filterMatrixCatalogExcept(catalog, ['matrixDepartment']);

  const seriesOpts = [...new Set(seriesCatalog.map(i => i.series).filter(Boolean))].sort();
  const departmentOpts = [...new Set(departmentCatalog.map(i => i.department).filter(Boolean))].sort();

  renderMultiFilter('matrixSeriesOptions', 'matrixSeriesSummary', 'matrixSeries', seriesOpts, seriesCatalog);
  renderMultiFilter('matrixDepartmentOptions', 'matrixDepartmentSummary', 'matrixDepartment', departmentOpts, departmentCatalog);
}

// ── 매트릭스 표 필터 적용 ──
export function getFilteredSeriesMatrix(catalog) {
  return filterMatrixCatalogExcept(catalog, []);
}

export function renderSeriesMatrixTableShell() {
  const grid = document.getElementById('recommendGrid');
  if (!grid) return;

  grid.classList.remove('subject-example-grid');
  grid.classList.add('recommend-table-mode');
  grid.innerHTML = `
    <div class="recommend-table-wrap">
      <table class="recommend-table series-matrix-table">
        <colgroup>
          <col class="col-series">
          <col class="col-department">
          <col class="col-university">
          ${SERIES_MATRIX_LEAF_SUBJECTS.map(() => '<col class="col-subject">').join('')}
        </colgroup>
        <thead>
          <tr>
            ${thFilter('계열', 'matrixSeriesOptions', 'matrixSeriesSummary', 2)}
            ${thFilter('모집단위', 'matrixDepartmentOptions', 'matrixDepartmentSummary', 2)}
            <th rowspan="2">대학명</th>
            ${SERIES_MATRIX_GROUPS.map(g => `<th colspan="${g.subjects.length}">${escapeHtml(g.label)}</th>`).join('')}
          </tr>
          <tr>
            ${SERIES_MATRIX_LEAF_SUBJECTS.map(s => `<th>${escapeHtml(s)}</th>`).join('')}
          </tr>
        </thead>
        <tbody id="seriesMatrixTableBody"></tbody>
      </table>
    </div>
  `;
}

export function renderSeriesMatrix(items) {
  const stats = document.getElementById('recommendStats');
  let body = document.getElementById('seriesMatrixTableBody');
  if (!body) {
    renderSeriesMatrixTableShell();
    body = document.getElementById('seriesMatrixTableBody');
  }
  if (!body) return;

  if (stats) stats.textContent = `${items.length}개 대학 반영과목 행 표시 중`;

  if (!items.length) {
    body.innerHTML = `<tr><td colspan="${3 + SERIES_MATRIX_LEAF_SUBJECTS.length}" class="empty">조건에 맞는 계열별 대표 모집단위 반영과목이 없습니다.</td></tr>`;
    return;
  }

  // 같은 (계열,모집단위)가 연속된 행이면 첫 행에만 표시하고 rowspan으로 병합 —
  // 원본 엑셀에서 계열·모집단위가 그룹당 한 번만 라벨링된 모양을 그대로 재현.
  body.innerHTML = items.map((item, idx) => {
    const prev = items[idx - 1];
    const isSameGroup = prev && prev.series === item.series && prev.department === item.department;
    let groupRowspan = 0;
    if (!isSameGroup) {
      groupRowspan = 1;
      for (let j = idx + 1; j < items.length; j++) {
        if (items[j].series === item.series && items[j].department === item.department) groupRowspan++;
        else break;
      }
    }

    const requiredSet = new Set(item.requiredSubjects);
    const leafCellsHtml = SERIES_MATRIX_LEAF_SUBJECTS.map(subject => {
      const required = requiredSet.has(subject);
      return `<td class="cell-matrix-subject ${required ? 'is-required' : ''}">${required ? '○' : '<span class="example-muted">-</span>'}</td>`;
    }).join('');

    return `
      <tr>
        ${isSameGroup ? '' : `<th rowspan="${groupRowspan}">${escapeHtml(item.series || '-')}</th>`}
        ${isSameGroup ? '' : `<th rowspan="${groupRowspan}">${escapeHtml(item.department || '-')}</th>`}
        <td class="cell-university">${escapeHtml(item.university || '-')}</td>
        ${leafCellsHtml}
      </tr>
    `;
  }).join('');
}

// ── 계열·학과별 선택과목 예시 카드 렌더링 ─────────────
export function renderSubjectExamples(items) {
  const grid = document.getElementById('recommendGrid');
  const stats = document.getElementById('recommendStats');
  if (!grid) return;

  grid.classList.add('subject-example-grid');
  grid.classList.remove('recommend-table-mode');
  if (stats) stats.textContent = `${items.length}개 계열·학과 예시 표시 중`;

  if (!items.length) {
    grid.innerHTML = `<div class="empty">조건에 맞는 계열·학과 선택과목 예시가 없습니다.</div>`;
    return;
  }

  grid.innerHTML = items.map(item => {
    const similar = item.similarDepartments || [];
    const subjects = item.subjects || [];

    return `
      <article class="recommend-card subject-example-card">
        <div class="recommend-header">
          <div class="recommend-title">
            <h3>${escapeHtml(item.department || '학과 미지정')}</h3>
            <div class="division-line">계열: ${escapeHtml(item.series || '-')}</div>
          </div>
          <div class="department-name">
            <span class="dept-series">${escapeHtml(item.series || '-')}</span>
            <span class="dept-dept">${escapeHtml(item.department || '-')}</span>
          </div>
        </div>
        <div class="recommend-body">
          <div class="info-row">
            <span class="label">유사학과</span>
            <span class="value subject-cloud">
              ${similar.length
                ? similar.map(name => `<span class="tag">${escapeHtml(name)}</span>`).join('')
                : '<span class="example-muted">-</span>'}
            </span>
          </div>
          <div class="info-row example-table-row">
            <span class="label">선택과목</span>
            <span class="value">${renderExampleCourseTable(subjects)}</span>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderExampleCourseTable(subjects) {
  const table = groupExampleSubjects(subjects);
  if (!table.rows.length && !table.unspecified.length) {
    return '<div class="example-empty-table">선택과목 예시가 없습니다.</div>';
  }

  return `
    ${table.rows.length ? `
      <div class="example-table-wrap">
        <table class="example-course-table">
          <thead>
            <tr>
              <th>교과군</th>
              ${table.semesters.map(semester => `<th>${escapeHtml(semester)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${table.rows.map(row => `
              <tr>
                <th>
                  <span class="tag ${escapeHtml(areaClass[row.area] || '')}">
                    ${escapeHtml(AREA_LABELS[row.area] || row.area)}
                  </span>
                </th>
                ${table.semesters.map(semester => `
                  <td>${renderExampleSubjectCell(row.subjectsBySemester.get(semester) || [])}</td>
                `).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<div class="example-empty-table">학기별 선택과목 예시가 없습니다.</div>'}
    ${renderUnspecifiedSubjects(table.unspecified)}
  `;
}

function renderExampleSubjectCell(subjects) {
  if (!subjects.length) {
    return '<span class="example-empty-cell">-</span>';
  }
  return `
    <span class="example-course-cloud">
      ${subjects.map(name =>
        `<span class="example-course-chip">${escapeHtml(name)}</span>`
      ).join('')}
    </span>
  `;
}

function renderUnspecifiedSubjects(groups) {
  if (!groups.length) return '';

  return `
    <div class="example-unspecified">
      <div class="example-unspecified-title">미편성 과목</div>
      ${groups.map(group => `
        <div class="example-unspecified-row">
          <span class="tag ${escapeHtml(areaClass[group.area] || '')}">
            ${escapeHtml(AREA_LABELS[group.area] || group.area)}
          </span>
          ${renderExampleSubjectCell(group.subjects)}
        </div>
      `).join('')}
    </div>
  `;
}

function groupExampleSubjects(subjects) {
  const semesters = new Map();
  const seen = new Set();

  for (const subject of subjects) {
    const raw = String(subject || '').trim();
    if (!raw) continue;
    if (BROAD_SUBJECT_KEYS.has(normalize(raw))) continue;

    const matches = getCourseMatches(raw);
    if (matches.length) {
      matches.forEach(match => {
        addExampleSubject(semesters, seen, match.semester || UNSPECIFIED_SEMESTER, match.area || 'etc', match.name || raw);
      });
      continue;
    }

    const hinted = parseSubjectHint(raw);
    if (DESIGNATED_SUBJECT_KEYS.has(normalize(hinted.name)) &&
      hinted.semester === UNSPECIFIED_SEMESTER) continue;
    addExampleSubject(semesters, seen, hinted.semester, hinted.area, hinted.name);
  }

  const semesterList = [...semesters.keys()]
    .filter(semester => semester !== UNSPECIFIED_SEMESTER)
    .sort((a, b) => sortByOrder(a, b, SEMESTER_ORDER));
  const areaSet = new Set();

  semesterList.forEach(semester => {
    const areaMap = semesters.get(semester);
    areaMap.forEach((_, area) => areaSet.add(area));
  });

  const rows = [...areaSet]
    .sort((a, b) => sortByOrder(a, b, AREA_ORDER))
    .map(area => ({
      area,
      subjectsBySemester: new Map(
        semesterList.map(semester => [
          semester,
          semesters.get(semester)?.get(area) || [],
        ])
      ),
    }));

  const unspecifiedMap = semesters.get(UNSPECIFIED_SEMESTER);
  const unspecified = unspecifiedMap
    ? [...unspecifiedMap.entries()]
      .sort(([a], [b]) => sortByOrder(a, b, AREA_ORDER))
      .map(([area, subjectList]) => ({ area, subjects: subjectList }))
    : [];

  return { semesters: semesterList, rows, unspecified };
}

function addExampleSubject(semesters, seen, semester, area, subject) {
  const key = `${semester}::${area}::${subject}`;
  if (seen.has(key)) return;
  seen.add(key);

  if (!semesters.has(semester)) semesters.set(semester, new Map());
  const areaMap = semesters.get(semester);
  if (!areaMap.has(area)) areaMap.set(area, []);
  areaMap.get(area).push(subject);
}

function parseSubjectHint(raw) {
  const semester = parseSemester(raw) || UNSPECIFIED_SEMESTER;
  const withoutSemester = raw
    .replace(/^[123]\s*학년\s*[12]\s*학기\s*[-:|/]?\s*/, '')
    .replace(/^[123]\s*[-./]\s*[12]\s*[-:|/]?\s*/, '')
    .trim();
  const areaHint = parseAreaPrefix(withoutSemester);
  const name = areaHint.name || withoutSemester || raw;
  const area = areaHint.area || inferAreaFromSubjectName(name) || 'etc';

  return { semester, area, name: name || raw };
}

function parseSemester(text) {
  const korean = text.match(/([123])\s*학년\s*([12])\s*학기/);
  if (korean) return `${korean[1]}학년 ${korean[2]}학기`;

  const short = text.match(/(^|\s)([123])\s*[-./]\s*([12])(\s|$)/);
  if (short) return `${short[2]}학년 ${short[3]}학기`;

  return '';
}

function parseAreaPrefix(text) {
  const match = AREA_ALIASES
    .map(([label, area]) => ({ label, area }))
    .find(({ label }) => {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`^${escaped}\\s*[:|/\\-–]\\s*\\S+`).test(text);
    });

  if (!match) return { area: '', name: text.trim() };

  const escaped = match.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    area: match.area,
    name: text.replace(new RegExp(`^${escaped}\\s*[:|/\\-–]\\s*`), '').trim(),
  };
}

function inferAreaFromSubjectName(text) {
  const key = normalize(text);
  if (!key) return '';
  if (key.startsWith(normalize('영어')) || key.includes(normalize('영미'))) return 'english';
  if (key.includes(normalize('문학')) || key.includes(normalize('독서')) ||
    key.includes(normalize('화법')) || key.includes(normalize('작문')) ||
    key.includes(normalize('언어생활')) || key.includes(normalize('매체'))) return 'korean';
  if (key.includes(normalize('수학')) || key.includes(normalize('미적분')) ||
    key.includes(normalize('확률')) || key.includes(normalize('통계')) ||
    key.includes(normalize('기하'))) return 'math';
  if (key.includes(normalize('물리')) || key.includes(normalize('화학')) ||
    key.includes(normalize('생명')) || key.includes(normalize('지구')) ||
    key.includes(normalize('과학'))) return 'science';
  if (key.includes(normalize('사회')) || key.includes(normalize('역사')) ||
    key.includes(normalize('경제')) || key.includes(normalize('윤리')) ||
    key.includes(normalize('지리'))) return 'social';
  if (key.includes(normalize('정보')) || key.includes(normalize('소프트웨어')) ||
    key.includes(normalize('인공지능'))) return 'info';
  return '';
}

function sortByOrder(a, b, order) {
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);
  const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
  const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
  if (safeA !== safeB) return safeA - safeB;
  return String(a).localeCompare(String(b), 'ko');
}

// ── 필터 이벤트 바인딩 ────────────────────
export function bindFilterEvents(onUpdate) {
  document.getElementById('searchInput')?.addEventListener('input', e => {
    filterState.search = e.target.value;
    onUpdate();
  });

  document.getElementById('sortSelect')?.addEventListener('change', e => {
    filterState.sort = e.target.value;
    onUpdate();
  });

  // 헤더 드롭다운 필터는 모드에 따라 #recommendGrid(표 헤더) 또는 #multiFilterGroups(예시 모드
  // 툴바) 안에서 동적으로 다시 그려지므로 document에 위임
  document.addEventListener('change', e => {
    const input = e.target.closest('input[type="checkbox"][data-filter-key]');
    if (!input) return;
    const key = input.dataset.filterKey;
    if (!filterState[key]) return;
    input.checked ? filterState[key].add(input.value) : filterState[key].delete(input.value);
    const summaryEl = input.closest('.multi-filter')?.querySelector('.filter-summary');
    if (summaryEl) {
      summaryEl.textContent = filterState[key].size === 0 ? '전체' : [...filterState[key]].join(', ');
    }
    onUpdate();
  });

  document.getElementById('resetFiltersBtn')?.addEventListener('click', () => {
    filterState.region.clear();
    filterState.area.clear();
    filterState.university.clear();
    filterState.series.clear();
    filterState.department.clear();
    filterState.matrixSeries.clear();
    filterState.matrixDepartment.clear();
    filterState.search = '';
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    document.querySelectorAll('#recommendGrid input[type="checkbox"][data-filter-key], #multiFilterGroups input[type="checkbox"][data-filter-key]')
      .forEach(input => { input.checked = false; });
    document.querySelectorAll('.filter-summary').forEach(el => { el.textContent = '전체'; });
    onUpdate();
  });

  // 드롭다운 외부 클릭 시 닫기
  document.addEventListener('click', e => {
    if (!e.target.closest('.multi-filter')) {
      document.querySelectorAll('.multi-filter[open]').forEach(el => el.removeAttribute('open'));
    }
  });
}
