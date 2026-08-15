// ─────────────────────────────────────────
//  components/myplanView.js  —  내 교육과정 수형도
// ─────────────────────────────────────────
import { escapeHtml, areaLabels } from '../utils/normalize.js';
import { openCourseModal } from './courseModal.js';

const SEMESTERS = [
  '1학년 1학기', '1학년 2학기',
  '2학년 1학기', '2학년 2학기',
  '3학년 1학기', '3학년 2학기'
];

// ⚠ 과거에는 1학년 공통 과목을 여기에 하드코딩했으나, 코호트(입학년도)별 3개년 교육과정
// 파이프라인 도입(semester_courses.cohort_year) 이후 1학년 과목도 DB에서 받아온다.
// (group_name === '지정'이면 buildAllCoursesMap에서 자동으로 선택됨 처리)

const AREA_ORDER = ['korean', 'math', 'english', 'social', 'science', 'home', 'info', 'language', 'liberal', 'arts', 'pe'];

const AREA_LABEL = {
  korean: '국어', math: '수학', english: '영어',
  social: '사회', science: '과학', info: '정보',
  language: '제2외국어', liberal: '교양', arts: '예술', pe:'체육'
};

export function renderMyplan(semesterCourses, selectedMap) {
  const el = document.getElementById('myplanContent');
  if (!el) return;

  // 전체 과목 + 선택 여부 플래그
  const allCoursesMap = buildAllCoursesMap(semesterCourses, selectedMap);

  // 과목이 존재하는 교과군만 표시
  const usedAreas = AREA_ORDER.filter(area =>
    SEMESTERS.some(sem => allCoursesMap[sem]?.[area]?.length > 0)
  );

  // 교과군별 학점 합계
  const areaCredits = calcAreaCredits(allCoursesMap, usedAreas);
  const semesterCredits = calcSemesterCredits(allCoursesMap);

  // 요약 통계
  const totalSelected = Object.keys(selectedMap).length;
  const totalCredit = Object.values(areaCredits).reduce((sum, credit) => sum + credit, 0);

  // 범례
  const legend = `
    <div class="myplan-legend">
      ${['지정','일반','진로','융합'].map(t => `
        <div class="myplan-legend-item">
          <div class="myplan-legend-dot type-${t}"></div>
          ${t}
        </div>
      `).join('')}
      <div class="myplan-legend-item">
        <div class="myplan-legend-dot unselected"></div>
        미선택
      </div>
    </div>
  `;

  // 수형도 그리드
  const headerRow = `
    <div class="myplan-col-head area-head">교과군</div>
    <div class="myplan-col-head stat-head">비율</div>
    <div class="myplan-col-head stat-head">학점</div>
    ${SEMESTERS.map(sem => `<div class="myplan-col-head">${escapeHtml(sem)}</div>`).join('')}
  `;

  const areaRows = usedAreas.map(area => {
    const credit = areaCredits[area] || 0;
    const ratio = totalCredit > 0 ? (credit / totalCredit * 100).toFixed(1) : '0.0';

    const cells = SEMESTERS.map(sem => {
      const courses = allCoursesMap[sem]?.[area] || [];
      if (!courses.length) {
        return `<div class="myplan-cell"><div class="myplan-empty">—</div></div>`;
      }
      return `
        <div class="myplan-cell">
          ${courses.map(c => `
            <div class="myplan-course type-${escapeHtml(c.type)}${c.selected ? '' : ' unselected'}"
              data-course="${escapeHtml(c.name)}"
              data-area="${escapeHtml(areaLabels[area] || '')}">
              <span class="myplan-course-name">${escapeHtml(c.name)}</span>
              ${c.credit ? `<span class="myplan-credit">${c.credit}학점</span>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    }).join('');

    return `
      <div class="myplan-area-label">${escapeHtml(AREA_LABEL[area] || areaLabels[area] || area)}</div>
      <div class="myplan-stat-cell"><span class="myplan-stat-pct">${ratio}%</span></div>
      <div class="myplan-stat-cell"><span class="myplan-stat-num">${credit}</span></div>
      ${cells}
    `;
  }).join('');

  const semesterTotalRow = `
    <div class="myplan-area-label myplan-total-label">이수 학점 합계</div>
    <div class="myplan-stat-cell myplan-total-cell"><span class="myplan-stat-pct">—</span></div>
    <div class="myplan-stat-cell myplan-total-cell"><span class="myplan-stat-num">${totalCredit}</span></div>
    ${SEMESTERS.map(sem => `
      <div class="myplan-cell myplan-total-cell">
        <span class="myplan-semester-total">${semesterCredits[sem] || 0}학점</span>
      </div>
    `).join('')}
  `;

  // 요약 카드
  const summary = `
    <div class="myplan-summary">
      <div class="myplan-summary-card">
        <div class="myplan-summary-num">${totalSelected}</div>
        <div class="myplan-summary-label">선택 과목 수</div>
      </div>
      <div class="myplan-summary-card">
        <div class="myplan-summary-num">${totalCredit}</div>
        <div class="myplan-summary-label">총 이수 학점</div>
      </div>
      <div class="myplan-summary-card">
        <div class="myplan-summary-num">${usedAreas.length}</div>
        <div class="myplan-summary-label">이수 교과군</div>
      </div>
      <div class="myplan-summary-card">
        <div class="myplan-summary-num">${SEMESTERS.length}</div>
        <div class="myplan-summary-label">학기</div>
      </div>
    </div>
  `;

  el.innerHTML = `
    ${legend}
    <div class="myplan-grid">
      ${headerRow}
      ${areaRows}
      ${semesterTotalRow}
    </div>
    ${summary}
  `;

  // 과목 클릭 → 모달
  el.addEventListener('click', e => {
    const box = e.target.closest('.myplan-course');
    if (!box) return;
    openCourseModal(box.dataset.course, box.dataset.area);
  });
}

// ── 전체 과목을 학기별·교과군별로 정리 (selected 플래그 포함) ──
function buildAllCoursesMap(semesterCourses, selectedMap) {
  const map = {};

  // 전체 학년(1~3학년) 과목 — DB(semester_courses)에서 코호트 필터링된 데이터.
  // group === '지정'인 과목(1학년 공통과목 포함)은 selectedMap과 무관하게 항상 선택됨 처리.
  for (const group of semesterCourses) {
    const sem = group.semester;
    if (!map[sem]) map[sem] = {};

    for (const c of group.courses) {
      const isSelected = c.group === '지정' ||
        Object.keys(selectedMap).some(key => key === `${sem}::${c.group}::${c.name}`);
      const area = c.area || 'liberal';
      if (!map[sem][area]) map[sem][area] = [];
      map[sem][area].push({ ...c, selected: isSelected });
    }
  }

  return map;
}

function calcAreaCredits(allCoursesMap, usedAreas) {
  const result = {};
  for (const area of usedAreas) {
    let sum = 0;
    for (const sem of SEMESTERS) {
      for (const c of allCoursesMap[sem]?.[area] || []) {
        if (c.selected) sum += c.credit || 0;
      }
    }
    result[area] = sum;
  }
  return result;
}

function calcSemesterCredits(allCoursesMap) {
  const result = {};
  for (const sem of SEMESTERS) {
    let sum = 0;
    for (const courses of Object.values(allCoursesMap[sem] || {})) {
      for (const c of courses) {
        if (c.selected) sum += c.credit || 0;
      }
    }
    result[sem] = sum;
  }
  return result;
}
