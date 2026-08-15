// ─────────────────────────────────────────
//  components/selectionView.js  —  학생 과목 선택 모드
// ─────────────────────────────────────────
import { escapeHtml, areaLabels, areaClass, getCourseMatches, normalize } from '../utils/normalize.js';
import { openCourseModal } from './courseModal.js';
import { saveStudentSelection, fetchStudentSelection } from '../sheets.js';
import { getUser, requestAccessToken, CONFIG } from '../auth.js';

// 과목 선택하기 탭에서는 1학년 1·2학기 공통 과목(이미 지정 상태로 자동 처리됨)을
// 체크리스트로 보여줄 필요가 없어 숨김. updateSummary/updateVerification 등 학점 계산은
// 이 화면 렌더링과 별개로 전체 semesterCourses를 그대로 사용하므로 영향 없음.
const HIDDEN_SELECTION_SEMESTERS = new Set(['1학년 1학기', '1학년 2학기']);

// 선택 상태: { 'semester::courseName': true }
let selectedMap = {};
let semesterCourses = [];
let universityCatalog = [];
let subjectExamples = [];
let isDirty = false;

// 진로 설정 필터 상태(교육과정-반영과목 탭의 비교 표 헤더 드롭다운과 동일한 방식의
// 다중 선택 — 대학명/계열/학과 세 가지). recommendView.js의 filterState와는 별개의
// 객체이며, 체크박스 속성도 data-career-key로 구분해 두 화면의 전역 change 리스너가
// 서로 간섭하지 않도록 한다.
const careerFilterState = {
  university: new Set(),
  series: new Set(),
  department: new Set(),
};

// 반영과목 팝업(플로팅 패널, #analysisCard) 열림 상태. 진로 설정을 바꿔 목록 내용이
// 갱신되더라도, 사용자가 닫아 둔 팝업이 저절로 다시 뜨지 않도록 열림 여부를 따로
// 기억해 둔다(2026-08: 사이드바 카드 → 드래그 가능한 팝업으로 전환).
let _analysisPanelOpen = false;

// 관리자 모드 상태
let _isAdminMode = false;
let _allStudents = [];
let _adminTargetEmail = null;
let _adminTargetName = null;
let _onAdminFetch = null;
let _onAdminSave = null;

// ── 초기화 ───────────────────────────────
export async function initSelectionView(semesters, catalog, examples = [], opts = {}) {
  semesterCourses = semesters;
  universityCatalog = catalog;
  subjectExamples = examples;

  // 관리자 옵션
  _isAdminMode = !!opts.isAdmin;
  _onAdminFetch = opts.onAdminFetch || null;
  _onAdminSave = opts.onAdminSave || null;

  // 학생 목록 업데이트 (재호출 시에도 갱신)
  if (_isAdminMode && opts.allStudents) {
    _allStudents = opts.allStudents;
  }

  // 관리자: 학생 선택기 패널 렌더링
  if (_isAdminMode) {
    renderAdminStudentPicker();
    renderCareerFilterOptions();
    renderSelectionGrid();
    updateSummary();
    if (!_selectionEventsBound) {
      bindSelectionEvents();
      _selectionEventsBound = true;
    }
    return; // 관리자는 자동 로드 없음
  }

  // UI 즉시 렌더링 (토큰 대기 없이)
  renderCareerFilterOptions();
  renderSelectionGrid();
  updateSummary();
  if (!_selectionEventsBound) {
    bindSelectionEvents();
    _selectionEventsBound = true;
  }

  // 저장된 선택 내역을 백그라운드에서 복원
  const user = getUser();
  if (user) {
    try {
      const token = await requestAccessToken();
      if (token) {
        const saved = await fetchStudentSelection(user.email);
        if (saved && saved.selectedMap && Object.keys(saved.selectedMap).length > 0) {
          selectedMap = saved.selectedMap;
          renderSelectionGrid();
          updateSummary();
        }
      }
    } catch (e) {
      console.warn('선택 내역 복원 실패:', e);
    }
  }
}

let _selectionEventsBound = false;

// ── 관리자: 학생 선택기 패널 ─────────────
// 학년·학급·번호 드롭다운 필터 + 이름 검색으로 대상 학생을 좁혀 "불러오기"를 누르면
// 조건에 맞는 학생을 조회한다(2026-08 개편 — 기존에는 전체 학생이 나열된 단일
// <select> 하나뿐이라 학생 수가 많아지면 찾기 어려웠음). 조건에 맞는 학생이 정확히
// 1명이면 바로 불러오고, 2명 이상(예: 동명이인)이면 팝업으로 목록을 보여주고
// 그중 한 명을 선택하게 한다.
function renderAdminStudentPicker() {
  const tabSelect = document.getElementById('tabSelect');
  if (!tabSelect) return;

  // 이미 있으면 학년/학급/번호 드롭다운 옵션만 최신 학생 목록 기준으로 갱신
  // (검색 조건·상태 메시지는 그대로 유지).
  const existing = document.getElementById('adminStudentPickerPanel');
  if (existing) {
    _renderAdminPickerGradeOptions(existing);
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'adminStudentPickerPanel';
  panel.className = 'admin-picker-panel';
  panel.innerHTML = `
    <div class="admin-picker-inner">
      <span class="admin-picker-badge">관리자 모드</span>
      <span class="admin-picker-label">학생 과목 선택 조회/수정</span>
    </div>
    <div class="admin-picker-filter-bar">
      <label class="teacher-filter-field">
        <span>학년</span>
        <select id="apGradeFilter"></select>
      </label>
      <label class="teacher-filter-field">
        <span>학급</span>
        <select id="apClassFilter"></select>
      </label>
      <label class="teacher-filter-field">
        <span>번호</span>
        <select id="apNumberFilter"></select>
      </label>
      <label class="teacher-filter-field teacher-search-field">
        <span>이름</span>
        <input id="apNameSearch" type="search" placeholder="이름 검색">
      </label>
      <button id="apSearchBtn" class="admin-picker-btn" type="button">불러오기</button>
    </div>
    <span id="adminPickerStatus" class="admin-picker-status"></span>
  `;

  // selection-layout 바로 앞에 삽입
  const layout = tabSelect.querySelector('.selection-layout');
  if (layout) tabSelect.insertBefore(panel, layout);
  else tabSelect.prepend(panel);

  _renderAdminPickerGradeOptions(panel);

  const gradeSel  = panel.querySelector('#apGradeFilter');
  const classSel  = panel.querySelector('#apClassFilter');
  const nameInput = panel.querySelector('#apNameSearch');
  const searchBtn = panel.querySelector('#apSearchBtn');

  gradeSel.addEventListener('change', () => _renderAdminPickerClassOptions(panel));
  classSel.addEventListener('change', () => _renderAdminPickerNumberOptions(panel));
  searchBtn.addEventListener('click', () => _runAdminPickerSearch(panel));
  nameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); _runAdminPickerSearch(panel); }
  });
}

/** 학년·반처럼 숫자로 된 값은 문자열 정렬이 아닌 숫자 기준으로 정렬해야 "1,2,10" 순서가 유지된다. */
function _apUniqueNumericSorted(values) {
  return [...new Set(values)].sort((a, b) => Number(a) - Number(b));
}

function _renderAdminPickerGradeOptions(panel) {
  const gradeSel = panel.querySelector('#apGradeFilter');
  if (!gradeSel) return;
  const current = gradeSel.value;
  const grades = _apUniqueNumericSorted(_allStudents.map(s => s.grade).filter(Boolean));
  gradeSel.innerHTML = `<option value="">전체 학년</option>${grades.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}학년</option>`).join('')}`;
  if (grades.includes(current)) gradeSel.value = current;
  _renderAdminPickerClassOptions(panel);
}

function _renderAdminPickerClassOptions(panel) {
  const grade = panel.querySelector('#apGradeFilter')?.value || '';
  const classSel = panel.querySelector('#apClassFilter');
  if (!classSel) return;
  const current = classSel.value;
  const classes = _apUniqueNumericSorted(
    _allStudents.filter(s => !grade || s.grade === grade).map(s => s.classNo).filter(Boolean)
  );
  classSel.innerHTML = `<option value="">전체 학급</option>${classes.map(c => `<option value="${escapeHtml(c)}">${Number(c)}반</option>`).join('')}`;
  if (classes.includes(current)) classSel.value = current;
  _renderAdminPickerNumberOptions(panel);
}

function _renderAdminPickerNumberOptions(panel) {
  const grade = panel.querySelector('#apGradeFilter')?.value || '';
  const classNo = panel.querySelector('#apClassFilter')?.value || '';
  const numberSel = panel.querySelector('#apNumberFilter');
  if (!numberSel) return;
  const current = numberSel.value;
  const numbers = _apUniqueNumericSorted(
    _allStudents
      .filter(s => (!grade || s.grade === grade) && (!classNo || s.classNo === classNo))
      .map(s => s.number).filter(Boolean)
  );
  numberSel.innerHTML = `<option value="">전체 번호</option>${numbers.map(n => `<option value="${escapeHtml(n)}">${String(Number(n)).padStart(2, '0')}번</option>`).join('')}`;
  if (numbers.includes(current)) numberSel.value = current;
}

/** "1학년 2반 3번" 형식 라벨(이름 제외 — 목록에서 이름과 나란히 보여줄 때 사용). */
function _apFormatStudentInfo(s) {
  return [
    s.grade ? s.grade + '학년' : '',
    s.classNo ? Number(s.classNo) + '반' : '',
    s.number ? Number(s.number) + '번' : '',
  ].filter(Boolean).join(' ');
}

function _apSortStudents(list) {
  return [...list].sort((a, b) => {
    const g = Number(a.grade) - Number(b.grade);
    if (g) return g;
    const c = Number(a.classNo) - Number(b.classNo);
    if (c) return c;
    return Number(a.number) - Number(b.number);
  });
}

/** 드롭다운 필터(학년/학급/번호) + 이름 검색을 조합해 학생을 조회한다. */
function _runAdminPickerSearch(panel) {
  const grade   = panel.querySelector('#apGradeFilter')?.value || '';
  const classNo = panel.querySelector('#apClassFilter')?.value || '';
  const number  = panel.querySelector('#apNumberFilter')?.value || '';
  const nameQuery = normalize(panel.querySelector('#apNameSearch')?.value || '');
  const statusEl = panel.querySelector('#adminPickerStatus');

  if (!grade && !classNo && !number && !nameQuery) {
    statusEl.textContent = '학년·학급·번호 중 하나를 선택하거나 이름을 입력해 주세요.';
    statusEl.className = 'admin-picker-status error';
    return;
  }

  const matches = _allStudents.filter(s => {
    if (grade && s.grade !== grade) return false;
    if (classNo && s.classNo !== classNo) return false;
    if (number && s.number !== number) return false;
    if (nameQuery && !normalize(s.name || '').includes(nameQuery)) return false;
    return true;
  });

  if (matches.length === 0) {
    statusEl.textContent = '조건에 맞는 학생이 없습니다.';
    statusEl.className = 'admin-picker-status error';
    return;
  }

  if (matches.length === 1) {
    _loadAdminStudent(matches[0], panel);
    return;
  }

  // 조건에 맞는 학생이 2명 이상(예: 동명이인) → 팝업으로 목록을 보여주고 선택하게 한다.
  statusEl.textContent = `${matches.length}명이 검색되었습니다. 목록에서 학생을 선택하세요.`;
  statusEl.className = 'admin-picker-status';
  _showAdminPickerDuplicatePopup(matches, panel);
}

/** 검색 결과가 여러 명일 때 보여주는 선택 팝업(동명이인 등). */
function _showAdminPickerDuplicatePopup(matches, panel) {
  document.getElementById('adminPickerDupModal')?.remove();

  const sorted = _apSortStudents(matches);

  const modal = document.createElement('div');
  modal.id = 'adminPickerDupModal';
  modal.className = 'modal-overlay visible';
  modal.innerHTML = `
    <div class="modal-card admin-picker-dup-modal">
      <h2>학생 선택</h2>
      <p class="modal-desc">조건에 맞는 학생이 여러 명입니다. 조회/수정할 학생을 선택하세요.</p>
      <div class="mpicker-list-title">검색 결과 ${sorted.length}명</div>
      <div class="mpicker-multi-list">
        ${sorted.map(s => `
          <button class="mpicker-student" data-email="${escapeHtml(s.email)}" type="button">
            <span class="mpicker-student-info">${escapeHtml(_apFormatStudentInfo(s))}</span>
            <span class="mpicker-student-name">${escapeHtml(s.name || s.email)}</span>
          </button>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" id="apDupCloseBtn" type="button">닫기</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelector('#apDupCloseBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelectorAll('.mpicker-student').forEach(btn => {
    btn.addEventListener('click', () => {
      const rec = sorted.find(s => s.email === btn.dataset.email);
      modal.remove();
      if (rec) _loadAdminStudent(rec, panel);
    });
  });
}

/** 특정 학생의 선택과목 데이터를 불러와 과목 선택 그리드에 반영한다. */
async function _loadAdminStudent(rec, panel) {
  const statusEl = panel.querySelector('#adminPickerStatus');
  const email = rec.email;
  const name = rec.name || email;

  statusEl.textContent = '불러오는 중...';
  statusEl.className = 'admin-picker-status';

  try {
    let newMap = {};
    if (_onAdminFetch) {
      const data = await _onAdminFetch(email);
      newMap = (data && data.selectedMap) ? data.selectedMap : {};
    } else {
      newMap = rec.selectedMap ? { ...rec.selectedMap } : {};
    }

    selectedMap = newMap;
    _adminTargetEmail = email;
    _adminTargetName = name;

    renderSelectionGrid();
    updateSummary();
    setDirty(true);

    statusEl.textContent = `${name} 선택 데이터 로드 완료 ✓`;
    statusEl.className = 'admin-picker-status success';
  } catch (err) {
    statusEl.textContent = `불러오기 실패: ${err.message}`;
    statusEl.className = 'admin-picker-status error';
  }
}

// ── 학기별 선택 그리드 렌더링 ─────────────
function renderSelectionGrid() {
  const grid = document.getElementById('selSemesterGrid');
  if (!grid) return;

  grid.innerHTML = semesterCourses.filter(group => !HIDDEN_SELECTION_SEMESTERS.has(group.semester)).map(group => {
    const groupMap = new Map();
    group.courses.forEach(course => {
      if (!groupMap.has(course.group)) groupMap.set(course.group, []);
      groupMap.get(course.group).push(course);
    });

    const groupsHtml = [...groupMap.entries()]
      .sort(([aName, aCourses], [bName, bCourses]) => {
        const aRequired = isRequiredGroup(aName, aCourses);
        const bRequired = isRequiredGroup(bName, bCourses);
        if (aRequired !== bRequired) return aRequired ? -1 : 1;
        return 0;
      })
      .map(([groupName, courses]) => {
        const required = isRequiredGroup(groupName, courses);
        const pick = courses[0]?.pick || 0;
        const selectedCount = courses.filter(course =>
          isSelected(group.semester, course.group, course.name)
        ).length;
        const countClass = required
          ? ''
          : (selectedCount === pick ? 'valid' : selectedCount > pick ? 'over' : '');
        const groupTitle = required
          ? `${escapeHtml(groupName || '지정')} - ${courses.length}과목`
          : `${escapeHtml(groupName)} - ${pick}과목 선택`;
        const countHtml = required ? '' : `
            <span class="sel-group-count ${countClass}" id="count-${groupKey(group.semester, groupName)}">
              ${selectedCount}/${pick}
            </span>
          `;

        return `
          <div class="sel-group-block">
            <div class="sel-group-title">
              <span>${groupTitle}</span>
              ${countHtml}
            </div>
            <div class="sel-course-list">
              ${courses.map(course =>
                renderSelectionCourseItem(group.semester, groupName, course, required, pick)
              ).join('')}
            </div>
          </div>
        `;
      }).join('');

    return `
      <div class="sel-semester-card">
        <div class="sel-semester-header">
          <h3>${escapeHtml(group.semester)}</h3>
        </div>
        <div class="sel-semester-body">
          ${groupsHtml}
        </div>
      </div>
    `;
  }).join('');
}

function renderSelectionCourseItem(semester, groupName, course, required, pick) {
  const selected = isSelected(semester, course.group, course.name);
  const areaLabel = getDisplayAreaLabel(course.area);
  const areaTagClass = areaClass[course.area] ? ` ${areaClass[course.area]}` : '';

  if (required) {
    return `
      <div class="sel-course-item required">
        <input type="checkbox" class="sel-course-cb" checked disabled>
        <span class="sel-course-name course-name-link" data-course="${escapeHtml(course.name)}" data-area="${escapeHtml(areaLabel)}">${escapeHtml(course.name)}</span>
        <span class="sel-course-meta">
          <span class="tag${areaTagClass}">${escapeHtml(areaLabel)}</span>
          ${course.credit}학점
        </span>
      </div>
    `;
  }

  return `
    <label class="sel-course-item ${selected ? 'selected' : ''}"
      data-semester="${escapeHtml(semester)}"
      data-course="${escapeHtml(course.name)}"
      data-group="${escapeHtml(groupName)}"
      data-pick="${pick}">
      <input type="checkbox" class="sel-course-cb"
        ${selected ? 'checked' : ''}
        data-semester="${escapeHtml(semester)}"
        data-course="${escapeHtml(course.name)}"
        data-group="${escapeHtml(groupName)}"
        data-pick="${pick}">
      <span class="sel-course-name course-name-link" data-course="${escapeHtml(course.name)}" data-area="${escapeHtml(areaLabel)}">${escapeHtml(course.name)}</span>
      <span class="sel-course-meta">
        <span class="tag${areaTagClass}">${escapeHtml(areaLabel)}</span>
        ${course.credit}학점
      </span>
    </label>
  `;
}

// ── 이벤트 바인딩 ─────────────────────────
function bindSelectionEvents() {
  // 과목명 클릭 → 모달
  document.getElementById('selSemesterGrid')?.addEventListener('click', e => {
    const link = e.target.closest('.course-name-link');
    if (!link) return;
    openCourseModal(link.dataset.course, link.dataset.area);
  });

  // 과목 체크박스
  document.getElementById('selSemesterGrid')?.addEventListener('change', e => {
    const cb = e.target.closest('input.sel-course-cb[data-course]');
    if (!cb) return;

    const { semester, course, group, pick } = cb.dataset;
    const pickNum = Number(pick);

    if (cb.checked) {
      // pick 수 초과 방지
      const groupSelected = countGroupSelected(semester, group);
      if (groupSelected >= pickNum) {
        cb.checked = false;
        showPickWarning(semester, group, pickNum);
        return;
      }
      selectedMap[selKey(semester, group, course)] = true;
    } else {
      delete selectedMap[selKey(semester, group, course)];
    }

    // UI 즉시 반영
    const label = cb.closest('.sel-course-item');
    label?.classList.toggle('selected', cb.checked);
    updateGroupCount(semester, group, pickNum);
    updateSummary();
    setDirty(true);
  });

  // 저장 버튼
  document.getElementById('saveSelectionBtn')?.addEventListener('click', saveSelection);

  // 진로 설정 드롭다운(대학명/계열/학과 다중 선택) 체크박스 — recommendView.js의
  // data-filter-key 전역 리스너와 섞이지 않도록 별도의 data-career-key 속성을 사용한다.
  document.addEventListener('change', e => {
    const input = e.target.closest('input[type="checkbox"][data-career-key]');
    if (!input) return;
    const key = input.dataset.careerKey;
    if (!careerFilterState[key]) return;
    input.checked ? careerFilterState[key].add(input.value) : careerFilterState[key].delete(input.value);
    const summaryEl = input.closest('.multi-filter')?.querySelector('.filter-summary');
    if (summaryEl) {
      summaryEl.textContent = careerFilterState[key].size === 0 ? '전체' : [...careerFilterState[key]].join(', ');
    }
    updateSummary();
  });

  // 반영과목 팝업 열기/닫기(2026-08 추가) — 내용 자체는 updateAnalysis()가 항상
  // 최신으로 유지하므로, 여기서는 열림 상태(_analysisPanelOpen)와 analysis-hidden
  // 클래스만 토글한다.
  const openAnalysisBtn = document.getElementById('openAnalysisBtn');
  openAnalysisBtn?.addEventListener('click', () => {
    if (openAnalysisBtn.disabled) return;
    setAnalysisPanelOpen(!_analysisPanelOpen);
  });
  document.getElementById('analysisCloseBtn')?.addEventListener('click', () => {
    setAnalysisPanelOpen(false);
  });

  // 반영과목 팝업 드래그 이동
  bindAnalysisPanelDrag();
}

function setAnalysisPanelOpen(open) {
  const panel = document.getElementById('analysisCard');
  const btn = document.getElementById('openAnalysisBtn');
  _analysisPanelOpen = !!open;
  btn?.classList.toggle('active', _analysisPanelOpen);
  btn?.setAttribute('aria-expanded', _analysisPanelOpen ? 'true' : 'false');
  if (btn) btn.textContent = _analysisPanelOpen ? '반영과목 축소' : '반영과목 팝업 열기';
  panel?.classList.toggle('analysis-hidden', !_analysisPanelOpen);
}

// ── 반영과목 팝업 드래그 이동 ─────────────
// 헤더(#analysisFloatHeader)를 잡고 끌면 패널을 화면 어디로든 옮길 수 있다. pointer
// 이벤트를 써서 마우스·펜·터치를 모두 같은 코드로 처리한다. 처음 드래그를 시작할 때
// CSS의 top/right 고정값을 현재 위치 기준 left/top(px)으로 바꿔치기해서, 이후에는
// 순수하게 드래그한 만큼만 이동시킨다.
function bindAnalysisPanelDrag() {
  const panel = document.getElementById('analysisCard');
  const header = document.getElementById('analysisFloatHeader');
  if (!panel || !header) return;

  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  header.addEventListener('pointerdown', e => {
    if (e.target.closest('#analysisCloseBtn')) return; // 닫기 버튼 클릭은 드래그로 취급하지 않음
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';

    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    header.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  header.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // 패널이 화면 밖으로 완전히 사라지지 않도록 최소한의 여백만 남겨 둔다.
    const minLeft = -(panel.offsetWidth - 60);
    const maxLeft = window.innerWidth - 60;
    const maxTop = window.innerHeight - 40;
    panel.style.left = `${Math.min(Math.max(startLeft + dx, minLeft), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(startTop + dy, 0), maxTop)}px`;
  });

  const stopDrag = () => { dragging = false; };
  header.addEventListener('pointerup', stopDrag);
  header.addEventListener('pointercancel', stopDrag);
}

// ── 저장 ─────────────────────────────────
async function saveSelection() {
  const btn = document.getElementById('saveSelectionBtn');
  const status = document.getElementById('saveStatus');

  // ── 관리자 모드: 선택된 학생의 과목 저장 ──
  if (_isAdminMode) {
    if (!_adminTargetEmail) {
      status.textContent = '저장할 학생을 먼저 선택하세요.';
      status.className = 'save-status error';
      return;
    }
    btn.disabled = true;
    status.textContent = '저장 중...';
    status.className = 'save-status';
    try {
      if (_onAdminSave) {
        await _onAdminSave(_adminTargetEmail, { selectedMap });
      }
      status.textContent = `${_adminTargetName} 저장 완료 ✓`;
      status.className = 'save-status success';
      setDirty(false);
    } catch (err) {
      console.error('관리자 저장 실패:', err);
      status.textContent = `저장 실패: ${err.message}`;
      status.className = 'save-status error';
      btn.disabled = false;
    }
    return;
  }

  // ── 일반 학생 저장 ──
  const user = getUser();
  if (!user) return;

  btn.disabled = true;
  status.textContent = '권한 확인 중...';
  status.className = 'save-status';

  try {
    // 로그인 세션 확인
    const token = await requestAccessToken();
    if (!token) throw new Error('토큰 발급 실패');

    status.textContent = '저장 중...';
    await saveStudentSelection(user.email, user.name, selectedMap, token);

    // 저장 성공 후 기존 내역 복원 시도
    try {
      const saved = await fetchStudentSelection(user.email);
      if (saved && saved.selectedMap) {
        selectedMap = saved.selectedMap;
        renderSelectionGrid();
        updateSummary();
      }
    } catch (e) {
      console.warn('복원 실패:', e);
    }

    status.textContent = '저장 완료 ✓';
    status.className = 'save-status success';
    setDirty(false);
  } catch (err) {
    console.error('저장 실패:', err);
    status.textContent = '저장 실패. 다시 시도하세요.';
    status.className = 'save-status error';
    btn.disabled = false;
  }
}

// ── 선택 현황 요약 업데이트 ───────────────
function updateSummary() {
  const selected = Object.keys(selectedMap);
  const totalCount = selected.length;

  let totalCredit = 0;
  semesterCourses.forEach(group => {
    group.courses.forEach(c => {
      if (c.group === '지정' || c.type === '지정' || isSelected(group.semester, c.group, c.name)) {
        totalCredit += c.credit || 0;
      }
    });
    (group.requiredSubjects || []).forEach(() => { totalCredit += 4; });
  });

  document.getElementById('statTotalCount').textContent = totalCount;
  document.getElementById('statTotalCredit').textContent = totalCredit;

  updateCoreMatch();
  updateAnalysis();
  updateVerification(totalCredit);
}

// ── 검증 카드 업데이트 ─────────────────────
function updateVerification(totalCredit) {
  // 기초교과(국어·수학·영어) 이수 학점 합산
  let basicCredit = 0;
  semesterCourses.forEach(group => {
    group.courses.forEach(c => {
      if (['korean', 'math', 'english'].includes(c.area)) {
        if (c.group === '지정' || c.type === '지정' || isSelected(group.semester, c.group, c.name)) {
          basicCredit += c.credit || 0;
        }
      }
    });
  });

  // 허용 최대 학점: 기본 81학점, 교과 이수 174학점 초과 시 초과분의 50% 추가 허용
  const maxBasic = totalCredit > 174
    ? 81 + Math.floor((totalCredit - 174) / 2)
    : 81;
  const ok = basicCredit <= maxBasic;

  const icon   = document.getElementById('verifyBasicCreditIcon');
  const detail = document.getElementById('verifyBasicCreditDetail');
  if (icon) {
    icon.className = 'verify-icon ' + (ok ? 'ok' : 'fail');
    icon.textContent = ok ? '●' : '✕';
  }
  if (detail) detail.textContent = `${basicCredit}/${maxBasic}학점`;
}

function hasCareerFilter() {
  return !!(careerFilterState.university.size || careerFilterState.series.size || careerFilterState.department.size);
}

function updateCoreMatch() {
  const el = document.getElementById('statCoreMatch');
  if (!el) return;
  if (!hasCareerFilter()) { el.textContent = '계열/학과 선택 필요'; return; }

  const targets = getCareerTargets();
  if (!targets.length) { el.textContent = '-'; return; }

  const allCore = expandRecommendationSubjects(targets.flatMap(u => u.core));
  if (!allCore.length) { el.textContent = '-'; return; }

  const matched = allCore.filter(subject => subject.selected).length;
  el.textContent = `${matched}/${allCore.length}`;
}

// ── 진로 매칭 분석 ────────────────────────
function isSubjectSelected(subj) {
  const target = normalize(subj);
  if (!target) return false;

  const selectedNames = getSelectedSubjectNames();
  if (selectedNames.has(target)) return true;

  return getCourseMatches(subj).some(match =>
    selectedNames.has(normalize(match.name))
  );
}

// ── 반영과목(구 "진로 매칭 분석") ─────────
// 진로 설정(대학명/계열/학과 다중 선택)에 걸린 대학·계열·학과별로 반영과목(핵심·권장·반영)과
// 비고를 "대학|계열|학과 / 반영과목 / 비고" 형태로 약식 정리해서 보여준다.
function updateAnalysis() {
  const card = document.getElementById('analysisCard');
  const openBtn = document.getElementById('openAnalysisBtn');
  if (!card) return;

  const hasFilter = hasCareerFilter();
  if (openBtn) openBtn.disabled = !hasFilter;

  if (!hasFilter) {
    // 진로 설정이 모두 해제되면 보여줄 내용이 없으므로 팝업도 함께 닫는다.
    setAnalysisPanelOpen(false);
    return;
  }

  const targets = getCareerTargets();
  const rankList = document.getElementById('univRankList');
  if (rankList) {
    const analysis = buildUniversityCourseAnalysis(targets);
    rankList.innerHTML = !analysis.length
      ? '<div class="analysis-empty">조건에 맞는 대학별 반영과목 정보가 없습니다.</div>'
      : analysis.map(({ u, groups, note }) => `
          <div class="univ-missing-item">
            <div class="univ-missing-head">
              <div class="univ-missing-name">${escapeHtml([u.university, u.series, u.department].filter(Boolean).join(' | ') || '-')}</div>
            </div>
            <div class="univ-missing-row">
              <span class="univ-missing-label">반영과목</span>
              <span class="match-subject-list">
                ${groups.length
                  ? groups.map(group => `
                      <span class="reflected-group">
                        <span class="reflected-group-label">${escapeHtml(group.label)}</span>
                        ${group.subjects.map(renderSubjectStatusChip).join('')}
                      </span>
                    `).join('')
                  : '<span class="example-muted">-</span>'}
              </span>
            </div>
            <div class="univ-note">비고: ${note ? escapeHtml(note) : '-'}</div>
          </div>
        `).join('');
  }

  // 내용은 항상 최신으로 갱신하되, 실제로 보여줄지는 사용자가 열어 둔 상태(_analysisPanelOpen)를
  // 따른다 — 진로 설정을 바꿀 때마다 팝업이 저절로 열리지 않게 하기 위함.
  setAnalysisPanelOpen(_analysisPanelOpen);
}

// ── 유틸 ──────────────────────────────────
// 진로 설정 드롭다운(대학명/계열/학과) 옵션 렌더링 — 교육과정-반영과목 탭의 비교 표
// 헤더 드롭다운(recommendView.js의 renderMultiFilter)과 동일한 마크업/스타일을 쓰되,
// 별도의 careerFilterState/속성(data-career-key)을 사용해 두 화면이 서로 간섭하지
// 않도록 한다. 대학명은 universityCatalog에만 있는 필드라 그대로 쓰고, 계열·학과는
// 계열-학과 탐색 탭의 예시 데이터(subjectExamples)에도 존재하는 값까지 포함해 더 넓게
// 보여준다(실제 반영과목 매칭은 universityCatalog만 사용 — getCareerTargets 참고).
function renderCareerFilterOptions() {
  const universityOpts = [...new Set(universityCatalog.map(i => i.university).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const combinedCatalog = [...universityCatalog, ...subjectExamples];
  const seriesOpts = [...new Set(combinedCatalog.map(i => i.series).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));
  const departmentOpts = [...new Set(combinedCatalog.map(i => i.department).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ko'));

  renderCareerMultiFilter('careerUniversityOptions', 'careerUniversitySummary', 'university', universityOpts, universityCatalog);
  renderCareerMultiFilter('careerSeriesOptions', 'careerSeriesSummary', 'series', seriesOpts, combinedCatalog);
  renderCareerMultiFilter('careerDepartmentOptions', 'careerDepartmentSummary', 'department', departmentOpts, combinedCatalog);
}

function renderCareerMultiFilter(optionsId, summaryId, key, values, catalog) {
  const container = document.getElementById(optionsId);
  if (!container) return;

  container.innerHTML = values.map(val => {
    const count = catalog.filter(i => i[key] === val).length;
    const checked = careerFilterState[key].has(val);
    return `
      <label class="filter-option">
        <input type="checkbox" data-career-key="${key}" value="${escapeHtml(val)}" ${checked ? 'checked' : ''}>
        <div class="filter-option-text">
          <div class="filter-option-name">${escapeHtml(val)}</div>
          <div class="filter-option-count">${count}개</div>
        </div>
      </label>
    `;
  }).join('');

  updateCareerFilterSummary(summaryId, key);
}

function updateCareerFilterSummary(summaryId, key) {
  const el = document.getElementById(summaryId);
  if (!el) return;
  const sel = careerFilterState[key];
  el.textContent = sel.size === 0 ? '전체' : [...sel].join(', ');
}

function getCareerTargets() {
  return universityCatalog.filter(u =>
    (!careerFilterState.university.size || careerFilterState.university.has(u.university)) &&
    (!careerFilterState.series.size || careerFilterState.series.has(u.series)) &&
    (!careerFilterState.department.size || careerFilterState.department.has(u.department))
  );
}

function getSelectedSubjectNames() {
  const names = new Set();

  Object.keys(selectedMap).forEach(key => {
    const name = key.split('::')[2];
    if (name) names.add(normalize(name));
  });

  semesterCourses.forEach(group => {
    group.courses.forEach(course => {
      if (course.group === '지정' || course.type === '지정') {
        names.add(normalize(course.name));
      }
    });
  });

  return names;
}

function expandRecommendationSubjects(subjects) {
  const items = [];
  const seen = new Set();

  subjects.forEach(subject => {
    const raw = String(subject || '').trim();
    if (!raw) return;

    const matches = getCourseMatches(raw);
    const names = matches.length ? matches.map(match => match.name || raw) : [raw];

    names.forEach(name => {
      const key = normalize(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push({ name, selected: isSubjectSelected(name) });
    });
  });

  return items;
}

function renderSubjectStatusChip(subject) {
  const stateClass = subject.selected ? 'selected' : 'unselected';
  const title = subject.selected ? '선택한 과목' : '선택하지 않은 과목';
  return `<span class="match-subject-chip ${stateClass}" title="${title}">${escapeHtml(subject.name)}</span>`;
}

function buildUniversityCourseAnalysis(targets) {
  return targets
    .map(u => {
      const groups = [
        { label: '핵심', subjects: expandRecommendationSubjects(u.core) },
        { label: '권장', subjects: expandRecommendationSubjects(u.recommended) },
        { label: '반영', subjects: expandRecommendationSubjects(u.reflected) },
      ].filter(group => group.subjects.length);

      return { u, groups, note: u.note || '' };
    })
    .filter(item => item.groups.length || item.note)
    .sort((a, b) =>
      `${a.u.university}${a.u.department}`.localeCompare(`${b.u.university}${b.u.department}`, 'ko')
    );
}

function isRequiredGroup(groupName, courses = []) {
  return groupName === '지정' || (courses.length > 0 && courses.every(course =>
    course.group === '지정' || course.type === '지정'
  ));
}

function getDisplayAreaLabel(area) {
  if (area === 'pe') return '체육';
  return areaLabels[area] || area || '';
}

function selKey(semester, group, course) { return `${semester}::${group}::${course}`; }
function groupKey(semester, group) { return `${semester}_${group}`.replace(/\s/g, '_'); }
function isSelected(semester, group, course) { return !!selectedMap[selKey(semester, group, course)]; }

function countGroupSelected(semester, group) {
  return semesterCourses
    .find(s => s.semester === semester)?.courses
    .filter(c => c.group === group && isSelected(semester, group, c.name)).length || 0;
}

function updateGroupCount(semester, group, pick) {
  const el = document.getElementById(`count-${groupKey(semester, group)}`);
  if (!el) return;
  const count = countGroupSelected(semester, group);
  el.textContent = `${count}/${pick}`;
  el.className = `sel-group-count ${count === pick ? 'valid' : count > pick ? 'over' : ''}`;
}

function showPickWarning(semester, group, pick) {
  const el = document.getElementById(`count-${groupKey(semester, group)}`);
  if (!el) return;
  const orig = el.textContent;
  el.textContent = `최대 ${pick}과목`;
  el.className = 'sel-group-count over';
  setTimeout(() => {
    el.textContent = orig;
    updateGroupCount(semester, group, pick);
  }, 1500);
}

function setDirty(dirty) {
  isDirty = dirty;
  const btn = document.getElementById('saveSelectionBtn');
  if (btn) btn.disabled = !dirty;
}

// 외부에서 선택 데이터 접근용
export function getSelectedMap() { return { ...selectedMap }; }
