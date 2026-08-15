// ─────────────────────────────────────────
//  components/semesterView.js  —  학기별 과목 카드
// ─────────────────────────────────────────
import { escapeHtml, areaLabels, areaClass, isCourseOpened, getCourseMatches, normalize } from '../utils/normalize.js';
import { openCourseModal } from './courseModal.js';

const semesterFilterState = { activeFilter: '전체' };

// 상단 필터(계열/학과/대학 조합)에 따라 강조할 과목명 집합 — renderSemesters()가 두 번째
// 인자 없이 다시 호출될 때(학기 필터 버튼 클릭 등)도 마지막 강조 상태를 유지하기 위해
// 모듈 변수에 보관한다.
let lastHighlightSubjects = new Set();

// 교육과정-반영과목 탭에서는 1학년 1·2학기 공통 과목은 보여줄 필요가 없어 숨김
// (내 교육과정 보기 등 다른 화면에는 영향 없음 — 이 컴포넌트의 렌더링 단계에서만 제외)
const HIDDEN_SEMESTERS = new Set(['1학년 1학기', '1학년 2학기']);

// ── 학기 필터 버튼 렌더링 ─────────────────
export function renderSemesterFilterButtons(semesterCourses) {
  const container = document.getElementById('semesterFilterButtons');
  if (!container) return;

  const visibleCourses = semesterCourses.filter(s => !HIDDEN_SEMESTERS.has(s.semester));
  const allAreas = ['전체', ...new Set(
    visibleCourses.flatMap(s => s.courses.map(c => areaLabels[c.area] || c.area))
  )];

  container.innerHTML = allAreas.map(area => `
    <button class="semester-filter-btn${area === semesterFilterState.activeFilter ? ' active' : ''}"
      data-area="${escapeHtml(area)}" type="button">${escapeHtml(area)}</button>
  `).join('');

  container.addEventListener('click', e => {
    const btn = e.target.closest('.semester-filter-btn');
    if (!btn) return;
    semesterFilterState.activeFilter = btn.dataset.area;
    container.querySelectorAll('.semester-filter-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.area === semesterFilterState.activeFilter)
    );
    renderSemesters(semesterCourses);
  });
}


// ── 학기 카드 렌더링 ──────────────────────
// highlightSubjects: 대학 반영과목(핵심·권장과목) 중 상단 필터(계열/학과/대학 조합)에 해당하는
// 원본 과목(교과) 명칭 문자열 집합. 생략하면 마지막으로 전달된 값을 그대로 유지한다.
export function renderSemesters(semesterCourses, highlightSubjects) {
  const grid = document.getElementById('semesterGrid');
  if (!grid) return;

  if (highlightSubjects) lastHighlightSubjects = highlightSubjects;
  const highlightNames = new Set();
  lastHighlightSubjects.forEach(subject => {
    getCourseMatches(subject).forEach(c => highlightNames.add(normalize(c.name)));
  });

  const activeFilter = semesterFilterState.activeFilter;

  // 과목명 클릭 이벤트 (이벤트 위임)
  grid.onclick = e => {
    const link = e.target.closest('.course-name-link');
    if (!link) return;
    openCourseModal(link.dataset.course, link.dataset.area);
  };

  grid.innerHTML = semesterCourses.filter(group => !HIDDEN_SEMESTERS.has(group.semester)).map(group => {
    const allCourses = [...group.courses];

    // 필터링
    const filtered = allCourses.filter(course => {
      const areaLabel = areaLabels[course.area] || course.area;
      const areaMatch = activeFilter === '전체' || areaLabel === activeFilter;
      return areaMatch;
    });

    if (filtered.length === 0) return '';

    // 그룹별 분류
    const groupMap = new Map();
    filtered.forEach(course => {
      const g = course.group || '필수';
      if (!groupMap.has(g)) groupMap.set(g, []);
      groupMap.get(g).push(course);
    });

    const totalCredits = group.courses.reduce((sum, c) => sum + (c.credit || 0), 0);
    const openedCount = group.courses.filter(c => isCourseOpened(c.name)).length;

    return `
      <div class="semester-card">
        <header>
          <h3>${escapeHtml(group.semester)}</h3>
          <div class="semester-meta">
            <span class="mini-stat">총 ${totalCredits}학점</span>
            <span class="mini-stat">개설 ${openedCount}/${group.courses.length}</span>
          </div>
        </header>
        <div class="semester-body">
          ${[...groupMap.entries()].map(([groupName, courses]) => `
            <div class="course-table-group">
              <div class="course-table-group-title">
                <span>${escapeHtml(groupName)}</span>
                <span style="font-size:0.74rem;color:var(--muted);">${
                  courses[0]?.pick ? `${courses[0].pick}과목 선택` : ''
                }</span>
              </div>
              <div class="course-table-wrap">
                <table class="course-table">
                  <thead>
                    <tr><th>영역</th><th>과목명</th><th>유형</th><th>학점</th></tr>
                  </thead>
                  <tbody>
                    ${courses.map(course => {
                      const matches = getCourseMatches(course.name);
                      const heat = matches.length > 3 ? 'heat-high' : matches.length > 1 ? 'heat-mid' : matches.length > 0 ? 'heat-low' : '';
                      const isHighlighted = highlightNames.has(normalize(course.name));
                      return `
                        <tr class="heat-row ${heat}">
                          <td><span class="tag ${areaClass[course.area] || ''}">${
                            escapeHtml(areaLabels[course.area] || course.area)
                          }</span></td>
                          <td><span class="course-name-link${isHighlighted ? ' course-name-highlighted' : ''}" data-course="${escapeHtml(course.name)}" data-area="${escapeHtml(areaLabels[course.area] || '')}">${escapeHtml(course.name)}</span></td>
                          <td>${escapeHtml(course.type || '')}</td>
                          <td>${course.credit || '-'}</td>
                        </tr>
                      `;
                    }).join('')}
                  </tbody>
                </table>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}
