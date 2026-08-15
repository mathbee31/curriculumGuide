// ─────────────────────────────────────────
//  components/teacherView.js  —  교사용 선택 현황 대시보드 + 관리자용 교사 신청 관리 + 학생 편집
// ─────────────────────────────────────────
import { escapeHtml, areaLabels } from '../utils/normalize.js';
import { getCohortYear, pickCohortSemesters } from '../sheets.js';
import { renderBulkAccountsSection } from './bulkAccountsView.js';
import {
  downloadSelectionStatusWorkbook,
  matchBulkSelectionStudents,
  parseSelectionBulkWorkbook,
} from '../utils/selectionBulkWorkbook.js';

let teacherRecords = [];
let _semesterCourses = [];
let _allCohortGroups = [];
let _currentAcademicYear = null;
let _onAdminUpdateStudent = null;
let _onAdminDeleteStudent = null;
let _onAdminResetPassword = null;
let _onAdminBulkSelectionUpload = null;
let _isAdmin = false;
let _onRefresh = null;
let _onViewStudent = null;

// 교사 담당 교과 라벨(회원가입 폼과 동일한 10개 교과군) — 회원가입 신청 패널과 관리자
// 교사 정보 수정 모달 양쪽에서 공유해 쓴다.
const SUBJECT_AREA_LABELS = {
  korean: '국어', math: '수학', english: '영어', social: '사회', science: '과학',
  info: '정보', home: '기술·가정', language: '제2외국어', liberal: '교양', arts: '예술·체육',
};

// 담임/학년부장 교사 필터 고정(2026-07 추가). null(제한 없음) 또는
// { grade: '1'|'2'|'3', classNo: string, kind: 'homeroom'|'head' }.
// 'homeroom'(담임)은 학년+반 모두 고정, 'head'(학년부장)은 학년만 고정하고 반은 자유.
// 관리자(_isAdmin===true)에게는 적용되지 않음 — app.js가 admin일 때 null을 넘겨준다.
let _restriction = null;

// 과목 선택 현황(통계) 탭 — 학생별 선택 표 필터/정렬 상태
let _statsFilterGrade = '';
let _statsFilterClass = '';
let _statsFilterSemester = '';
let _statsSortKey = null;
let _statsSortDir = 'asc';

// 과목 선택 현황(통계) 탭 — "학생별 선택 현황" 표의 과목별 필터(헤더의 과목명 클릭).
// courses가 비어있으면(''): 필터 없음. mode: 'selected'(선택자만) | 'unselected'(미선택자만).
// 클릭할 때마다 선택자만 → 미선택자만 → 해제 순으로 순환한다.
let _statsCourseFilterCourse = '';
let _statsCourseFilterMode = '';

// 과목 선택 현황(통계) 탭 — "N학년의 [대상] 과목 선택 현황표" 2개(1학년/2학년)의 필터·접기 상태.
// key는 'grade1'|'grade2'. filterGrade/filterTerm/filterArea/filterCourse는 각각 학년·학기·
// 교과·과목 드롭다운 필터 값('' = 전체). collapsed는 표 전체 접기 여부.
const _courseTableState = {
  grade1: { collapsed: false, filterGrade: '', filterTerm: '', filterArea: '', filterCourse: '' },
  grade2: { collapsed: false, filterGrade: '', filterTerm: '', filterArea: '', filterCourse: '' },
};

// 관리자용 선택 현황 탭 — "학생별 선택 현황" 표 정렬 상태
let _adminSortKey = null;
let _adminSortDir = 'asc';

// 회원 관리 — "학생 가입 신청 관리" 표 필터/정렬 상태
let _memberReqSortKey = null;
let _memberReqSortDir = 'asc';
let _memberReqFilterGrade = '';
let _memberReqFilterClass = '';
let _memberReqFilterNumber = '';
let _memberReqFilterName = '';
let _memberReqRerender = null;

// 관리자용 선택 현황 탭 — "학생별 선택 현황" 표에서 학기별 선택과목을 모아 보여줄 학기(이 4개
// 학기 외의 선택은 "기타 선택과목" 칸에 모인다. STATS_SEMESTERS와 동일한 개념).
const ADMIN_TABLE_SEMESTERS = ['2학년 1학기', '2학년 2학기', '3학년 1학기', '3학년 2학기'];

// 2학년 학생은 이미 2학년 학기 과목은 수강 중이라 더 이상 바꿀 수 없고, 3학년 과목만 수정
// 가능하다. "2학년의 3학년 과목 선택 현황표" · "학급별 선택 참여 현황(2학년)"에서 사용.
const SENIOR_ONLY_SEMESTERS = ['3학년 1학기', '3학년 2학기'];

// ── 공통 데이터 렌더링 헬퍼 ──────────────────────────────
function _renderDashboard(container, records, semesterCourses, isAdmin, onRefresh, adminUpdateFn, adminDeleteFn, allCohortGroups, currentAcademicYear, onViewStudent, restriction, resetPasswordFn) {
  teacherRecords = records || [];
  _semesterCourses = semesterCourses;
  _allCohortGroups = allCohortGroups || [];
  _currentAcademicYear = currentAcademicYear ?? null;
  _onRefresh = onRefresh;
  _onViewStudent = onViewStudent || null;
  const _localIsAdmin = isAdmin;
  const _localAdminUpdate = isAdmin ? (adminUpdateFn || null) : null;
  const _localAdminDelete = isAdmin ? (adminDeleteFn || null) : null;
  _isAdmin = _localIsAdmin;
  _onAdminUpdateStudent = _localAdminUpdate;
  _onAdminDeleteStudent = _localAdminDelete;
  _onAdminResetPassword = isAdmin ? (resetPasswordFn || null) : null;
  // 담임/학년부장 필터 고정(2026-07 추가) — 관리자 화면(isAdmin===true)에는 적용하지 않음
  _restriction = _localIsAdmin ? null : (restriction || null);

  if (_localIsAdmin) {
    renderTeacherFilterOptions(container);
    updateTeacherDashboard(container, _localIsAdmin, _localAdminUpdate, _localAdminDelete);

    container.onchange = e => {
      if (e.target.id === 'adminBulkSelectionInput') {
        handleBulkSelectionUpload(container, e.target, _localAdminUpdate);
      } else if (e.target.id === 'teacherGradeFilter') {
        renderTeacherClassOptions(container); // 학급·번호 옵션을 새 학년 기준으로 다시 계산(연쇄 갱신)
        updateTeacherDashboard(container, _localIsAdmin, _localAdminUpdate, _localAdminDelete);
      } else if (e.target.id === 'teacherClassFilter') {
        renderTeacherNumberOptions(container); // 번호 옵션을 새 학급 기준으로 다시 계산
        updateTeacherDashboard(container, _localIsAdmin, _localAdminUpdate, _localAdminDelete);
      } else if (e.target.id === 'teacherNumberFilter') {
        updateTeacherDashboard(container, _localIsAdmin, _localAdminUpdate, _localAdminDelete);
      }
    };
    container.oninput = e => {
      if (e.target.id === 'teacherSearchInput') updateTeacherDashboard(container, _localIsAdmin, _localAdminUpdate, _localAdminDelete);
    };
  } else {
    updateTeacherStatsDashboard(container);
  }

  const refreshButton = container.querySelector('[id$="RefreshBtn"]');
  if (refreshButton) refreshButton.onclick = () => onRefresh?.();
  const downloadButton = container.querySelector('#adminSelectionDownloadBtn');
  if (downloadButton) downloadButton.onclick = () => handleSelectionStatusDownload(container);
}

async function handleBulkSelectionUpload(container, input) {
  const msg = container.querySelector('#adminSelectionExcelMsg');
  const file = input.files?.[0];
  if (!file) return;
  if (!_onAdminBulkSelectionUpload) {
    if (msg) msg.innerHTML = '<span class="dm-status-err">일괄 업로드 기능이 연결되지 않았습니다.</span>';
    input.value = '';
    return;
  }

  if (msg) msg.innerHTML = `<span class="dm-status-loading">"${escapeHtml(file.name)}" 분석 중...</span>`;
  try {
    const parsed = await parseSelectionBulkWorkbook(await file.arrayBuffer());
    const { matched, missing } = matchBulkSelectionStudents(parsed.students, teacherRecords);
    const totalSelected = matched.reduce((sum, item) => sum + item.selectedCount, 0);
    const missingPreview = missing.slice(0, 8)
      .map(item => `${item.rowNo}행 ${item.grade}학년 ${item.classNo}반 ${item.number}번 ${item.name || ''} (${item.reason})`)
      .join('\n');
    const warningPreview = parsed.warnings.slice(0, 8).join('\n');
    const summary = [
      `파일: ${file.name}`,
      `읽은 학생: ${parsed.students.length}명`,
      `반영 가능: ${matched.length}명 / 선택 ${totalSelected}건`,
      `건너뜀: ${missing.length}명`,
      parsed.warnings.length ? `양식 경고: ${parsed.warnings.length}건` : '',
      missingPreview ? `\n[건너뛸 학생]\n${missingPreview}${missing.length > 8 ? '\n...' : ''}` : '',
      warningPreview ? `\n[양식 경고]\n${warningPreview}${parsed.warnings.length > 8 ? '\n...' : ''}` : '',
      '\n기존 학생 선택값은 업로드 파일의 1/0 결과로 교체됩니다. 계속할까요?',
    ].filter(Boolean).join('\n');

    if (!matched.length) {
      if (msg) msg.innerHTML = '<span class="dm-status-err">반영 가능한 학생을 찾지 못했습니다. 학년·반·번호와 승인 학생 목록을 확인해 주세요.</span>';
      return;
    }
    if (!confirm(summary)) {
      if (msg) msg.innerHTML = '<span class="dm-status-err">일괄 업로드 적용을 취소했습니다.</span>';
      return;
    }

    if (msg) msg.innerHTML = `<span class="dm-status-loading">학생 선택 ${matched.length}명 반영 중...</span>`;
    await _onAdminBulkSelectionUpload(matched.map(item => ({
      email: item.email,
      name: item.name,
      grade: item.grade,
      classNo: item.classNo,
      number: item.number,
      selectedMap: item.selectedMap,
    })));
    if (msg) msg.innerHTML = `<span class="dm-status-ok">완료: ${matched.length}명, 선택 ${totalSelected}건을 반영했습니다.</span>`;
    await _onRefresh?.();
  } catch (err) {
    console.error('학생 선택 일괄 업로드 실패:', err);
    if (msg) msg.innerHTML = `<span class="dm-status-err">업로드 실패: ${escapeHtml(err.message)}</span>`;
  } finally {
    input.value = '';
  }
}

async function handleSelectionStatusDownload(container) {
  const msg = container.querySelector('#adminSelectionExcelMsg');
  const records = getFilteredTeacherRecords(container);
  if (!records.length) {
    if (msg) msg.innerHTML = '<span class="dm-status-err">다운로드할 학생이 없습니다.</span>';
    return;
  }

  const grade = container.querySelector('#teacherGradeFilter')?.value || '전체';
  const classNo = container.querySelector('#teacherClassFilter')?.value || '전체';
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const fileName = `선택현황_${grade}학년_${classNo}반_${stamp}.xlsx`;
  try {
    if (msg) msg.innerHTML = '<span class="dm-status-loading">선택현황 엑셀 생성 중...</span>';
    await downloadSelectionStatusWorkbook({
      records,
      allCohortGroups: _allCohortGroups,
      currentAcademicYear: _currentAcademicYear,
      getCohortYear,
      fileName,
    });
    if (msg) msg.innerHTML = `<span class="dm-status-ok">다운로드 파일을 생성했습니다: ${escapeHtml(fileName)}</span>`;
  } catch (err) {
    console.error('선택현황 엑셀 다운로드 실패:', err);
    if (msg) msg.innerHTML = `<span class="dm-status-err">다운로드 실패: ${escapeHtml(err.message)}</span>`;
  }
}

// ── 교사용 탭 렌더링 (관리자 전용 섹션 없음) ────────────
// restriction(2026-07 추가): 담임/학년부장 교사 필터 고정. app.js가
// { grade, classNo, kind: 'homeroom'|'head' } 또는 null(제한 없음)을 넘겨준다.
export function renderTeacherView(records, {
  semesterCourses = [],
  allCohortGroups = [],
  currentAcademicYear = null,
  onRefresh,
  onViewStudent,
  restriction = null,
} = {}) {
  const container = document.getElementById('teacherContent');
  if (!container) return;

  container.innerHTML = `
    <div class="teacher-wrap">
      <div class="teacher-header">
        <div>
          <h2>과목 선택 현황(통계)</h2>
          <p class="teacher-desc">학급별 과목 선택 인원과 학생별 선택 현황을 확인합니다.</p>
        </div>
        <button class="teacher-refresh-btn" id="teacherRefreshBtn" type="button">새로고침</button>
      </div>

      <div id="teacherDashboardBody"></div>
    </div>
  `;

  _renderDashboard(container, records, semesterCourses, false, onRefresh, null, null, allCohortGroups, currentAcademicYear, onViewStudent, restriction);
}

// ── 관리자 탭 렌더링 (학생 편집 + 교사 계정 관리) ────────
export function renderAdminView(records, {
  semesterCourses = [],
  allCohortGroups = [],
  currentAcademicYear = null,
  onRefresh,
  onApprove,
  onReject,
  onRemove,
  fetchRequests,
  onAdminUpdateStudent = null,
  onAdminBulkSelectionUpload = null,
  onAdminDeleteStudent = null,
  onAdminResetPassword = null,
} = {}) {
  const container = document.getElementById('adminContent');
  if (!container) return;
  _onAdminBulkSelectionUpload = onAdminBulkSelectionUpload || null;

  container.innerHTML = `
    <div class="teacher-wrap">
      <div class="teacher-header">
        <div>
          <h2>관리자용 선택 현황</h2>
          <p class="teacher-desc">학생의 학년·반·번호·이름 및 선택과목 현황을 확인하고 수정합니다.</p>
        </div>
        <div class="teacher-header-actions">
          <label class="teacher-refresh-btn admin-selection-upload-label" for="adminBulkSelectionInput">
            선택정보 엑셀 업로드
            <input id="adminBulkSelectionInput" type="file" accept=".xlsx" hidden>
          </label>
          <button class="teacher-refresh-btn" id="adminSelectionDownloadBtn" type="button">선택현황 엑셀 다운로드</button>
          <button class="teacher-refresh-btn" id="adminRefreshBtn" type="button">새로고침</button>
        </div>
      </div>
      <div class="dm-parse-status" id="adminSelectionExcelMsg"></div>

      <div class="teacher-filter-bar teacher-admin-filter-bar">
        <label class="teacher-filter-field">
          <span>학년</span>
          <select id="teacherGradeFilter"></select>
        </label>
        <label class="teacher-filter-field">
          <span>학급</span>
          <select id="teacherClassFilter"></select>
        </label>
        <label class="teacher-filter-field">
          <span>번호</span>
          <select id="teacherNumberFilter"></select>
        </label>
        <label class="teacher-filter-field">
          <span>이름</span>
          <input id="teacherSearchInput" type="text" placeholder="이름 검색">
        </label>
      </div>

      <div id="teacherDashboardBody"></div>
    </div>
  `;

  // ⚠ 교사 계정 관리(가입 신청) 패널은 "회원 관리" 서브탭(renderMemberPanel)에 이미
  // 별도로 존재하므로, "선택 현황" 서브탭에서는 학년·학급·번호 필터/이름 검색 +
  // 학생별 선택 현황 표만 보여준다(중복 제거 요청, 2026-06 / 과목별 선택 통계는 2026-08 삭제).
  _renderDashboard(container, records, semesterCourses, true, onRefresh, onAdminUpdateStudent, onAdminDeleteStudent, allCohortGroups, currentAcademicYear, undefined, undefined, onAdminResetPassword);
}

// ── 교사 신청 관리 패널 (관리자 전용) ──────────────────────

async function loadTeacherRequestsPanel(container, { fetchRequests, onApprove, onReject, onRemove }) {
  const panel = container.querySelector('#adminRequestsPanel') || container.querySelector('#teacherRequestsPanel');
  if (!panel) return;
  panel.innerHTML = `
    <section class="teacher-section teacher-requests-section">
      <div class="teacher-section-head"><h3>교사 계정 관리</h3></div>
      <div class="teacher-requests-loading">불러오는 중...</div>
    </section>
  `;
  try {
    const requests = await fetchRequests();
    renderTeacherRequestsPanel(panel, requests, { onApprove, onReject, onRemove, fetchRequests });
  } catch (err) {
    panel.innerHTML = `
      <section class="teacher-section teacher-requests-section">
        <div class="teacher-requests-loading" style="color:var(--accent)">
          교사 신청 목록을 불러오지 못했습니다: ${escapeHtml(err.message)}
        </div>
      </section>`;
  }
}

function renderTeacherRequestsPanel(panel, requests, { onApprove, onReject, onRemove, fetchRequests }) {
  const pending  = requests.filter(r => r.status === 'pending');
  const approved = requests.filter(r => r.status === 'approved');
  const rejected = requests.filter(r => r.status === 'rejected');

  const SUBJECT_AREA_LABELS = {
    korean: '국어', math: '수학', english: '영어', social: '사회', science: '과학',
    info: '정보', home: '기술·가정', language: '제2외국어', liberal: '교양', arts: '예술·체육',
  };

  panel.innerHTML = `
    <section class="teacher-section teacher-requests-section">
      <div class="teacher-section-head">
        <h3>교사 계정 관리</h3>
        <button class="teacher-requests-refresh" id="reqRefreshBtn" type="button">새로고침</button>
      </div>

      ${pending.length > 0 ? `
        <div class="teacher-requests-group">
          <div class="teacher-requests-group-title pending">대기 중 <span class="teacher-badge">${pending.length}</span></div>
          <div class="teacher-table-wrap">
            <table class="teacher-table">
              <thead><tr><th>이름</th><th>이메일</th><th>교과군</th><th>인증</th><th>신청일</th><th>처리</th></tr></thead>
              <tbody>
                ${pending.map(r => `
                  <tr data-id="${escapeHtml(r.id)}" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}">
                    <td>${escapeHtml(r.name)}</td>
                    <td>${escapeHtml(r.email)}</td>
                    <td>${escapeHtml(SUBJECT_AREA_LABELS[r.subject_area] || r.subject_area || '-')}</td>
                    <td>${r.auth_method === 'email' ? '이메일' : 'Google'}</td>
                    <td>${escapeHtml(formatDate(r.created_at))}</td>
                    <td>
                      <div style="display:flex;gap:6px;">
                        <button class="req-approve-btn teacher-action-btn approve" type="button">승인</button>
                        <button class="req-reject-btn teacher-action-btn reject" type="button">거부</button>
                      </div>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : '<div class="teacher-requests-empty">대기 중인 신청이 없습니다.</div>'}

      ${approved.length > 0 ? `
        <div class="teacher-requests-group">
          <div class="teacher-requests-group-title approved">승인된 교사 <span class="teacher-badge">${approved.length}</span></div>
          <div class="teacher-table-wrap">
            <table class="teacher-table">
              <thead><tr><th>이름</th><th>이메일</th><th>교과군</th><th>승인일</th><th>처리</th></tr></thead>
              <tbody>
                ${approved.map(r => `
                  <tr data-id="${escapeHtml(r.id)}" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}">
                    <td>${escapeHtml(r.name)}</td>
                    <td>${escapeHtml(r.email)}</td>
                    <td>${escapeHtml(SUBJECT_AREA_LABELS[r.subject_area] || r.subject_area || '-')}</td>
                    <td>${escapeHtml(formatDate(r.reviewed_at))}</td>
                    <td><button class="req-remove-btn teacher-action-btn remove" type="button">해제</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}

      ${rejected.length > 0 ? `
        <details class="teacher-requests-group rejected-group">
          <summary class="teacher-requests-group-title rejected">거부된 신청 <span class="teacher-badge">${rejected.length}</span></summary>
          <div class="teacher-table-wrap">
            <table class="teacher-table">
              <thead><tr><th>이름</th><th>이메일</th><th>교과군</th><th>거부일</th><th>처리</th></tr></thead>
              <tbody>
                ${rejected.map(r => `
                  <tr data-id="${escapeHtml(r.id)}" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}">
                    <td>${escapeHtml(r.name)}</td>
                    <td>${escapeHtml(r.email)}</td>
                    <td>${escapeHtml(SUBJECT_AREA_LABELS[r.subject_area] || r.subject_area || '-')}</td>
                    <td>${escapeHtml(formatDate(r.reviewed_at))}</td>
                    <td><button class="req-approve-btn teacher-action-btn approve" type="button">승인</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>
      ` : ''}
    </section>
  `;

  panel.addEventListener('click', async e => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = row.dataset.id, email = row.dataset.email, name = row.dataset.name;

    if (e.target.classList.contains('req-approve-btn')) {
      e.target.disabled = true; e.target.textContent = '처리 중...';
      try { await onApprove(id, email, name); await reloadPanel(); }
      catch (err) { alert(`승인 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '승인'; }
    }
    if (e.target.classList.contains('req-reject-btn')) {
      if (!confirm(`${name}(${email}) 신청을 거부하시겠습니까?`)) return;
      e.target.disabled = true; e.target.textContent = '처리 중...';
      try { await onReject(id); await reloadPanel(); }
      catch (err) { alert(`거부 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '거부'; }
    }
    if (e.target.classList.contains('req-remove-btn')) {
      if (!confirm(`${name}(${email})의 교사 권한을 해제하시겠습니까?`)) return;
      e.target.disabled = true; e.target.textContent = '처리 중...';
      try { await onRemove(email); await onReject(id); await reloadPanel(); }
      catch (err) { alert(`해제 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '해제'; }
    }
  });

  panel.querySelector('#reqRefreshBtn')?.addEventListener('click', reloadPanel);

  async function reloadPanel() {
    try {
      const refreshed = await fetchRequests();
      renderTeacherRequestsPanel(panel, refreshed, { onApprove, onReject, onRemove, fetchRequests });
    } catch (err) { console.error('교사 신청 목록 새로고침 실패:', err); }
  }
}

// ── 필터 & 대시보드 ──────────────────────────────────────

function renderTeacherFilterOptions(container) {
  const gradeSelect = container.querySelector('#teacherGradeFilter');
  if (!gradeSelect) return;
  const grades = uniqueNumericSorted(teacherRecords.map(r => r.grade).filter(Boolean));
  gradeSelect.innerHTML = `<option value="">전체 학년</option>${grades.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}학년</option>`).join('')}`;
  renderTeacherClassOptions(container);
}

function renderTeacherClassOptions(container) {
  const grade = container.querySelector('#teacherGradeFilter')?.value || '';
  const classSelect = container.querySelector('#teacherClassFilter');
  if (!classSelect) return;
  const current = classSelect.value;
  const classes = uniqueNumericSorted(
    teacherRecords.filter(r => !grade || r.grade === grade).map(r => r.classNo).filter(Boolean)
  );
  classSelect.innerHTML = `<option value="">전체 학급</option>${classes.map(c => `<option value="${escapeHtml(c)}">${Number(c)}반</option>`).join('')}`;
  if (classes.includes(current)) classSelect.value = current;
  renderTeacherNumberOptions(container);
}

function renderTeacherNumberOptions(container) {
  const grade = container.querySelector('#teacherGradeFilter')?.value || '';
  const classNo = container.querySelector('#teacherClassFilter')?.value || '';
  const numberSelect = container.querySelector('#teacherNumberFilter');
  if (!numberSelect) return;
  const current = numberSelect.value;
  const numbers = uniqueNumericSorted(
    teacherRecords
      .filter(r => (!grade || r.grade === grade) && (!classNo || r.classNo === classNo))
      .map(r => r.number).filter(Boolean)
  );
  numberSelect.innerHTML = `<option value="">전체 번호</option>${numbers.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(padTwoDigits(n))}번</option>`).join('')}`;
  if (numbers.includes(current)) numberSelect.value = current;
}

function updateTeacherDashboard(container, isAdmin = false, adminUpdateFn = null, adminDeleteFn = null) {
  const body = container.querySelector('#teacherDashboardBody');
  if (!body) return;
  const filtered = getFilteredTeacherRecords(container);
  const classStats = buildClassStats(filtered);
  const totalSelections = filtered.reduce((s, r) => s + r.selections.length, 0);
  const uniqueCourses = new Set(filtered.flatMap(r => r.selections.map(i => i.courseName))).size;
  const classCount = new Set(filtered.map(r => r.grade && r.classNo ? `${r.grade}-${r.classNo}` : '').filter(Boolean)).size;
  const avgSelection = filtered.length ? (totalSelections / filtered.length).toFixed(1) : '0.0';

  // 관리자 탭의 "선택 현황"은 학생별 선택 현황만 남긴다(과목별 선택 통계는 2026-08 삭제 요청으로 제거).
  // (요약 통계 카드·학급별 요약 표는 교사용 탭(#tabTeacher)에서만 보여줌 — isAdmin=false일 때만 렌더).
  const statGridHtml = `
    <div class="teacher-stat-grid">
      <div class="teacher-stat-card"><div class="teacher-stat-value">${filtered.length}</div><div class="teacher-stat-label">학생 수</div></div>
      <div class="teacher-stat-card"><div class="teacher-stat-value">${classCount}</div><div class="teacher-stat-label">학급 수</div></div>
      <div class="teacher-stat-card"><div class="teacher-stat-value">${totalSelections}</div><div class="teacher-stat-label">선택 건수</div></div>
      <div class="teacher-stat-card"><div class="teacher-stat-value">${uniqueCourses}</div><div class="teacher-stat-label">선택 과목 종류</div></div>
      <div class="teacher-stat-card"><div class="teacher-stat-value">${avgSelection}</div><div class="teacher-stat-label">학생당 평균</div></div>
    </div>
  `;

  body.innerHTML = `
    ${isAdmin ? '' : statGridHtml}
    ${filtered.length
      ? (isAdmin ? '' : renderClassSummaryTable(classStats))
        + renderStudentTable(filtered, isAdmin)
      : '<div class="teacher-empty">조건에 맞는 학생 선택 데이터가 없습니다.</div>'}
  `;

  // 관리자 전용: 학생 행 버튼 이벤트 + 학생별 선택 현황 표 정렬
  // ⚠ body.innerHTML이 매 호출마다 통째로 교체되지만 body 자체(DOM 노드)는 그대로 유지되므로
  // addEventListener를 매번 호출하면 핸들러가 누적된다. 항상 onclick에 새 함수를 "대입"해서
  // 직전 핸들러를 자동으로 교체한다(누적 방지).
  if (isAdmin) {
    body.onclick = async e => {
      // 학생별 선택 현황 표 정렬
      const sortTh = e.target.closest('.stats-sortable');
      if (sortTh) {
        const key = sortTh.dataset.sort;
        if (_adminSortKey === key) {
          _adminSortDir = _adminSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _adminSortKey = key;
          _adminSortDir = key.startsWith('bucket::') ? 'desc' : 'asc';
        }
        updateTeacherDashboard(container, isAdmin, adminUpdateFn, adminDeleteFn);
        return;
      }

      // 정보 수정
      const editBtn = e.target.closest('.admin-edit-student-btn');
      if (editBtn && adminUpdateFn) {
        const email = editBtn.dataset.email;
        const record = teacherRecords.find(r => r.email === email);
        if (record) showAdminEditModal(record, adminUpdateFn, _onAdminResetPassword);
      }

      // 선택 기록 초기화 (계정은 유지하고 selected_map만 비움)
      const resetBtn = e.target.closest('.admin-reset-student-btn');
      if (resetBtn && adminUpdateFn) {
        const email = resetBtn.dataset.email;
        const name = resetBtn.dataset.name;
        const record = teacherRecords.find(r => r.email === email);
        if (!record) return;
        if (!confirm(`[선택 기록 초기화] ${name}(${email})\n\n이 학생이 저장한 과목 선택 기록만 초기화합니다(계정·로그인 정보는 유지).\n계속하시겠습니까?`)) return;
        resetBtn.disabled = true;
        resetBtn.textContent = '처리 중...';
        try {
          await adminUpdateFn(email, {
            name: record.name, grade: record.grade, classNo: record.classNo, number: record.number,
            selectedMap: {},
          });
          record.selectedMap = {};
          record.selections = [];
          updateTeacherDashboard(container, isAdmin, adminUpdateFn, adminDeleteFn);
          _onRefresh?.();
        } catch (err) {
          alert(`초기화 실패: ${err.message}`);
          resetBtn.disabled = false;
          resetBtn.textContent = '초기화';
        }
        return;
      }

      // 강제 탈퇴
      const deleteBtn = e.target.closest('.admin-delete-student-btn');
      if (deleteBtn && adminDeleteFn) {
        const email = deleteBtn.dataset.email;
        const name = deleteBtn.dataset.name;
        if (!confirm(`[강제 탈퇴] ${name}(${email})\n\n이 학생의 과목 선택 데이터를 삭제합니다.\n계속하시겠습니까?`)) return;
        deleteBtn.disabled = true;
        deleteBtn.textContent = '처리 중...';
        try {
          await adminDeleteFn(email);
          // 로컬 목록에서 제거
          const idx = teacherRecords.findIndex(r => r.email === email);
          if (idx !== -1) teacherRecords.splice(idx, 1);
          // 대시보드 재렌더
          updateTeacherDashboard(container, isAdmin, adminUpdateFn, adminDeleteFn);
          _onRefresh?.();
        } catch (err) {
          alert(`탈퇴 처리 실패: ${err.message}`);
          deleteBtn.disabled = false;
          deleteBtn.textContent = '탈퇴';
        }
      }
    };
  }
}

function getFilteredTeacherRecords(container) {
  const grade = container.querySelector('#teacherGradeFilter')?.value || '';
  const classNo = container.querySelector('#teacherClassFilter')?.value || '';
  const number = container.querySelector('#teacherNumberFilter')?.value || '';
  const query = normalizeSearch(container.querySelector('#teacherSearchInput')?.value || '');
  return teacherRecords.filter(record => {
    if (grade && record.grade !== grade) return false;
    if (classNo && record.classNo !== classNo) return false;
    if (number && record.number !== number) return false;
    if (!query) return true;
    return normalizeSearch(record.name || '').includes(query);
  });
}

// ──────────────────────────────────────────────────────────
//  과목 선택 현황(통계) 탭 — 학급별 매트릭스 + 학생별 선택 현황
// ──────────────────────────────────────────────────────────

// 학생의 현재 학년(1·2·3학년)과 무관하게, 모든 학생이 선택하는 대상 학기는 항상 이 4개
// (2·3학년 과목)이다. 1학년은 미리 선택, 2학년은 수정, 3학년은 조회만 한다.
const STATS_SEMESTERS = ['2학년 1학기', '2학년 2학기', '3학년 1학기', '3학년 2학기'];

/** 학년·학기에 해당하는 선택과목(지정 제외, 중복 제거) 전체 객체(name/area/credit 등). */
function getSelectionCourseObjectsForGradeSemester(grade, semester) {
  const semesterCoursesForGrade = _semesterCoursesForGrade(grade);
  const semObj = semesterCoursesForGrade.find(s => s.semester === semester);
  if (!semObj) return [];
  const seen = new Set();
  const list = [];
  for (const c of semObj.courses) {
    if (c.group === '지정') continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    list.push(c);
  }
  return list;
}

/** 학년·학기에 해당하는 선택과목(지정 제외) 이름 목록 (중복 제거). */
function getSelectionCoursesForGradeSemester(grade, semester) {
  return getSelectionCourseObjectsForGradeSemester(grade, semester).map(c => c.name);
}

/** 학생의 선택 항목을 `학기::과목명` 키 집합으로 변환. */
function buildSelectionIndex(record) {
  const idx = new Set();
  for (const s of record.selections) idx.add(`${s.semester}::${s.courseName}`);
  return idx;
}

/** "2학년 1학기" → { grade: '2', term: '1학기' } */
function splitSemesterLabel(semester) {
  const m = /^(\d)학년\s*(\d학기)$/.exec(semester || '');
  return m ? { grade: m[1], term: m[2] } : { grade: '', term: semester || '' };
}

/** 해당 학년 학생들이 실제로 속한 학급 번호 목록(오름차순, 숫자 기준). */
function getClassNumbersForGrade(records, grade) {
  const set = new Set(records.filter(r => r.grade === grade).map(r => r.classNo).filter(Boolean));
  return [...set].sort((a, b) => Number(a) - Number(b));
}

/**
 * 과목(행) × 학급(열) 구조의 선택 현황 행 목록.
 * studentGrade: 선택을 한 학생의 현재 학년. semesters: 대상 학기 목록(순서대로 행에 나열).
 */
function buildCourseSelectionRows(records, studentGrade, semesters, classNumbers) {
  const gradeRecords = records.filter(r => r.grade === studentGrade);
  const indexByEmail = new Map(gradeRecords.map(r => [r.email, buildSelectionIndex(r)]));
  const rows = [];
  for (const semester of semesters) {
    const { grade: targetGrade, term } = splitSemesterLabel(semester);
    const courses = getSelectionCourseObjectsForGradeSemester(studentGrade, semester);
    for (const course of courses) {
      const key = `${semester}::${course.name}`;
      const perClass = classNumbers.map(cls =>
        gradeRecords.filter(r => r.classNo === cls && indexByEmail.get(r.email)?.has(key)).length
      );
      const total = perClass.reduce((s, v) => s + v, 0);
      rows.push({
        grade: targetGrade,
        term,
        area: areaLabels[course.area] || course.area || '-',
        name: course.name,
        group: course.group || '-',
        credit: course.credit || 0,
        total,
        perClass,
      });
    }
  }
  return rows;
}

/** 학년/학기/교과/과목 드롭다운 필터 하나의 <select> 마크업. */
function buildCourseTableFilterSelect(tableKey, field, options, current, allLabel, labelFn = v => v) {
  return `
    <select data-course-filter-key="${escapeHtml(tableKey)}" data-course-filter-field="${escapeHtml(field)}">
      <option value="" ${current === '' ? 'selected' : ''}>${escapeHtml(allLabel)}</option>
      ${options.map(o => `<option value="${escapeHtml(o)}" ${o === current ? 'selected' : ''}>${escapeHtml(labelFn(o))}</option>`).join('')}
    </select>`;
}

/**
 * "N학년의 [대상] 과목 선택 현황표" — 과목을 행으로, 학급을 열로 나열.
 * tableKey('grade1'|'grade2')로 필터·접기 상태(_courseTableState)를 구분해 관리한다.
 */
function renderCourseSelectionTable(tableKey, title, studentGrade, semesters, records) {
  const state = _courseTableState[tableKey];
  const classNumbers = getClassNumbersForGrade(records, studentGrade);
  const allRows = buildCourseSelectionRows(records, studentGrade, semesters, classNumbers);

  if (!allRows.length) {
    return `
      <section class="teacher-section">
        <div class="teacher-section-head"><h3>${escapeHtml(title)}</h3></div>
        <div class="teacher-empty">표시할 과목 선택 데이터가 없습니다.</div>
      </section>`;
  }

  // 필터 선택지는 필터와 무관하게 항상 전체 행 기준으로 구성한다(옵션이 필터링되며 줄어들지 않게).
  const gradeOptions = uniqueNumericSorted(allRows.map(r => r.grade));
  const termOptions = uniqueSorted(allRows.map(r => r.term));
  const areaOptions = uniqueSorted(allRows.map(r => r.area));
  const courseOptions = uniqueSorted(allRows.map(r => r.name));

  // 학기가 바뀌는 등으로 목록이 갱신되며 더 이상 유효하지 않은 필터 값은 초기화한다.
  if (state.filterGrade && !gradeOptions.includes(state.filterGrade)) state.filterGrade = '';
  if (state.filterTerm && !termOptions.includes(state.filterTerm)) state.filterTerm = '';
  if (state.filterArea && !areaOptions.includes(state.filterArea)) state.filterArea = '';
  if (state.filterCourse && !courseOptions.includes(state.filterCourse)) state.filterCourse = '';

  const rows = allRows.filter(r =>
    (!state.filterGrade || r.grade === state.filterGrade) &&
    (!state.filterTerm || r.term === state.filterTerm) &&
    (!state.filterArea || r.area === state.filterArea) &&
    (!state.filterCourse || r.name === state.filterCourse)
  );

  const collapseLabel = state.collapsed ? '펼치기 ▾' : '접기 ▴';

  return `
    <section class="teacher-section">
      <div class="teacher-section-head">
        <h3>${escapeHtml(title)}</h3>
        <div class="teacher-section-actions">
          <span>${rows.length}개 과목</span>
          <button class="teacher-collapse-btn" data-collapse-key="${escapeHtml(tableKey)}" type="button">${collapseLabel}</button>
        </div>
      </div>
      ${state.collapsed ? '' : `
        <div class="teacher-filter-bar teacher-stats-filter-bar teacher-course-filter-bar">
          <label class="teacher-filter-field">
            <span>학년</span>
            ${buildCourseTableFilterSelect(tableKey, 'filterGrade', gradeOptions, state.filterGrade, '전체', v => `${v}학년`)}
          </label>
          <label class="teacher-filter-field">
            <span>학기</span>
            ${buildCourseTableFilterSelect(tableKey, 'filterTerm', termOptions, state.filterTerm, '전체')}
          </label>
          <label class="teacher-filter-field">
            <span>교과</span>
            ${buildCourseTableFilterSelect(tableKey, 'filterArea', areaOptions, state.filterArea, '전체')}
          </label>
          <label class="teacher-filter-field">
            <span>과목</span>
            ${buildCourseTableFilterSelect(tableKey, 'filterCourse', courseOptions, state.filterCourse, '전체')}
          </label>
        </div>
        <div class="teacher-table-wrap">
          <table class="teacher-table teacher-matrix-table teacher-course-selection-table">
            <thead>
              <tr>
                <th>학년</th><th>학기</th><th>교과</th><th>과목</th><th>선택 그룹</th><th>학점</th><th>선택 총원</th>
                ${classNumbers.map(c => `<th>${Number(c)}반</th>`).join('')}
              </tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map(r => `
                <tr>
                  <td>${escapeHtml(r.grade)}</td>
                  <td>${escapeHtml(r.term)}</td>
                  <td>${escapeHtml(r.area)}</td>
                  <td class="teacher-course-name">${escapeHtml(r.name)}</td>
                  <td>${escapeHtml(r.group)}</td>
                  <td>${r.credit}</td>
                  <td>${r.total}</td>
                  ${r.perClass.map(v => `<td>${v}</td>`).join('')}
                </tr>`).join('')
                : `<tr><td colspan="${7 + classNumbers.length}" class="teacher-empty-cell">조건에 맞는 과목이 없습니다.</td></tr>`}
            </tbody>
          </table>
        </div>
      `}
    </section>`;
}

/** 대상 학기 중 하나라도 선택 기록이 있으면 "참여"로 본다. */
function getNonParticipants(records, studentGrade, semesters, classNo) {
  return records
    .filter(r => r.grade === studentGrade && r.classNo === classNo)
    .filter(r => !r.selections.some(s => semesters.includes(s.semester)))
    .sort((a, b) => Number(a.number) - Number(b.number));
}

/** "학급별 선택 참여 현황"의 학년별 표(1행: 미참여자 총원, 2행부터: 미참여 학생 명단). */
function renderParticipationTable(title, studentGrade, semesters, records) {
  const classNumbers = getClassNumbersForGrade(records, studentGrade);
  if (!classNumbers.length) {
    return `
      <div class="teacher-matrix-block">
        <div class="teacher-section-head"><h4>${escapeHtml(title)}</h4></div>
        <div class="teacher-empty">표시할 학급 데이터가 없습니다.</div>
      </div>`;
  }

  const nonParticipantsByClass = classNumbers.map(cls => getNonParticipants(records, studentGrade, semesters, cls));
  const maxRows = Math.max(0, ...nonParticipantsByClass.map(list => list.length));
  const extraRows = [];
  for (let i = 0; i < maxRows; i++) {
    extraRows.push(`
      <tr>
        <td></td>
        ${nonParticipantsByClass.map(list => `<td>${list[i] ? escapeHtml(list[i].name || list[i].email) : ''}</td>`).join('')}
      </tr>`);
  }

  return `
    <div class="teacher-matrix-block">
      <div class="teacher-section-head"><h4>${escapeHtml(title)}</h4></div>
      <div class="teacher-table-wrap">
        <table class="teacher-table teacher-matrix-table teacher-participation-table">
          <thead>
            <tr><th></th>${classNumbers.map(c => `<th>${Number(c)}반</th>`).join('')}</tr>
          </thead>
          <tbody>
            <tr class="teacher-matrix-total-row">
              <td>미참여자 총원</td>
              ${nonParticipantsByClass.map(list => `<td>${list.length}명</td>`).join('')}
            </tr>
            ${extraRows.join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function renderParticipationSection(records, availableGrades) {
  const blocks = [];
  if (availableGrades.includes('1')) blocks.push(renderParticipationTable('1학년', '1', STATS_SEMESTERS, records));
  if (availableGrades.includes('2')) blocks.push(renderParticipationTable('2학년', '2', SENIOR_ONLY_SEMESTERS, records));
  if (!blocks.length) return '';
  return `
    <section class="teacher-section">
      <div class="teacher-section-head"><h3>학급별 선택 참여 현황</h3></div>
      ${blocks.join('')}
    </section>`;
}

function sortArrow(key) {
  if (_statsSortKey !== key) return '';
  return _statsSortDir === 'asc' ? ' ▲' : ' ▼';
}

function sortStatsRows(rows) {
  if (!_statsSortKey) {
    return rows.sort((a, b) => {
      const c = Number(a.record.classNo) - Number(b.record.classNo);
      if (c) return c;
      return Number(a.record.number) - Number(b.record.number);
    });
  }
  const dir = _statsSortDir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    let av, bv;
    switch (_statsSortKey) {
      case 'classNo': av = Number(a.record.classNo); bv = Number(b.record.classNo); break;
      case 'number':  av = Number(a.record.number);  bv = Number(b.record.number);  break;
      case 'name':     av = a.record.name || ''; bv = b.record.name || ''; break;
      default:         av = a.record.grade || ''; bv = b.record.grade || '';
    }
    if (typeof av === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'ko') * dir;
  });
}

/** 숫자 셀 표시용: "학년"/"반"/"번" 등 단위를 빼고 숫자만, 반·번호는 두 자리로 0-패딩. */
function padTwoDigits(value) {
  if (value === undefined || value === null || value === '') return '-';
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  return String(n).padStart(2, '0');
}

function renderStudentSelectionSection(availableGrades, semesterOptions, classOptions, gradeLocked = false, classLocked = false) {
  const courses = _statsFilterSemester
    ? getSelectionCoursesForGradeSemester(_statsFilterGrade, _statsFilterSemester)
    : [];

  // 학기가 바뀌면 이전 학기의 과목 필터는 더 이상 유효하지 않으므로 해제한다.
  if (_statsCourseFilterCourse && !courses.includes(_statsCourseFilterCourse)) {
    _statsCourseFilterCourse = '';
    _statsCourseFilterMode = '';
  }

  let records = teacherRecords.filter(r => r.grade === _statsFilterGrade);
  if (_statsFilterClass) records = records.filter(r => r.classNo === _statsFilterClass);

  let rows = records.map(r => ({ record: r, selectedSet: buildSelectionIndex(r) }));

  // 헤더의 과목명을 클릭하면 해당 과목 "선택자만" → "미선택자만" → 해제 순으로 필터링.
  if (_statsCourseFilterCourse && _statsCourseFilterMode) {
    const key = `${_statsFilterSemester}::${_statsCourseFilterCourse}`;
    rows = rows.filter(({ selectedSet }) => {
      const has = selectedSet.has(key);
      return _statsCourseFilterMode === 'selected' ? has : !has;
    });
  }

  rows = sortStatsRows(rows);

  // 담임은 "전체" 옵션 없이 본인 학급 하나만 — 부장/일반 교사는 기존처럼 "전체" 포함.
  const classFilterOptionsHtml = classLocked
    ? classOptions.map(c => `<option value="${escapeHtml(c)}" selected>${Number(c)}반</option>`).join('')
    : `<option value="" ${_statsFilterClass === '' ? 'selected' : ''}>전체</option>` +
      classOptions.map(c => `<option value="${escapeHtml(c)}" ${c === _statsFilterClass ? 'selected' : ''}>${Number(c)}반</option>`).join('');

  return `
    <section class="teacher-section">
      <div class="teacher-section-head"><h3>학생별 선택 현황</h3><span>${rows.length}명</span></div>

      <div class="teacher-filter-bar teacher-stats-filter-bar">
        <label class="teacher-filter-field">
          <span>학년</span>
          <select id="statsGradeFilter" ${gradeLocked ? 'disabled title="담당 학년으로 고정되어 있습니다."' : ''}>
            ${availableGrades.map(g => `<option value="${escapeHtml(g)}" ${g === _statsFilterGrade ? 'selected' : ''}>${escapeHtml(g)}학년</option>`).join('')}
          </select>
        </label>
        <label class="teacher-filter-field">
          <span>학급</span>
          <select id="statsClassFilter" ${classLocked ? 'disabled title="담임 학급으로 고정되어 있습니다."' : ''}>
            ${classFilterOptionsHtml}
          </select>
        </label>
        <label class="teacher-filter-field">
          <span>학기</span>
          <select id="statsSemesterFilter">
            ${semesterOptions.map(s => `<option value="${escapeHtml(s)}" ${s === _statsFilterSemester ? 'selected' : ''}>${escapeHtml(s)}</option>`).join('')}
          </select>
        </label>
      </div>

      <div class="teacher-table-wrap">
        <table class="teacher-table teacher-stats-student-table">
          <thead>
            <tr>
              <th class="stats-sortable" data-sort="grade">학년${sortArrow('grade')}</th>
              <th class="stats-sortable" data-sort="classNo">반${sortArrow('classNo')}</th>
              <th class="stats-sortable" data-sort="number">번호${sortArrow('number')}</th>
              <th>이름</th>
              ${courses.map(c => {
                const active = _statsCourseFilterCourse === c ? _statsCourseFilterMode : '';
                const badge = active === 'selected' ? ' (선택자만)' : active === 'unselected' ? ' (미선택자만)' : '';
                return `<th class="stats-filterable${active ? ' stats-filter-active' : ''}" data-course="${escapeHtml(c)}" title="클릭하면 선택자만 → 미선택자만 → 전체 순으로 필터링됩니다.">${escapeHtml(c)}${badge}</th>`;
              }).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(({ record, selectedSet }) => `
              <tr>
                <td>${escapeHtml(String(record.grade ?? '-'))}</td>
                <td>${escapeHtml(padTwoDigits(record.classNo))}</td>
                <td>${escapeHtml(padTwoDigits(record.number))}</td>
                <td class="teacher-student-name">
                  <button class="stats-student-name-btn" data-email="${escapeHtml(record.email)}" type="button">${escapeHtml(record.name || record.email)}</button>
                </td>
                ${courses.map(c => `<td class="stats-mark-cell">${selectedSet.has(`${_statsFilterSemester}::${c}`) ? '<span class="stats-mark">✓</span>' : ''}</td>`).join('')}
              </tr>`).join('')
              : `<tr><td colspan="${4 + courses.length}" class="teacher-empty-cell">조건에 맞는 학생이 없습니다.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function updateTeacherStatsDashboard(container) {
  const body = container.querySelector('#teacherDashboardBody');
  if (!body) return;

  // 통계 탭은 기본적으로 1~3학년 구조를 모두 보여준다(학생 선택 데이터가 아직 없어도 표
  // 구조는 표시). 1학년은 2·3학년 과목을 미리 선택하고, 2학년은 3학년 과목만 수정하며,
  // 3학년은 그동안의 선택을 조회만 하므로 "1학년의 2,3학년 과목 선택 현황표"·
  // "2학년의 3학년 과목 선택 현황표"·"학급별 선택 참여 현황"은 대상 학년이 고정되어 있다.
  // 담임/학년부장 교사(2026-07 추가)는 담당 학년 하나로만 제한된다 — 담당 학년이 1 또는 2가
  // 아니면(3학년 담당) 이 표들은 대상이 없으므로 표시하지 않는다.
  const availableGrades = (_restriction && _restriction.grade) ? [_restriction.grade] : ['1', '2', '3'];
  const gradeLocked = Boolean(_restriction && _restriction.grade);

  if (!availableGrades.includes(_statsFilterGrade)) {
    _statsFilterGrade = availableGrades[0] || '';
    _statsFilterClass = '';
    _statsFilterSemester = '';
    _statsCourseFilterCourse = '';
    _statsCourseFilterMode = '';
  }

  const semesterOptions = STATS_SEMESTERS;
  if (!semesterOptions.includes(_statsFilterSemester)) {
    _statsFilterSemester = semesterOptions[0] || '';
  }

  let classOptions = uniqueNumericSorted(
    teacherRecords.filter(r => r.grade === _statsFilterGrade).map(r => r.classNo).filter(Boolean)
  );
  // 담임은 "학생별 선택 현황"의 학급 필터를 본인 학급으로 고정(전체 선택 불가).
  // 학년부장은 학급 필터를 자유롭게 쓸 수 있어야 하므로 classOptions를 그대로 둔다.
  const classLocked = Boolean(_restriction && _restriction.kind === 'homeroom' && _restriction.classNo);
  if (classLocked) {
    classOptions = [_restriction.classNo];
    _statsFilterClass = _restriction.classNo;
  } else if (_statsFilterClass !== '' && !classOptions.includes(_statsFilterClass)) {
    _statsFilterClass = '';
  }

  const courseSelectionSections = [
    availableGrades.includes('1') ? renderCourseSelectionTable('grade1', '1학년의 2,3학년 과목 선택 현황표', '1', STATS_SEMESTERS, teacherRecords) : '',
    availableGrades.includes('2') ? renderCourseSelectionTable('grade2', '2학년의 3학년 과목 선택 현황표', '2', SENIOR_ONLY_SEMESTERS, teacherRecords) : '',
  ].join('');

  body.innerHTML = `${courseSelectionSections}${renderParticipationSection(teacherRecords, availableGrades)}${renderStudentSelectionSection(availableGrades, semesterOptions, classOptions, gradeLocked, classLocked)}`;

  bindTeacherStatsEvents(container);
}

function bindTeacherStatsEvents(container) {
  const gradeSel = container.querySelector('#statsGradeFilter');
  const classSel = container.querySelector('#statsClassFilter');
  const semSel   = container.querySelector('#statsSemesterFilter');

  if (gradeSel) {
    gradeSel.onchange = () => {
      _statsFilterGrade = gradeSel.value;
      _statsFilterClass = '';
      _statsFilterSemester = '';
      _statsSortKey = null;
      _statsCourseFilterCourse = '';
      _statsCourseFilterMode = '';
      updateTeacherStatsDashboard(container);
    };
  }
  if (classSel) {
    classSel.onchange = () => {
      _statsFilterClass = classSel.value;
      updateTeacherStatsDashboard(container);
    };
  }
  if (semSel) {
    semSel.onchange = () => {
      _statsFilterSemester = semSel.value;
      _statsSortKey = null;
      _statsCourseFilterCourse = '';
      _statsCourseFilterMode = '';
      updateTeacherStatsDashboard(container);
    };
  }

  // "N학년의 [대상] 과목 선택 현황표" — 표 전체 접기/펼치기.
  container.querySelectorAll('.teacher-collapse-btn').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.collapseKey;
      if (!_courseTableState[key]) return;
      _courseTableState[key].collapsed = !_courseTableState[key].collapsed;
      updateTeacherStatsDashboard(container);
    };
  });

  // "N학년의 [대상] 과목 선택 현황표" — 학년/학기/교과/과목 드롭다운 필터.
  container.querySelectorAll('[data-course-filter-key]').forEach(sel => {
    sel.onchange = () => {
      const key = sel.dataset.courseFilterKey;
      const field = sel.dataset.courseFilterField;
      if (!_courseTableState[key]) return;
      _courseTableState[key][field] = sel.value;
      updateTeacherStatsDashboard(container);
    };
  });

  container.querySelectorAll('.stats-sortable').forEach(th => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (_statsSortKey === key) {
        _statsSortDir = _statsSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        _statsSortKey = key;
        _statsSortDir = 'asc';
      }
      updateTeacherStatsDashboard(container);
    };
  });

  // 헤더의 과목명 클릭 → "선택자만" → "미선택자만" → 해제 순으로 순환.
  container.querySelectorAll('.stats-filterable').forEach(th => {
    th.onclick = () => {
      const course = th.dataset.course;
      if (_statsCourseFilterCourse !== course) {
        _statsCourseFilterCourse = course;
        _statsCourseFilterMode = 'selected';
      } else if (_statsCourseFilterMode === 'selected') {
        _statsCourseFilterMode = 'unselected';
      } else {
        _statsCourseFilterCourse = '';
        _statsCourseFilterMode = '';
      }
      updateTeacherStatsDashboard(container);
    };
  });

  container.querySelectorAll('.stats-student-name-btn').forEach(btn => {
    btn.onclick = () => {
      const record = teacherRecords.find(r => r.email === btn.dataset.email);
      if (record && _onViewStudent) _onViewStudent(record);
    };
  });
}

// ── 관리자 학생 편집 모달 ─────────────────────────────

function showAdminEditModal(record, adminUpdateFn, resetPasswordFn) {
  const _onAdminUpdateStudentLocal = adminUpdateFn || _onAdminUpdateStudent;
  const _onAdminResetPasswordLocal = resetPasswordFn || _onAdminResetPassword;
  // 기존 모달 제거
  document.getElementById('adminEditStudentModal')?.remove();

  // 선택과목을 학기/그룹별로 정리
  const semGroups = buildSemGroupList(record.selectedMap || {}, record.grade);

  const modal = document.createElement('div');
  modal.id = 'adminEditStudentModal';
  modal.className = 'modal-overlay visible';
  modal.innerHTML = `
    <div class="modal-card admin-edit-modal">
      <h2>학생 정보 수정</h2>
      <p class="modal-desc">${escapeHtml(record.email)}</p>

      <div class="admin-edit-grid">
        <div class="modal-field">
          <label>이름 <span class="req">*</span></label>
          <input id="aeName" type="text" value="${escapeHtml(record.name || '')}" placeholder="홍길동">
        </div>
        <div class="modal-field">
          <label>학년 <span class="req">*</span></label>
          <select id="aeGrade">
            <option value="">선택</option>
            ${['1','2','3'].map(g => `<option value="${g}" ${record.grade === g ? 'selected' : ''}>${g}학년</option>`).join('')}
          </select>
        </div>
        <div class="modal-field">
          <label>반 <span class="req">*</span></label>
          <input id="aeClass" type="number" min="1" max="20" value="${escapeHtml(record.classNo || '')}" placeholder="1">
        </div>
        <div class="modal-field">
          <label>번호 <span class="req">*</span></label>
          <input id="aeNumber" type="number" min="1" max="50" value="${escapeHtml(record.number || '')}" placeholder="1">
        </div>
        <div class="modal-field">
          <label>새 비밀번호</label>
          <input id="aePassword" type="password" placeholder="변경하지 않으려면 비워두세요" autocomplete="new-password">
        </div>
      </div>

      <div class="admin-edit-courses">
        <h3>선택과목 수정</h3>
        ${semGroups.map(({ semester, group, pick, courses, selected }) => `
          <div class="ae-group">
            <div class="ae-group-head">
              <span class="ae-group-label">${escapeHtml(semester)} · ${escapeHtml(group)}</span>
              <span class="ae-group-pick">${pick}과목 선택</span>
            </div>
            <div class="ae-course-list">
              ${courses.map(course => `
                <label class="ae-course-item">
                  <input type="checkbox"
                    data-key="${escapeHtml(`${semester}::${group}::${course}`)}"
                    ${selected.has(course) ? 'checked' : ''}>
                  <span>${escapeHtml(course)}</span>
                </label>
              `).join('')}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="modal-msg" id="aeMsg"></div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" id="aeCloseBtn" type="button">취소</button>
        <button class="modal-btn modal-btn-submit" id="aeSaveBtn" type="button">저장</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#aeCloseBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#aeSaveBtn').addEventListener('click', async () => {
    const msgEl = modal.querySelector('#aeMsg');
    const name = modal.querySelector('#aeName').value.trim();
    const grade = modal.querySelector('#aeGrade').value;
    const classNo = modal.querySelector('#aeClass').value.trim();
    const number = modal.querySelector('#aeNumber').value.trim();
    const newPassword = modal.querySelector('#aePassword').value;

    if (!name || !grade || !classNo || !number) {
      msgEl.textContent = '모든 항목을 입력해 주세요.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && newPassword.length < 6) {
      msgEl.textContent = '비밀번호는 6자 이상이어야 합니다.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && !_onAdminResetPasswordLocal) {
      msgEl.textContent = '비밀번호 변경 기능을 사용할 수 없습니다.'; msgEl.className = 'modal-msg error'; return;
    }

    // 선택과목 수집
    const newSelectedMap = {};
    modal.querySelectorAll('.ae-course-item input[type=checkbox]').forEach(cb => {
      if (cb.checked) newSelectedMap[cb.dataset.key] = true;
    });

    const saveBtn = modal.querySelector('#aeSaveBtn');
    saveBtn.disabled = true; saveBtn.textContent = '저장 중...';
    msgEl.textContent = ''; msgEl.className = 'modal-msg';
    try {
      await _onAdminUpdateStudentLocal(record.email, { name, grade, classNo, number, selectedMap: newSelectedMap });
      if (newPassword) {
        await _onAdminResetPasswordLocal(record.email, newPassword);
      }
      msgEl.textContent = newPassword ? '정보와 비밀번호가 저장됐습니다.' : '저장됐습니다.';
      msgEl.className = 'modal-msg success';
      // 로컬 레코드 업데이트
      const idx = teacherRecords.findIndex(r => r.email === record.email);
      if (idx !== -1) {
        teacherRecords[idx] = { ...teacherRecords[idx], name, grade, classNo, number,
          selectedMap: newSelectedMap, selections: Object.keys(newSelectedMap).map(k => {
            const [semester, group, courseName] = k.split('::');
            return { semester, group, courseName };
          })
        };
      }
      setTimeout(() => { modal.remove(); _onRefresh?.(); }, 800);
    } catch (err) {
      msgEl.textContent = `저장 실패: ${err.message}`; msgEl.className = 'modal-msg error';
      saveBtn.disabled = false; saveBtn.textContent = '저장';
    }
  });
}

// ── 관리자 교사 정보 수정 모달 (회원 관리 → 교사 계정 관리, 2026-08 추가) ──────
//
// record: { email, name, subjectArea, homeroomGrade, homeroomClass, portalUrl }
// updateProfileFn: sheets.js의 adminUpdateTeacherProfile(email, {...}) — 이름/담당 교과/
//   담임 학년·반/URL을 teacher_requests에 저장(관리자 전체 접근 RLS로 이미 허용됨).
// resetPasswordFn: sheets.js의 adminResetPassword(email, newPassword) — 비밀번호 입력 시에만 호출.
// onSaved: 저장 성공 후 호출되는 콜백(목록 재조회 — loadTeacherMemberList의 reload()).
function showAdminEditTeacherModal(record, updateProfileFn, resetPasswordFn, onSaved) {
  document.getElementById('adminEditTeacherModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'adminEditTeacherModal';
  modal.className = 'modal-overlay visible';
  modal.innerHTML = `
    <div class="modal-card admin-edit-modal">
      <h2>교사 정보 수정</h2>
      <p class="modal-desc">${escapeHtml(record.email)}</p>

      <div class="admin-edit-grid">
        <div class="modal-field">
          <label>이름</label>
          <input id="teName" type="text" value="${escapeHtml(record.name || '')}" placeholder="홍길동">
        </div>
        <div class="modal-field">
          <label>담당 교과</label>
          <select id="teSubject">
            <option value="">선택 안 함</option>
            ${Object.entries(SUBJECT_AREA_LABELS).map(([value, label]) =>
              `<option value="${value}" ${record.subjectArea === value ? 'selected' : ''}>${escapeHtml(label)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="modal-field">
          <label>담임 학년</label>
          <select id="teHomeroomGrade">
            <option value="">해당 없음(일반 교사)</option>
            ${['1', '2', '3'].map(g => `<option value="${g}" ${record.homeroomGrade === g ? 'selected' : ''}>${g}학년</option>`).join('')}
          </select>
        </div>
        <div class="modal-field">
          <label>담임 반</label>
          <input id="teHomeroomClass" type="number" min="0" max="20" value="${escapeHtml(record.homeroomClass || '')}" placeholder="비우거나 0 = 학년부장(비담임)">
        </div>
        <div class="modal-field">
          <label>수강신청 바로가기 URL</label>
          <input id="tePortalUrl" type="text" value="${escapeHtml(record.portalUrl || '')}" placeholder="https://...">
        </div>
        <div class="modal-field">
          <label>새 비밀번호</label>
          <input id="tePassword" type="password" placeholder="변경하지 않으려면 비워두세요" autocomplete="new-password">
        </div>
      </div>

      <div class="modal-msg" id="teMsg"></div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" id="teCloseBtn" type="button">취소</button>
        <button class="modal-btn modal-btn-submit" id="teSaveBtn" type="button">저장</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#teCloseBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#teSaveBtn').addEventListener('click', async () => {
    const msgEl = modal.querySelector('#teMsg');
    const name = modal.querySelector('#teName').value.trim();
    const subjectArea = modal.querySelector('#teSubject').value;
    const homeroomGrade = modal.querySelector('#teHomeroomGrade').value;
    const homeroomClass = modal.querySelector('#teHomeroomClass').value.trim();
    const portalUrl = modal.querySelector('#tePortalUrl').value.trim();
    const newPassword = modal.querySelector('#tePassword').value;

    if (!name) {
      msgEl.textContent = '이름을 입력해 주세요.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && newPassword.length < 6) {
      msgEl.textContent = '비밀번호는 6자 이상이어야 합니다.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && !resetPasswordFn) {
      msgEl.textContent = '비밀번호 변경 기능을 사용할 수 없습니다.'; msgEl.className = 'modal-msg error'; return;
    }
    if (!updateProfileFn) {
      msgEl.textContent = '교사 정보 수정 기능을 사용할 수 없습니다.'; msgEl.className = 'modal-msg error'; return;
    }

    const saveBtn = modal.querySelector('#teSaveBtn');
    saveBtn.disabled = true; saveBtn.textContent = '저장 중...';
    msgEl.textContent = ''; msgEl.className = 'modal-msg';
    try {
      await updateProfileFn(record.email, { name, subjectArea, homeroomGrade, homeroomClass, portalUrl });
      if (newPassword) {
        await resetPasswordFn(record.email, newPassword);
      }
      msgEl.textContent = newPassword ? '정보와 비밀번호가 저장됐습니다.' : '저장됐습니다.';
      msgEl.className = 'modal-msg success';
      setTimeout(async () => { modal.remove(); await onSaved?.(); }, 800);
    } catch (err) {
      msgEl.textContent = `저장 실패: ${err.message}`; msgEl.className = 'modal-msg error';
      saveBtn.disabled = false; saveBtn.textContent = '저장';
    }
  });
}

/** 학생의 학년(grade)에 해당하는 코호트의 학기별 과목 목록. 못 찾으면 기본(_semesterCourses) 사용. */
function _semesterCoursesForGrade(grade) {
  if (!grade || !_allCohortGroups.length || _currentAcademicYear == null) return _semesterCourses;
  const cohortYear = getCohortYear(grade, _currentAcademicYear);
  if (cohortYear == null) return _semesterCourses;
  const picked = pickCohortSemesters(_allCohortGroups, cohortYear);
  return picked.length ? picked : _semesterCourses;
}

/** 학기·그룹별 과목 목록 구성 (DB 과목 + 선택된 과목 합집합). grade를 넘기면 해당 학생의 코호트를 사용. */
function buildSemGroupList(selectedMap, grade) {
  // semester_courses 데이터에서 선택 가능한 그룹 목록 구성
  const groupMap = new Map();
  const semesterCoursesForRecord = _semesterCoursesForGrade(grade);

  // DB 데이터 기반
  for (const semObj of semesterCoursesForRecord) {
    const sem = semObj.semester;
    const grouped = new Map();
    for (const c of semObj.courses) {
      if (c.group === '지정') continue; // 지정 과목은 수정 불필요
      if (!grouped.has(c.group)) grouped.set(c.group, { pick: c.pick, courses: [] });
      grouped.get(c.group).courses.push(c.name);
    }
    for (const [group, { pick, courses }] of grouped) {
      const key = `${sem}::${group}`;
      groupMap.set(key, { semester: sem, group, pick, courses: new Set(courses) });
    }
  }

  // 현재 selectedMap에 있지만 DB에 없는 항목도 추가
  for (const key of Object.keys(selectedMap)) {
    const [semester, group, courseName] = key.split('::');
    if (!semester || !group || !courseName) continue;
    const mapKey = `${semester}::${group}`;
    if (!groupMap.has(mapKey)) groupMap.set(mapKey, { semester, group, pick: 0, courses: new Set() });
    groupMap.get(mapKey).courses.add(courseName);
  }

  return [...groupMap.values()].map(({ semester, group, pick, courses }) => {
    const selectedKeys = Object.keys(selectedMap).filter(k => k.startsWith(`${semester}::${group}::`));
    const selectedCourses = new Set(selectedKeys.map(k => k.split('::')[2]));
    return { semester, group, pick, courses: [...courses], selected: selectedCourses };
  }).sort((a, b) => {
    const s = a.semester.localeCompare(b.semester, 'ko');
    return s || a.group.localeCompare(b.group, 'ko');
  });
}

// ── 통계 렌더링 ──────────────────────────────────────────

function buildClassStats(records) {
  const map = new Map();
  for (const record of records) {
    const key = `${record.grade || '-'}::${record.classNo || '-'}`;
    const item = map.get(key) || { grade: record.grade || '-', classNo: record.classNo || '-', students: 0, totalSelections: 0, records: [] };
    item.students += 1;
    item.totalSelections += record.selections.length;
    item.records.push(record);
    map.set(key, item);
  }
  return [...map.values()].sort((a, b) => {
    const g = String(a.grade).localeCompare(String(b.grade), 'ko');
    return g || String(a.classNo).localeCompare(String(b.classNo), 'ko');
  });
}

function buildCourseStats(records) {
  const map = new Map();
  for (const record of records) {
    const counted = new Set();
    for (const sel of record.selections) {
      const item = map.get(sel.courseName) || { courseName: sel.courseName, count: 0, contexts: new Set() };
      item.contexts.add(`${sel.semester} ${sel.group}`);
      if (!counted.has(sel.courseName)) { item.count += 1; counted.add(sel.courseName); }
      map.set(sel.courseName, item);
    }
  }
  return [...map.values()].sort((a, b) => b.count !== a.count ? b.count - a.count : a.courseName.localeCompare(b.courseName, 'ko'));
}

function renderClassSummaryTable(classStats) {
  return `
    <section class="teacher-section">
      <div class="teacher-section-head"><h3>학급별 요약</h3><span>${classStats.length}개 학급</span></div>
      <div class="teacher-table-wrap">
        <table class="teacher-table teacher-class-table">
          <thead><tr><th>학년</th><th>학급</th><th>학생 수</th><th>선택 건수</th><th>평균</th><th>상위 선택 과목</th></tr></thead>
          <tbody>
            ${classStats.map(item => `
              <tr>
                <td>${escapeHtml(formatGrade(item.grade))}</td>
                <td>${escapeHtml(formatClass(item.classNo))}</td>
                <td>${item.students}</td>
                <td>${item.totalSelections}</td>
                <td>${item.students ? (item.totalSelections / item.students).toFixed(1) : '0.0'}</td>
                <td>${renderCourseChips(getTopCourses(item.records, 5))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;
}

/** 학생의 선택 항목을 ADMIN_TABLE_SEMESTERS 4개 학기 + "기타"(그 외 모든 학기) 칸으로 분류. */
function bucketSelectionsBySemester(selections) {
  const buckets = {};
  for (const sem of ADMIN_TABLE_SEMESTERS) buckets[sem] = [];
  buckets['기타'] = [];
  for (const sel of selections) {
    (buckets[sel.semester] || buckets['기타']).push(sel);
  }
  return buckets;
}

function renderBucketChips(items) {
  if (!items.length) return '<span class="teacher-muted">-</span>';
  return `<div class="teacher-chip-list">${items.map(i => `<span class="teacher-chip" title="${escapeHtml(i.group)}">${escapeHtml(i.courseName)}</span>`).join('')}</div>`;
}

function adminSortArrow(key) {
  if (_adminSortKey !== key) return '';
  return _adminSortDir === 'asc' ? ' ▲' : ' ▼';
}

/** 학생별 선택 현황 표 정렬. 학기별 선택과목 칸(`bucket::학기`)은 해당 칸의 선택 개수로 정렬. */
function sortAdminStudentRows(records) {
  const rows = records.map(record => ({ record, buckets: bucketSelectionsBySemester(record.selections) }));

  if (!_adminSortKey) {
    return rows.sort((a, b) => {
      const g = Number(a.record.grade) - Number(b.record.grade);
      if (g) return g;
      const c = Number(a.record.classNo) - Number(b.record.classNo);
      if (c) return c;
      return Number(a.record.number) - Number(b.record.number);
    });
  }

  const dir = _adminSortDir === 'asc' ? 1 : -1;

  if (_adminSortKey.startsWith('bucket::')) {
    const sem = _adminSortKey.slice('bucket::'.length);
    return rows.sort((a, b) => {
      const av = a.buckets[sem]?.length || 0;
      const bv = b.buckets[sem]?.length || 0;
      if (av !== bv) return (av - bv) * dir;
      return Number(a.record.number) - Number(b.record.number);
    });
  }

  return rows.sort((a, b) => {
    let av, bv;
    switch (_adminSortKey) {
      case 'grade':     av = Number(a.record.grade); bv = Number(b.record.grade); break;
      case 'classNo':   av = Number(a.record.classNo); bv = Number(b.record.classNo); break;
      case 'number':    av = Number(a.record.number); bv = Number(b.record.number); break;
      case 'name':      av = a.record.name || ''; bv = b.record.name || ''; break;
      case 'timestamp': av = a.record.timestamp ? new Date(a.record.timestamp).getTime() : 0;
                         bv = b.record.timestamp ? new Date(b.record.timestamp).getTime() : 0; break;
      default:          av = ''; bv = '';
    }
    if (typeof av === 'number') return ((av || 0) - (bv || 0)) * dir;
    return String(av).localeCompare(String(bv), 'ko') * dir;
  });
}

function renderStudentTable(records, isAdmin) {
  // 관리자용 표만 정렬·"학기별 선택과목" 칸 구조를 적용한다(교사용 통계 탭은 별도 함수
  // renderStudentSelectionSection이 담당하므로 이 함수는 실질적으로 isAdmin=true로만 호출됨).
  if (!isAdmin) {
    return `
      <section class="teacher-section">
        <div class="teacher-section-head"><h3>학생별 선택 현황</h3><span>${records.length}명</span></div>
        <div class="teacher-table-wrap">
          <table class="teacher-table teacher-student-table">
            <thead>
              <tr>
                <th>학년</th><th>학급</th><th>번호</th><th>이름</th><th>이메일</th>
                <th>선택 수</th><th>선택 과목</th><th>저장 시각</th>
              </tr>
            </thead>
            <tbody>
              ${records.map(record => `
                <tr>
                  <td>${escapeHtml(formatGrade(record.grade))}</td>
                  <td>${escapeHtml(formatClass(record.classNo))}</td>
                  <td>${escapeHtml(formatNumber(record.number))}</td>
                  <td class="teacher-student-name">${escapeHtml(record.name || '-')}</td>
                  <td>${escapeHtml(record.email)}</td>
                  <td>${record.selections.length}</td>
                  <td>${renderSelectionChips(record.selections)}</td>
                  <td>${escapeHtml(formatDateTime(record.timestamp))}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
  }

  const rows = sortAdminStudentRows(records);

  return `
    <section class="teacher-section">
      <div class="teacher-section-head"><h3>학생별 선택 현황</h3><span>${records.length}명</span></div>
      <div class="teacher-table-wrap">
        <table class="teacher-table teacher-student-table teacher-admin-student-table">
          <thead>
            <tr>
              <th class="stats-sortable" data-sort="grade">학년${adminSortArrow('grade')}</th>
              <th class="stats-sortable" data-sort="classNo">학급${adminSortArrow('classNo')}</th>
              <th class="stats-sortable" data-sort="number">번호${adminSortArrow('number')}</th>
              <th class="stats-sortable" data-sort="name">이름${adminSortArrow('name')}</th>
              ${ADMIN_TABLE_SEMESTERS.map(sem => `<th class="stats-sortable" data-sort="bucket::${escapeHtml(sem)}">${escapeHtml(sem)} 선택과목${adminSortArrow(`bucket::${sem}`)}</th>`).join('')}
              <th class="stats-sortable" data-sort="bucket::기타">기타 선택과목${adminSortArrow('bucket::기타')}</th>
              <th class="stats-sortable" data-sort="timestamp">저장 시각${adminSortArrow('timestamp')}</th>
              <th>관리</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length ? rows.map(({ record, buckets }) => `
              <tr>
                <td>${escapeHtml(record.grade || '-')}</td>
                <td>${escapeHtml(record.classNo || '-')}</td>
                <td>${escapeHtml(record.number || '-')}</td>
                <td class="teacher-student-name">${escapeHtml(record.name || '-')}</td>
                ${ADMIN_TABLE_SEMESTERS.map(sem => `<td>${renderBucketChips(buckets[sem])}</td>`).join('')}
                <td>${renderBucketChips(buckets['기타'])}</td>
                <td>${escapeHtml(formatDateTime(record.timestamp))}</td>
                <td>
                  <div style="display:flex;gap:4px;flex-wrap:nowrap;">
                    <button class="admin-edit-student-btn"
                      data-email="${escapeHtml(record.email)}"
                      type="button">수정</button>
                    <button class="admin-reset-student-btn"
                      data-email="${escapeHtml(record.email)}"
                      data-name="${escapeHtml(record.name || record.email)}"
                      type="button">초기화</button>
                    <button class="admin-delete-student-btn"
                      data-email="${escapeHtml(record.email)}"
                      data-name="${escapeHtml(record.name || record.email)}"
                      type="button">탈퇴</button>
                  </div>
                </td>
              </tr>`).join('')
              : `<tr><td colspan="${4 + ADMIN_TABLE_SEMESTERS.length + 3}" class="teacher-empty-cell">조건에 맞는 학생이 없습니다.</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>`;
}

function getTopCourses(records, limit) {
  return buildCourseStats(records).slice(0, limit).map(i => `${i.courseName} ${i.count}`);
}

function renderCourseChips(values) {
  if (!values.length) return '<span class="teacher-muted">-</span>';
  return `<div class="teacher-chip-list">${values.map(v => `<span class="teacher-chip">${escapeHtml(v)}</span>`).join('')}</div>`;
}

function renderSelectionChips(selections) {
  if (!selections.length) return '<span class="teacher-muted">-</span>';
  const groups = [];
  const map = new Map();
  for (const item of selections) {
    const sem = item.semester || '학기 미지정';
    if (!map.has(sem)) { const g = { semester: sem, items: [] }; map.set(sem, g); groups.push(g); }
    map.get(sem).items.push(item);
  }
  return `<div class="teacher-semester-selection">${groups.map(g => `
    <div class="teacher-selection-semester">
      <div class="teacher-selection-title">${escapeHtml(g.semester)}</div>
      <div class="teacher-chip-list">${g.items.map(i => `<span class="teacher-chip" title="${escapeHtml(i.group)}">${escapeHtml(i.courseName)}</span>`).join('')}</div>
    </div>`).join('')}</div>`;
}

// ── 유틸 ─────────────────────────────────────────────────

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b), 'ko'));
}
// 학년·학급·번호처럼 숫자로 된 값은 문자열 정렬(localeCompare)을 쓰면 "1, 10, 2, 3..."처럼
// 잘못 정렬된다(자리수가 다른 경우 앞자리만 비교하기 때문). 반드시 숫자로 변환해 비교해야 함.
function uniqueNumericSorted(values) {
  return [...new Set(values)].sort((a, b) => Number(a) - Number(b));
}
function normalizeSearch(value) {
  return String(value || '').replace(/\s/g, '').toLowerCase();
}
function formatGrade(v) { return v && v !== '-' ? `${v}학년` : '-'; }
function formatClass(v) { return v && v !== '-' ? `${Number(v)}반` : '-'; }
function formatNumber(v) { return v ? `${Number(v)}번` : '-'; }
function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ──────────────────────────────────────────────────────────
//  회원 관리 패널 (관리자 전용)
// ──────────────────────────────────────────────────────────

export function renderMemberPanel(container, {
  records = [],
  onApprove,
  onReject,
  onRemove,
  fetchRequests,
  directAddTeacher,
  fetchTeacherEmailsList,
  onAdminUpdateStudent,
  onAdminDeleteStudent,
  onRefresh,
  fetchStudentRequests,
  onAdminUpdateStudentRequest,
  onApproveStudent,
  onRejectStudent,
  onRemoveStudent,
  fetchStudentEmailsCount,
  bulkCreateAccounts,
  onUpdateStudentPortalUrl,
  onUpdateTeacherPortalUrl,
  onAdminResetPassword,
  onAdminUpdateTeacherProfile,
} = {}) {
  if (!container) return;

  // 로컬 복사본 (삭제 시 즉시 반영용)
  let localRecords = [...records];

  container.innerHTML = `
    <div class="teacher-wrap">
      <div class="teacher-header">
        <div>
          <h2>회원 관리</h2>
          <p class="teacher-desc">교사 및 학생 회원 가입 승인, 기초 정보 수정, 강퇴를 관리합니다.</p>
        </div>
        <button class="teacher-refresh-btn" id="memberRefreshBtn" type="button">새로고침</button>
      </div>

      <!-- 계정 일괄 생성 섹션 -->
      <div id="memberBulkSection"></div>

      <!-- 교사 관리 섹션 -->
      <section class="member-section" id="memberTeacherSection">
        <div class="member-section-head">
          <h3>교사 계정 관리 <span id="memberPendingBadge" hidden class="member-pending-badge">0</span></h3>
          <button class="member-section-toggle" id="memberTeacherToggle" type="button" aria-expanded="true">접기</button>
        </div>
        <div class="member-section-body" id="memberTeacherSectionBody">
          <div class="member-add-form" id="memberTeacherAddForm">
            <input id="memberTeacherEmailInput" type="email" placeholder="추가할 교사 이메일 입력">
            <button class="member-add-btn" id="memberTeacherAddBtn" type="button">교사 직접 추가</button>
            <span class="member-add-msg" id="memberTeacherAddMsg"></span>
          </div>
          <div id="memberTeacherBody"><div class="member-empty">교사 목록 불러오는 중...</div></div>
        </div>
      </section>

      <!-- 학생 관리 섹션 -->
      <section class="member-section" id="memberStudentRequestsSection">
        <div class="member-section-head">
          <h3>학생 관리 <span id="memberStudentPendingBadge" hidden class="member-pending-badge">0</span></h3>
          <button class="member-section-toggle" id="memberStudentRequestsToggle" type="button" aria-expanded="true">접기</button>
        </div>
        <div class="member-section-body" id="memberStudentRequestsSectionBody">
          <div class="teacher-filter-bar" id="memberReqFilterBar" style="padding:10px 18px; border-bottom:1px solid var(--line);">
            <label class="teacher-filter-field">
              <span>학년</span>
              <select id="memberReqGradeFilter"><option value="">전체</option></select>
            </label>
            <label class="teacher-filter-field">
              <span>반</span>
              <select id="memberReqClassFilter"><option value="">전체</option></select>
            </label>
            <label class="teacher-filter-field">
              <span>번호</span>
              <select id="memberReqNumberFilter"><option value="">전체</option></select>
            </label>
            <label class="teacher-filter-field teacher-search-field">
              <span>이름</span>
              <input id="memberReqNameFilter" type="search" placeholder="이름 검색">
            </label>
          </div>
          <div id="memberStudentRequestsBody"><div class="member-empty">학생 신청 목록 불러오는 중...</div></div>
        </div>
      </section>

      <!-- 학생 관리 섹션 -->
      <section class="member-section" id="memberStudentSection">
        <div class="member-section-head">
          <h3>학생 목록</h3>
        </div>
        <div class="teacher-filter-bar" style="padding:10px 18px; border-bottom:1px solid var(--line);">
          <label class="teacher-filter-field">
            <span>학년</span>
            <select id="memberGradeFilter"></select>
          </label>
          <label class="teacher-filter-field">
            <span>학급</span>
            <select id="memberClassFilter"></select>
          </label>
          <label class="teacher-filter-field teacher-search-field">
            <span>검색</span>
            <input id="memberStudentSearch" type="search" placeholder="이름, 이메일, 번호 검색">
          </label>
        </div>
        <div id="memberStudentBody"></div>
      </section>
    </div>
  `;

  container.querySelector('#memberRefreshBtn')?.addEventListener('click', () => onRefresh?.());

  // ── 섹션 접기/펼치기 ──
  setupMemberSectionToggle(container, 'memberTeacherToggle', 'memberTeacherSection');
  setupMemberSectionToggle(container, 'memberStudentRequestsToggle', 'memberStudentRequestsSection');

  // ── 계정 일괄 생성 ──
  renderBulkAccountsSection(container.querySelector('#memberBulkSection'), {
    fetchTeacherEmailsList,
    fetchStudentEmailsCount,
    bulkCreateAccounts,
    onApplied: onRefresh,
  });

  // ── 교사 관리 ──
  setupTeacherAddForm(container, directAddTeacher, fetchTeacherEmailsList, fetchRequests, onApprove, onReject, onRemove);
  loadTeacherMemberList(container, fetchTeacherEmailsList, fetchRequests, onApprove, onReject, onRemove, onUpdateTeacherPortalUrl, onAdminUpdateTeacherProfile, onAdminResetPassword);

  // ── 학생 관리(가입 신청/승인 상태) ──
  loadStudentRequestsPanel(container, {
    fetchStudentRequests,
    onApproveStudent,
    onRejectStudent,
    onRemoveStudent,
    onAdminUpdateStudentRequest,
    onAdminResetPassword,
    onRefresh,
  });

  // ── 학생 관리 ──
  // ⚠ 서버 삭제(onAdminDeleteStudent)가 끝나기 전에 화면에서 먼저 지우면 안 된다.
  //  과거에는 await 없이 호출해서, Supabase가 실제로는 실패(RLS 등)해도 에러가 조용히
  //  버려지고 화면에서는 바로 사라져 "성공한 것처럼" 보였다. 새로고침하면 DB에는 그대로
  //  남아 있어 다시 나타나는 문제가 이래서 생겼음 — 반드시 await 후 성공한 경우에만
  //  localRecords에서 제거한다. 실패하면 setupStudentMemberSection의 catch가 alert로 알림.
  setupStudentMemberSection(container, localRecords, onAdminUpdateStudent, async (email) => {
    await onAdminDeleteStudent?.(email);
    localRecords = localRecords.filter(r => r.email !== email);
    renderStudentMemberTable(container, localRecords);
  }, onUpdateStudentPortalUrl, onAdminResetPassword);
}

// ── 섹션 접기/펼치기 (교사 계정 관리 / 학생 가입 신청 관리 상자) ──
function setupMemberSectionToggle(container, btnId, sectionId) {
  const btn = container.querySelector(`#${btnId}`);
  const section = container.querySelector(`#${sectionId}`);
  if (!btn || !section) return;
  btn.addEventListener('click', () => {
    const isCollapsed = section.classList.toggle('collapsed');
    btn.textContent = isCollapsed ? '펼치기' : '접기';
    btn.setAttribute('aria-expanded', String(!isCollapsed));
  });
}

// ── 교사 직접 추가 폼 ──
function setupTeacherAddForm(container, directAddTeacher, fetchTeacherEmailsList, fetchRequests, onApprove, onReject, onRemove) {
  const input = container.querySelector('#memberTeacherEmailInput');
  const btn   = container.querySelector('#memberTeacherAddBtn');
  const msg   = container.querySelector('#memberTeacherAddMsg');
  if (!input || !btn) return;

  async function doAdd() {
    const email = input.value.trim();
    if (!email) { showMsg('이메일을 입력해 주세요.', false); return; }
    btn.disabled = true; btn.textContent = '추가 중...';
    try {
      await directAddTeacher?.(email);
      input.value = '';
      showMsg(`✅ ${email} 교사로 추가됐습니다.`, true);
      loadTeacherMemberList(container, fetchTeacherEmailsList, fetchRequests, onApprove, onReject, onRemove);
    } catch (err) {
      showMsg(`❌ ${err.message}`, false);
    } finally {
      btn.disabled = false; btn.textContent = '교사 직접 추가';
    }
  }

  btn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });

  function showMsg(text, ok) {
    if (!msg) return;
    msg.textContent = text;
    msg.className = 'member-add-msg ' + (ok ? 'ok' : 'err');
    setTimeout(() => { msg.textContent = ''; msg.className = 'member-add-msg'; }, 4000);
  }
}

// ── 교사 목록 로드 & 렌더 ──
async function loadTeacherMemberList(container, fetchTeacherEmailsList, fetchRequests, onApprove, onReject, onRemove, onUpdateTeacherPortalUrl, onAdminUpdateTeacherProfile, onAdminResetPassword) {
  const body = container.querySelector('#memberTeacherBody');
  const badge = container.querySelector('#memberPendingBadge');
  if (!body) return;
  body.innerHTML = '<div class="member-empty">불러오는 중...</div>';

  try {
    const [emails, requests] = await Promise.all([
      fetchTeacherEmailsList?.() ?? [],
      fetchRequests?.() ?? [],
    ]);

    const pending  = requests.filter(r => r.status === 'pending');
    const approved = requests.filter(r => r.status === 'approved');
    const rejected = requests.filter(r => r.status === 'rejected');
    const approvedEmails = new Set(approved.map(r => (r.email || '').toLowerCase()));

    // teacher_emails에는 있지만 approved 신청 없는 직접 추가 교사
    const directTeachers = emails.filter(e => !approvedEmails.has(e.toLowerCase()));

    if (badge) {
      badge.hidden = pending.length === 0;
      badge.textContent = pending.length;
    }

    body.innerHTML = renderTeacherMemberRows(pending, approved, rejected, directTeachers);

    // 이벤트 바인딩 — body 엘리먼트 자체는 reload마다 재사용되므로(innerHTML만 교체),
    // 리스너를 매번 새로 addEventListener하면 누적되어 클릭마다 중복 실행된다.
    // data-bound 플래그로 이 body에는 단 한 번만 바인딩한다(예전의 {once:true}는 첫 클릭
    // 직후 무조건 해제되어 버려 — 클래스명 매칭 버그와 겹쳐 모든 버튼이 죽은 것처럼 보였음).
    if (!body.dataset.bound) {
      body.dataset.bound = '1';
      body.addEventListener('click', async e => {
        const row = e.target.closest('tr[data-id], tr[data-email]');
        const id    = row?.dataset.id;
        const email = row?.dataset.email;
        const name  = row?.dataset.name || email;

        if (e.target.matches('.member-action-btn.approve')) {
          if (!confirm(`${name}(${email})을 교사로 승인합니까?`)) return;
          e.target.disabled = true; e.target.textContent = '처리 중...';
          try { await onApprove?.(id, email, name); await reload(); }
          catch (err) { alert(`승인 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '승인'; }
        }
        if (e.target.matches('.member-action-btn.reject')) {
          if (!confirm(`${name}(${email}) 신청을 거부합니까?`)) return;
          e.target.disabled = true; e.target.textContent = '처리 중...';
          try { await onReject?.(id); await reload(); }
          catch (err) { alert(`거부 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '거부'; }
        }
        if (e.target.matches('.member-action-btn.remove')) {
          if (!confirm(`${name}(${email})의 교사 권한을 해제합니까?`)) return;
          e.target.disabled = true; e.target.textContent = '처리 중...';
          try {
            await onRemove?.(email);
            if (id) await onReject?.(id);
            await reload();
          } catch (err) { alert(`해제 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '해제'; }
        }
        if (e.target.matches('.member-action-btn.url')) {
          const current = row?.dataset.url || '';
          const next = window.prompt(`${name}(${email})의 수강신청 바로가기 URL을 입력하세요.\n(비우고 확인하면 URL이 삭제됩니다)`, current);
          if (next === null) return; // 취소
          e.target.disabled = true; e.target.textContent = '저장 중...';
          try { await onUpdateTeacherPortalUrl?.(email, next.trim()); await reload(); }
          catch (err) { alert(`URL 저장 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '수정'; }
        }
        if (e.target.matches('.member-action-btn.edit')) {
          if (!row) return;
          const record = {
            email,
            name: row.dataset.name || '',
            subjectArea: row.dataset.subject || '',
            homeroomGrade: row.dataset.homeroomGrade || '',
            homeroomClass: row.dataset.homeroomClass || '',
            portalUrl: row.dataset.url || '',
          };
          showAdminEditTeacherModal(record, onAdminUpdateTeacherProfile, onAdminResetPassword, reload);
        }
      });
    }

  } catch (err) {
    body.innerHTML = `<div class="member-empty" style="color:var(--accent)">교사 목록 로드 실패: ${escapeHtml(err.message)}</div>`;
  }

  async function reload() {
    await loadTeacherMemberList(container, fetchTeacherEmailsList, fetchRequests, onApprove, onReject, onRemove, onUpdateTeacherPortalUrl, onAdminUpdateTeacherProfile, onAdminResetPassword);
  }
}

/** URL 열 셀 — 값이 있으면 "열기" 링크 + "수정" 버튼, 없으면 "미설정" + "수정" 버튼 */
function renderPortalUrlCell(email, name, portalUrl) {
  const link = portalUrl
    ? `<a href="${escapeHtml(portalUrl)}" target="_blank" rel="noopener" class="member-url-link">열기</a>`
    : `<span class="member-url-empty">미설정</span>`;
  return `${link} <button class="member-action-btn url" type="button">수정</button>`;
}

function renderTeacherMemberRows(pending, approved, rejected, directTeachers) {
  const rows = [];

  // 대기 중 신청
  if (pending.length) {
    rows.push(`<tr><td colspan="6" style="padding:8px 12px;background:#fff8f5;font-size:0.8rem;font-weight:900;color:var(--accent)">▸ 승인 대기 (${pending.length}건)</td></tr>`);
    rows.push(...pending.map(r => `
      <tr data-id="${escapeHtml(r.id)}" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}" data-url="${escapeHtml(r.portal_url || '')}">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.message || '-')}</td>
        <td>${escapeHtml(formatDate(r.created_at))}</td>
        <td>${renderPortalUrlCell(r.email, r.name, r.portal_url)}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="member-action-btn approve" type="button">승인</button>
          <button class="member-action-btn reject"  type="button">거부</button>
        </td>
      </tr>`));
  }

  // 승인된 교사 (신청 경로)
  if (approved.length) {
    rows.push(`<tr><td colspan="6" style="padding:8px 12px;background:#f0faf5;font-size:0.8rem;font-weight:900;color:var(--primary)">▸ 승인된 교사 (${approved.length}명)</td></tr>`);
    rows.push(...approved.map(r => `
      <tr data-id="${escapeHtml(r.id)}" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}" data-url="${escapeHtml(r.portal_url || '')}" data-subject="${escapeHtml(r.subject_area || '')}" data-homeroom-grade="${escapeHtml(r.homeroom_grade || '')}" data-homeroom-class="${escapeHtml(r.homeroom_class || '')}">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td></td>
        <td>${escapeHtml(formatDate(r.reviewed_at))}</td>
        <td>${renderPortalUrlCell(r.email, r.name, r.portal_url)}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="member-action-btn edit" type="button">수정</button>
          <button class="member-action-btn remove" type="button">해제</button>
        </td>
      </tr>`));
  }

  // 직접 추가된 교사
  if (directTeachers.length) {
    rows.push(`<tr><td colspan="6" style="padding:8px 12px;background:#f0f4ff;font-size:0.8rem;font-weight:900;color:var(--blue)">▸ 직접 추가 교사 (${directTeachers.length}명)</td></tr>`);
    rows.push(...directTeachers.map(email => `
      <tr data-email="${escapeHtml(email)}" data-name="${escapeHtml(email)}" data-url="" data-subject="" data-homeroom-grade="" data-homeroom-class="">
        <td><span class="member-badge-direct">직접</span></td>
        <td>${escapeHtml(email)}</td>
        <td></td>
        <td>-</td>
        <td>${renderPortalUrlCell(email, email, '')}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="member-action-btn edit" type="button">수정</button>
          <button class="member-action-btn remove" type="button">해제</button>
        </td>
      </tr>`));
  }

  // 거부된 신청 (접기)
  if (rejected.length) {
    const rejectedRows = rejected.map(r => `
      <tr data-id="${escapeHtml(r.id)}" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name)}" data-url="${escapeHtml(r.portal_url || '')}">
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.message || '-')}</td>
        <td>${escapeHtml(formatDate(r.reviewed_at))}</td>
        <td>${renderPortalUrlCell(r.email, r.name, r.portal_url)}</td>
        <td><button class="member-action-btn approve" type="button">재승인</button></td>
      </tr>`).join('');

    rows.push(`<tr><td colspan="6" style="padding:8px 12px;background:#fafafa;font-size:0.8rem;font-weight:900;color:var(--muted)">
      <details class="member-details"><summary>▸ 거부된 신청 (${rejected.length}건)</summary></details>
    </td></tr>`);
    // 거부는 details 내부가 아니라 단순 행으로 처리 (table 안에서 details 한계)
    // → 초기 hidden 처리
  }

  if (!rows.length) {
    return '<div class="member-empty">등록된 교사가 없습니다.</div>';
  }

  return `
    <div class="member-table-wrap">
      <table class="member-table member-table-centered">
        <thead><tr><th>이름</th><th>이메일</th><th>메모/교과</th><th>일시</th><th>URL</th><th>처리</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

// ── 학생 관리 (회원가입 승인제) ──
async function loadStudentRequestsPanel(container, {
  fetchStudentRequests,
  onApproveStudent,
  onRejectStudent,
  onRemoveStudent,
  onAdminUpdateStudentRequest,
  onAdminResetPassword,
  onRefresh,
}) {
  const body  = container.querySelector('#memberStudentRequestsBody');
  const badge = container.querySelector('#memberStudentPendingBadge');
  if (!body) return;
  body.innerHTML = '<div class="member-empty">불러오는 중...</div>';

  let requests = [];
  try {
    requests = await (fetchStudentRequests?.() ?? []);
  } catch (err) {
    body.innerHTML = `<div class="member-empty" style="color:var(--accent)">학생 신청 목록 로드 실패: ${escapeHtml(err.message)}</div>`;
    return;
  }

  function renderBody() {
    const pending  = requests.filter(r => r.status === 'pending');
    const approved = requests.filter(r => r.status === 'approved');
    const rejected = requests.filter(r => r.status === 'rejected');

    if (badge) {
      badge.hidden = pending.length === 0;
      badge.textContent = pending.length;
    }

    body.innerHTML = renderStudentRequestRows(
      filterStudentRequests(pending),
      filterStudentRequests(approved),
      filterStudentRequests(rejected),
    );
  }

  // 필터 select/입력 셋업은 재조회할 때마다(승인/거부/해제 후) 다시 해도 되지만, 선택된
  // 필터 값 자체는 모듈 상태(_memberReqFilter*)에 남아 있으므로 재렌더에도 유지된다.
  setupStudentRequestFilterBar(container, requests, renderBody);
  _memberReqRerender = renderBody;
  renderBody();

  // 교사 패널과 동일한 이유로 data-bound 가드를 사용 (아래 loadTeacherMemberList 주석 참고)
  if (!body.dataset.bound) {
    body.dataset.bound = '1';
    body.addEventListener('click', async e => {
      // 학년/반/번호/이름 헤더 클릭 정렬
      const sortTh = e.target.closest('.stats-sortable');
      if (sortTh) {
        const key = sortTh.dataset.sort;
        if (_memberReqSortKey === key) {
          _memberReqSortDir = _memberReqSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _memberReqSortKey = key;
          _memberReqSortDir = 'asc';
        }
        _memberReqRerender?.();
        return;
      }

      const row = e.target.closest('tr[data-id], tr[data-email]');
      const id    = row?.dataset.id;
      const email = row?.dataset.email;
      const name  = row?.dataset.name || email;

      if (e.target.matches('.member-action-btn.edit-student-request')) {
        if (!row) return;
        showAdminEditStudentRequestModal({
          id,
          email,
          name: row.dataset.name || '',
          grade: row.dataset.grade || '',
          classNo: row.dataset.classNo || '',
          number: row.dataset.number || '',
          status: row.dataset.status || '',
        }, onAdminUpdateStudentRequest, onAdminResetPassword, async () => {
          await reload();
          await onRefresh?.();
        });
        return;
      }
      if (e.target.matches('.member-action-btn.approve')) {
        if (!confirm(`${name}(${email})을 학생으로 승인합니까?`)) return;
        e.target.disabled = true; e.target.textContent = '처리 중...';
        try { await onApproveStudent?.(id, email); await reload(); }
        catch (err) { alert(`승인 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '승인'; }
      }
      if (e.target.matches('.member-action-btn.reject')) {
        if (!confirm(`${name}(${email}) 신청을 거부합니까?`)) return;
        e.target.disabled = true; e.target.textContent = '처리 중...';
        try { await onRejectStudent?.(id); await reload(); }
        catch (err) { alert(`거부 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '거부'; }
      }
      if (e.target.matches('.member-action-btn.remove')) {
        if (!confirm(`${name}(${email})의 학생 권한을 해제합니까?`)) return;
        e.target.disabled = true; e.target.textContent = '처리 중...';
        try { await onRemoveStudent?.(email); await reload(); }
        catch (err) { alert(`해제 실패: ${err.message}`); e.target.disabled = false; e.target.textContent = '해제'; }
      }
    });
  }

  async function reload() {
    await loadStudentRequestsPanel(container, {
      fetchStudentRequests,
      onApproveStudent,
      onRejectStudent,
      onRemoveStudent,
      onAdminUpdateStudentRequest,
      onAdminResetPassword,
      onRefresh,
    });
  }
}

function showAdminEditStudentRequestModal(record, updateRequestFn, resetPasswordFn, onSaved) {
  document.getElementById('adminEditStudentRequestModal')?.remove();
  const canResetPassword = record.status === 'approved';
  const modal = document.createElement('div');
  modal.id = 'adminEditStudentRequestModal';
  modal.className = 'modal-overlay visible';
  modal.innerHTML = `
    <div class="modal-card admin-edit-modal">
      <h2>학생 기본 정보 수정</h2>
      <p class="modal-desc">${escapeHtml(record.email)}</p>

      <div class="admin-edit-grid">
        <div class="modal-field">
          <label>이름 <span class="req">*</span></label>
          <input id="srName" type="text" value="${escapeHtml(record.name || '')}" placeholder="홍길동">
        </div>
        <div class="modal-field">
          <label>학년 <span class="req">*</span></label>
          <select id="srGrade">
            <option value="">선택</option>
            ${['1','2','3'].map(g => `<option value="${g}" ${record.grade === g ? 'selected' : ''}>${g}학년</option>`).join('')}
          </select>
        </div>
        <div class="modal-field">
          <label>반 <span class="req">*</span></label>
          <input id="srClass" type="number" min="1" max="20" value="${escapeHtml(record.classNo || '')}" placeholder="1">
        </div>
        <div class="modal-field">
          <label>번호 <span class="req">*</span></label>
          <input id="srNumber" type="number" min="1" max="50" value="${escapeHtml(record.number || '')}" placeholder="1">
        </div>
        <div class="modal-field">
          <label>새 비밀번호</label>
          <input id="srPassword" type="password" ${canResetPassword ? '' : 'disabled'} placeholder="${canResetPassword ? '변경하지 않으려면 비워두세요' : '승인된 학생만 발급 가능'}" autocomplete="new-password">
        </div>
      </div>

      <div class="modal-msg" id="srMsg"></div>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" id="srCloseBtn" type="button">취소</button>
        <button class="modal-btn modal-btn-submit" id="srSaveBtn" type="button">저장</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelector('#srCloseBtn').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#srSaveBtn').addEventListener('click', async () => {
    const msgEl = modal.querySelector('#srMsg');
    const name = modal.querySelector('#srName').value.trim();
    const grade = modal.querySelector('#srGrade').value;
    const classNo = modal.querySelector('#srClass').value.trim();
    const number = modal.querySelector('#srNumber').value.trim();
    const newPassword = modal.querySelector('#srPassword').value;

    if (!name || !grade || !classNo || !number) {
      msgEl.textContent = '모든 항목을 입력해 주세요.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && !canResetPassword) {
      msgEl.textContent = '승인된 학생만 새 비밀번호를 발급할 수 있습니다.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && newPassword.length < 6) {
      msgEl.textContent = '비밀번호는 6자 이상이어야 합니다.'; msgEl.className = 'modal-msg error'; return;
    }
    if (!updateRequestFn) {
      msgEl.textContent = '학생 정보 수정 기능을 사용할 수 없습니다.'; msgEl.className = 'modal-msg error'; return;
    }
    if (newPassword && !resetPasswordFn) {
      msgEl.textContent = '비밀번호 변경 기능을 사용할 수 없습니다.'; msgEl.className = 'modal-msg error'; return;
    }

    const saveBtn = modal.querySelector('#srSaveBtn');
    saveBtn.disabled = true; saveBtn.textContent = '저장 중...';
    msgEl.textContent = ''; msgEl.className = 'modal-msg';
    try {
      await updateRequestFn(record.id, record.email, { name, grade, classNo, number });
      if (newPassword) await resetPasswordFn(record.email, newPassword);
      msgEl.textContent = newPassword ? '정보와 비밀번호가 저장됐습니다.' : '저장됐습니다.';
      msgEl.className = 'modal-msg success';
      setTimeout(async () => { modal.remove(); await onSaved?.(); }, 800);
    } catch (err) {
      msgEl.textContent = `저장 실패: ${err.message}`; msgEl.className = 'modal-msg error';
      saveBtn.disabled = false; saveBtn.textContent = '저장';
    }
  });
}

// 학년/반/번호 드롭다운 + 이름 검색 입력 — 값은 모듈 상태(_memberReqFilter*)에 저장해
// 승인/거부 등으로 목록을 다시 불러온 뒤에도(loadStudentRequestsPanel 재호출) 유지되게 한다.
function setupStudentRequestFilterBar(container, requests, renderBody) {
  const gradeSelect  = container.querySelector('#memberReqGradeFilter');
  const classSelect  = container.querySelector('#memberReqClassFilter');
  const numberSelect = container.querySelector('#memberReqNumberFilter');
  const nameInput    = container.querySelector('#memberReqNameFilter');
  if (!gradeSelect || !classSelect || !numberSelect || !nameInput) return;

  const hasValue = v => v !== null && v !== undefined && v !== '';
  const numericOptions = values => [...new Set(values.filter(hasValue).map(v => String(v)))]
    .sort((a, b) => Number(a) - Number(b));

  const grades  = numericOptions(requests.map(r => r.grade));
  const classes = numericOptions(requests.map(r => r.class_no));
  const numbers = numericOptions(requests.map(r => r.number));

  gradeSelect.innerHTML  = `<option value="">전체</option>${grades.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(String(Number(g)))}</option>`).join('')}`;
  classSelect.innerHTML  = `<option value="">전체</option>${classes.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(String(Number(c)))}</option>`).join('')}`;
  numberSelect.innerHTML = `<option value="">전체</option>${numbers.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(String(Number(n)))}</option>`).join('')}`;

  gradeSelect.value  = _memberReqFilterGrade;
  classSelect.value  = _memberReqFilterClass;
  numberSelect.value = _memberReqFilterNumber;
  nameInput.value    = _memberReqFilterName;

  if (!gradeSelect.dataset.bound) {
    gradeSelect.dataset.bound  = '1';
    classSelect.dataset.bound  = '1';
    numberSelect.dataset.bound = '1';
    nameInput.dataset.bound    = '1';
    gradeSelect.addEventListener('change', () => { _memberReqFilterGrade  = gradeSelect.value;  _memberReqRerender?.(); });
    classSelect.addEventListener('change', () => { _memberReqFilterClass  = classSelect.value;  _memberReqRerender?.(); });
    numberSelect.addEventListener('change', () => { _memberReqFilterNumber = numberSelect.value; _memberReqRerender?.(); });
    nameInput.addEventListener('input',    () => { _memberReqFilterName   = nameInput.value;     _memberReqRerender?.(); });
  }
}

function filterStudentRequests(requests) {
  const grade   = _memberReqFilterGrade;
  const classNo = _memberReqFilterClass;
  const number  = _memberReqFilterNumber;
  const name    = normalizeSearch(_memberReqFilterName);
  return requests.filter(r => {
    if (grade   && String(r.grade)   !== grade)   return false;
    if (classNo && String(r.class_no) !== classNo) return false;
    if (number  && String(r.number)   !== number)  return false;
    if (name && !normalizeSearch(r.name).includes(name)) return false;
    return true;
  });
}

function memberReqSortArrow(key) {
  if (_memberReqSortKey !== key) return '';
  return _memberReqSortDir === 'asc' ? ' ▲' : ' ▼';
}

function sortStudentRequestRows(rows) {
  if (!_memberReqSortKey) return rows;
  const dir = _memberReqSortDir === 'asc' ? 1 : -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let av, bv;
    switch (_memberReqSortKey) {
      case 'grade':   av = Number(a.grade) || 0; bv = Number(b.grade) || 0; break;
      case 'classNo': av = Number(a.class_no) || 0; bv = Number(b.class_no) || 0; break;
      case 'number':  av = Number(a.number) || 0; bv = Number(b.number) || 0; break;
      case 'name':    av = a.name || ''; bv = b.name || ''; break;
      default:        av = ''; bv = '';
    }
    if (typeof av === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv), 'ko') * dir;
  });
  return sorted;
}

function renderStudentRequestNumberCell(value) {
  return value !== null && value !== undefined && value !== '' ? escapeHtml(String(Number(value))) : '-';
}

function renderStudentRequestRows(pending, approved, rejected) {
  pending  = sortStudentRequestRows(pending);
  approved = sortStudentRequestRows(approved);
  rejected = sortStudentRequestRows(rejected);

  const rows = [];
  const rowAttrs = r => [
    `data-id="${escapeHtml(r.id)}"`,
    `data-email="${escapeHtml(r.email)}"`,
    `data-name="${escapeHtml(r.name)}"`,
    `data-grade="${escapeHtml(r.grade || '')}"`,
    `data-class-no="${escapeHtml(r.class_no || '')}"`,
    `data-number="${escapeHtml(r.number || '')}"`,
    `data-status="${escapeHtml(r.status || '')}"`,
  ].join(' ');

  if (pending.length) {
    rows.push(`<tr><td colspan="7" style="padding:8px 12px;background:#fff8f5;font-size:0.8rem;font-weight:900;color:var(--accent)">▸ 승인 대기 (${pending.length}건)</td></tr>`);
    rows.push(...pending.map(r => `
      <tr ${rowAttrs(r)}>
        <td>${renderStudentRequestNumberCell(r.grade)}</td>
        <td>${renderStudentRequestNumberCell(r.class_no)}</td>
        <td>${renderStudentRequestNumberCell(r.number)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(formatDate(r.created_at))}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="member-action-btn edit-student-request" type="button">수정</button>
          <button class="member-action-btn approve" type="button">승인</button>
          <button class="member-action-btn reject"  type="button">거부</button>
        </td>
      </tr>`));
  }

  if (approved.length) {
    rows.push(`<tr><td colspan="7" style="padding:8px 12px;background:#f0faf5;font-size:0.8rem;font-weight:900;color:var(--primary)">▸ 승인된 학생 (${approved.length}명)</td></tr>`);
    rows.push(...approved.map(r => `
      <tr ${rowAttrs(r)}>
        <td>${renderStudentRequestNumberCell(r.grade)}</td>
        <td>${renderStudentRequestNumberCell(r.class_no)}</td>
        <td>${renderStudentRequestNumberCell(r.number)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(formatDate(r.reviewed_at))}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="member-action-btn edit-student-request" type="button">수정</button>
          <button class="member-action-btn remove" type="button">해제</button>
        </td>
      </tr>`));
  }

  if (rejected.length) {
    rows.push(`<tr><td colspan="7" style="padding:8px 12px;background:#fafafa;font-size:0.8rem;font-weight:900;color:var(--muted)">▸ 거부된 신청 (${rejected.length}건)</td></tr>`);
    rows.push(...rejected.map(r => `
      <tr ${rowAttrs(r)}>
        <td>${renderStudentRequestNumberCell(r.grade)}</td>
        <td>${renderStudentRequestNumberCell(r.class_no)}</td>
        <td>${renderStudentRequestNumberCell(r.number)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(formatDate(r.reviewed_at))}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="member-action-btn edit-student-request" type="button">수정</button>
          <button class="member-action-btn approve" type="button">재승인</button>
        </td>
      </tr>`));
  }

  if (!rows.length) {
    return '<div class="member-empty">조건에 맞는 학생이 없습니다.</div>';
  }

  return `
    <div class="member-table-wrap">
      <table class="member-table member-table-centered">
        <thead><tr>
          <th class="stats-sortable" data-sort="grade">학년${memberReqSortArrow('grade')}</th>
          <th class="stats-sortable" data-sort="classNo">반${memberReqSortArrow('classNo')}</th>
          <th class="stats-sortable" data-sort="number">번호${memberReqSortArrow('number')}</th>
          <th class="stats-sortable" data-sort="name">이름${memberReqSortArrow('name')}</th>
          <th>이메일</th>
          <th>일시</th>
          <th>처리</th>
        </tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>`;
}

// ── 학생 관리 섹션 ──
function setupStudentMemberSection(container, records, onEditStudent, onDeleteStudent, onUpdateStudentPortalUrl, onResetPassword) {
  // 필터 초기화
  const gradeSelect = container.querySelector('#memberGradeFilter');
  const classSelect = container.querySelector('#memberClassFilter');
  const searchInput = container.querySelector('#memberStudentSearch');

  const grades = [...new Set(records.map(r => r.grade).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ko'));
  if (gradeSelect) {
    gradeSelect.innerHTML = `<option value="">전체 학년</option>${grades.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}학년</option>`).join('')}`;
    gradeSelect.addEventListener('change', () => { updateClassFilter(); renderStudentMemberTable(container, records, getFilter()); });
  }

  function updateClassFilter() {
    const grade = gradeSelect?.value || '';
    const classes = [...new Set(records.filter(r => !grade || r.grade === grade).map(r => r.classNo).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
    if (classSelect) classSelect.innerHTML = `<option value="">전체 학급</option>${classes.map(c => `<option value="${escapeHtml(c)}">${Number(c)}반</option>`).join('')}`;
  }
  updateClassFilter();
  classSelect?.addEventListener('change', () => renderStudentMemberTable(container, records, getFilter()));
  searchInput?.addEventListener('input',   () => renderStudentMemberTable(container, records, getFilter()));

  function getFilter() {
    return {
      grade: gradeSelect?.value || '',
      classNo: classSelect?.value || '',
      query: normalizeSearch(searchInput?.value || ''),
    };
  }

  renderStudentMemberTable(container, records);

  // 이벤트 위임 (편집/강퇴/URL 수정)
  const body = container.querySelector('#memberStudentBody');
  body?.addEventListener('click', async e => {
    const editBtn   = e.target.closest('.member-action-btn.edit');
    const deleteBtn = e.target.closest('.member-action-btn.remove');
    const urlBtn    = e.target.closest('.member-action-btn.url');

    if (editBtn) {
      const email = editBtn.dataset.email;
      const record = records.find(r => r.email === email);
      if (record) showAdminEditModal(record, onEditStudent, onResetPassword);
    }
    if (deleteBtn) {
      const email = deleteBtn.dataset.email;
      const name  = deleteBtn.dataset.name;
      if (!confirm(`[강퇴] ${name}(${email})\n\n이 학생의 과목 선택 데이터를 삭제하고 로그인 권한도 회수합니다(다시 가입 신청해야 함). 계속하시겠습니까?`)) return;
      deleteBtn.disabled = true; deleteBtn.textContent = '처리 중...';
      try {
        await onDeleteStudent?.(email);
      } catch (err) {
        alert(`강퇴 실패: ${err.message}`);
        deleteBtn.disabled = false; deleteBtn.textContent = '강퇴';
      }
    }
    if (urlBtn) {
      const email = urlBtn.dataset.email;
      const name  = urlBtn.dataset.name || email;
      const record = records.find(r => r.email === email);
      const current = record?.portalUrl || '';
      const next = window.prompt(`${name}(${email})의 수강신청 바로가기 URL을 입력하세요.\n(비우고 확인하면 URL이 삭제됩니다)`, current);
      if (next === null) return; // 취소
      urlBtn.disabled = true; urlBtn.textContent = '저장 중...';
      try {
        await onUpdateStudentPortalUrl?.(email, next.trim());
        if (record) record.portalUrl = next.trim();
        renderStudentMemberTable(container, records, getFilter());
      } catch (err) {
        alert(`URL 저장 실패: ${err.message}`);
        urlBtn.disabled = false; urlBtn.textContent = '수정';
      }
    }
  });
}

function renderStudentMemberTable(container, records, filter = {}) {
  const body = container.querySelector('#memberStudentBody');
  if (!body) return;

  const { grade = '', classNo = '', query = '' } = filter;
  const filtered = records.filter(r => {
    if (grade   && r.grade   !== grade)   return false;
    if (classNo && r.classNo !== classNo) return false;
    if (query) {
      const text = normalizeSearch(`${r.name}${r.email}${r.number}${r.grade}${r.classNo}`);
      if (!text.includes(query)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    body.innerHTML = '<div class="member-empty">조건에 맞는 학생이 없습니다.</div>';
    return;
  }

  const rows = filtered.map(r => `
    <tr>
      <td>${escapeHtml(r.grade ? r.grade + '학년' : '-')}</td>
      <td>${escapeHtml(r.classNo ? Number(r.classNo) + '반' : '-')}</td>
      <td>${escapeHtml(r.number ? Number(r.number) + '번' : '-')}</td>
      <td><strong>${escapeHtml(r.name || '-')}</strong></td>
      <td>${escapeHtml(r.email || '-')}</td>
      <td>${r.portalUrl
          ? `<a href="${escapeHtml(r.portalUrl)}" target="_blank" rel="noopener" class="member-url-link">열기</a>`
          : `<span class="member-url-empty">미설정</span>`}
        <button class="member-action-btn url" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name || r.email)}" type="button">수정</button></td>
      <td style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="member-action-btn edit"   data-email="${escapeHtml(r.email)}" type="button">수정</button>
        <button class="member-action-btn remove" data-email="${escapeHtml(r.email)}" data-name="${escapeHtml(r.name || r.email)}" type="button">강퇴</button>
      </td>
    </tr>`).join('');

  body.innerHTML = `
    <div class="member-table-wrap">
      <table class="member-table">
        <thead><tr><th>학년</th><th>반</th><th>번호</th><th>이름</th><th>이메일</th><th>URL</th><th>처리</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="padding:8px 18px;font-size:0.78rem;color:var(--muted)">총 ${filtered.length}명</div>`;
}
