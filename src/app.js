import { initAuth, signOut, requestAccessToken, updateMyPassword, updateMyDisplayName } from './auth.js';
import {
  fetchSemesterCourses,
  fetchUniversityRecommendations,
  fetchSeriesMatrix,
  fetchSubjectExamples,
  fetchLinks,
  fetchConfig,
  saveAppSettings,
  fetchTeacherEmails,
  fetchStudentSelections,
  fetchStudentSelection,
  fetchTeacherRequests,
  directAddTeacherEmail,
  approveTeacherRequest,
  rejectTeacherRequest,
  removeTeacherEmail,
  submitTeacherRequest,
  adminUpdateStudent,
  adminUpdateStudentRequestInfo,
  adminBulkUpdateStudentSelections,
  adminUpdateStudentPortalUrl,
  adminUpdateTeacherPortalUrl,
  adminUpdateTeacherProfile,
  adminResetPassword,
  adminDeleteStudent,
  fetchStudentRequests,
  approveStudentRequest,
  rejectStudentRequest,
  removeStudentEmail,
  getCohortYear,
  pickCohortSemesters,
  fetchSemesterCourseCohortSummary,
  fetchSemesterCourseRowsForCohorts,
  replaceSemesterCoursesForCohort,
  fetchUniversityRecommendationsSummary,
  fetchUniversityRecommendationRows,
  replaceAllUniversityRecommendations,
  fetchSeriesMatrixSummary,
  fetchSeriesMatrixRowsForCompare,
  replaceAllSeriesReflectedMatrix,
  fetchLinksSummary,
  fetchLinkRowsForCompare,
  replaceAllLinks,
  fetchStudentEmailsCount,
  bulkCreateAccounts,
  fetchMyTeacherProfile,
  updateMyTeacherProfile,
  saveStudentProfile,
  fetchMyStudentRequest,
  deriveTeacherHomeroomKind,
} from './sheets.js';
import { setAllCourses } from './utils/normalize.js';
import { renderSemesterFilterButtons, renderSemesters } from './components/semesterView.js';
import {
  renderFilterOptions,
  renderRecommendations,
  renderRecommendTableShell,
  renderSeriesMatrix,
  renderSeriesMatrixTableShell,
  renderSeriesMatrixFilterOptions,
  renderSubjectExamples,
  getFilteredCatalog,
  getFilteredExamples,
  getFilteredSeriesMatrix,
  bindFilterEvents,
  filterState,
} from './components/recommendView.js';
import { initSelectionView, getSelectedMap } from './components/selectionView.js';
import { renderMyplan } from './components/myplanView.js';
import { renderLinks } from './components/linksView.js';
import { renderTeacherView, renderAdminView, renderMemberPanel } from './components/teacherView.js';
import { renderDataManageView } from './components/dataManageView.js';
import { renderMyPage } from './components/myPageView.js';

let semesterCourses = [];      // 현재 보기 맥락(학생: 본인 코호트 / 교사·관리자: activeGrade 코호트)에 맞춰 필터링된 학기별 과목
let allCohortGroups = [];      // fetchSemesterCourses()의 원본(코호트 미필터) 결과: [{cohortYear, semester, courses}]
let currentAcademicYear = null; // app_settings.current_academic_year
let appConfig = {};
let activeGrade = 1;            // 교사·관리자가 탐색/선택 탭에서 보는 학년 (기본 1학년)
let universityCatalog = [];
let subjectExamples = null;
let subjectExamplesPromise = null;
let activeExploreMode = null;
let activeRecommendSubView = 'compare'; // 'compare'(대학 반영과목 비교 표) | 'matrix'(계열별 대표 모집단위 반영과목 표)
let seriesMatrixData = null;
let seriesMatrixPromise = null;
let majorSeriesLoaded = false;
let majorSeriesPromise = null;
let sgCurrentView = 'series';   // 'series' | 'track' | 'department' | 'subject'
let msSubnavInited = false;
let currentUser = null;
let dataLoadStarted = false; // loadData() 중복 호출 방지 플래그
let isTeacher = false;
let isAdmin = false;
let canAccessMyPage = false; // 마이페이지 탭 노출 여부 (role이 정확히 teacher 또는 student일 때만 — admin 제외)
let isGuest = false; // 비회원(게스트) 입장 여부 — true면 "계열(학과)-과목 탐색"/"참고" 탭만 노출 (2026-07 추가)

// ── 담임/학년부장 교사 탭 데이터 제한 (2026-07 추가) ────────────────────
// teacherHomeroomKind: null(일반 교사, 제한 없음) | 'homeroom'(담임, 학년+반 고정) |
// 'head'(학년부장, 학년만 고정·반은 자유). admin은 role이 'admin'이라 이 제한과 무관
// (isAdmin이 true인 곳에서는 아래 값들을 참조하지 않음 — 항상 !isAdmin 조건과 함께 사용).
let teacherHomeroomGrade = '';
let teacherHomeroomClass = '';
let teacherHomeroomKind = null;
let teacherLoaded = false;
let teacherPromise = null;
let teacherRecords = [];
let adminLoaded = false;
let adminPromise = null;
let adminCurrentView = 'selection'; // 'selection' | 'members' | 'data'
let adminDataInited = false; // "데이터 관리" 서브탭은 상태가 내부 클로저에 있어 한 번만 렌더링하면 됨
let adminMembersLoaded = false;
let adminSubnavInited = false;
let stickyOffsetObserver = null; // 탭바+필터바 높이를 감시해 --sticky-table-top을 갱신

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 응답이 지연되고 있습니다. 네트워크 또는 배포 설정을 확인해 주세요.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 탭(#tabNav)+필터바(#controlsBar)의 실제 높이를 측정해 표 헤더(.recommend-table thead)가
// 그 바로 아래에 고정되도록 CSS 변수(--sticky-table-top)를 갱신한다.
// 필터바 줄 수가 바뀌거나(좁은 화면에서 줄바꿈) 학년 선택기 노출 여부가 바뀌어도
// ResizeObserver가 자동으로 다시 계산하므로 값을 하드코딩할 필요가 없다.
function syncStickyTableOffset() {
  const tabNav = document.getElementById('tabNav');
  const controlsBar = document.getElementById('controlsBar');
  const tabNavHeight = (tabNav && !tabNav.classList.contains('tab-nav-hidden'))
    ? tabNav.getBoundingClientRect().height : 0;
  const controlsHeight = (controlsBar && !controlsBar.classList.contains('controls-hidden'))
    ? controlsBar.getBoundingClientRect().height : 0;
  document.documentElement.style.setProperty(
    '--sticky-table-top', `${Math.round(tabNavHeight + controlsHeight)}px`
  );
  // 필터바(.controls, #controlsBar) 자신도 탭 네비게이션 바로 아래에 고정되어야 한다.
  // (기존에는 .controls가 top:0으로 고정되어 z-index가 더 높은 탭 네비게이션과 같은
  // 위치를 다투다가 그 뒤로 가려져, 표 헤더(thead)가 가려진 필터바 높이까지 합산된
  // --sticky-table-top 만큼 아래로 밀려나면서 화면 중간에 애매하게 걸쳐 보이는 문제가 있었음)
  document.documentElement.style.setProperty(
    '--sticky-controls-top', `${Math.round(tabNavHeight)}px`
  );
}

function initStickyOffsetSync() {
  if (stickyOffsetObserver) return; // 1회만 설정
  syncStickyTableOffset();
  stickyOffsetObserver = new ResizeObserver(() => syncStickyTableOffset());
  const tabNav = document.getElementById('tabNav');
  const controlsBar = document.getElementById('controlsBar');
  if (tabNav) stickyOffsetObserver.observe(tabNav);
  if (controlsBar) stickyOffsetObserver.observe(controlsBar);
  window.addEventListener('resize', syncStickyTableOffset);
}

function onLoginSuccess(user) {
  currentUser = user;
  isGuest = false; // 실제 로그인 성공 경로이므로 게스트 상태는 항상 해제
  // 세션 확인 오버레이 제거 (auth.js의 acceptSession에서도 제거하지만 이중 보호)
  document.getElementById('authCheck')?.style.setProperty('display', 'none');
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').classList.add('visible');

  const portalBtn = document.getElementById('portalUrlBtn');

  // 헤더 사용자 표시 영역(수강신청 바로가기 버튼과 로그아웃 버튼 사이)은 프로필 사진
  // 없이 이름만 노출한다(2026-08 변경). user.given_name/user.name은 auth.js의
  // syncDisplayNameFromProfile()이 실제 DB 프로필(학생: student_selections.name,
  // 교사: teacher_requests.name)로 맞춰 둔 값 — 로그인 아이디(이메일)가 아니라 실명이 보인다.
  document.getElementById('userName').textContent = user.given_name || user.name;
  // 수강신청 바로가기 버튼(2026-07 추가) — 본인 portal_url이 있을 때만 노출
  if (portalBtn) {
    if (user.portalUrl) {
      portalBtn.href = user.portalUrl;
      portalBtn.hidden = false;
    } else {
      portalBtn.hidden = true;
      portalBtn.removeAttribute('href');
    }
  }
  // loadData()는 최초 1회만 실행 (SIGNED_OUT → 재로그인 시 중복 방지)
  if (!dataLoadStarted) {
    dataLoadStarted = true;
    loadData();
  }
}

function textSetting(key, fallback = '') {
  const value = String(appConfig?.[key] ?? '').trim();
  return value || fallback;
}

function applyRuntimeBranding(config = {}) {
  appConfig = config || {};
  const appName = textSetting('app_name', '교육과정 탐색');
  const schoolName = textSetting('school_name', '');
  const title = schoolName ? `${schoolName} ${appName}` : appName;
  document.title = title;

  const manifestLink = document.querySelector('link[rel="manifest"]');
  if (manifestLink) manifestLink.setAttribute('href', './manifest.json');
}

/** 비회원(게스트) 입장 (2026-07 추가). Supabase 로그인/세션을 전혀 만들지 않고, 로그인
 *  화면의 "비회원으로 둘러보기" 버튼 클릭만으로 앱 화면을 직접 노출한다 — auth.js의
 *  acceptSession()/onLoginSuccess() 경로를 전혀 타지 않으므로 dataLoadStarted 등 실제
 *  로그인 파이프라인의 상태와 완전히 분리되어 있다(게스트로 둘러보다 로그아웃하고 실제
 *  계정으로 로그인해도 dataLoadStarted가 항상 false 상태라 loadData()가 정상적으로
 *  처음부터 실행됨). */
function enterGuestMode() {
  isGuest = true;
  currentUser = null;
  document.getElementById('authCheck')?.style.setProperty('display', 'none');
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('appScreen').classList.add('visible');

  document.getElementById('userName').textContent = '비회원';
  const portalBtn = document.getElementById('portalUrlBtn');
  if (portalBtn) { portalBtn.hidden = true; portalBtn.removeAttribute('href'); }

  loadGuestApp();
}

/** 비회원(게스트) 전용 초기 화면 구성 (2026-07 추가). loadData()와 달리 Supabase의
 *  semester_courses/university_recommendations/app_settings는 조회하지 않는다 — 게스트가
 *  접근 가능한 "계열(학과)-과목 탐색"(정적 HTML)과 "참고"(links 테이블, anon 읽기 허용)만으로는
 *  필요 없는 데이터이기 때문. isAdmin/isTeacher/canAccessMyPage는 선언 시 기본값(false)을
 *  그대로 둔다. 로그아웃 후 다시 "비회원으로 둘러보기"를 누르면 이 함수가 다시 호출될 수
 *  있으므로, 내부에서 호출하는 bindTabEvents()는 자체적으로 중복 바인딩을 막는다(아래 참고). */
function loadGuestApp() {
  document.getElementById('tabNav').classList.remove('tab-nav-hidden');
  document.getElementById('mainContent').classList.add('visible');
  initStickyOffsetSync();
  updateRoleTabVisibility();
  bindTabEvents();
  // 기본 활성 탭을 "교육과정-반영과목"(explore, 게스트 접근 불가) 대신
  // "계열(학과)-과목 탐색"으로 전환한다.
  document.querySelector('.tab-btn[data-tab="majorSeries"]')?.click();
}

async function loadData() {
  showLoading(true);
  try {
    const [semesters, universities, config] = await withTimeout(Promise.all([
      fetchSemesterCourses(),
      fetchUniversityRecommendations(),
      fetchConfig().catch(() => ({})),
    ]), 20000, '기초 데이터 로드');
    applyRuntimeBranding(config);
    allCohortGroups = semesters;
    universityCatalog = universities;
    currentAcademicYear = Number(config.current_academic_year) || new Date().getFullYear();

    await withTimeout(loadTeacherPermission(), 15000, '권한 확인');
    await withTimeout(resolveActiveCohort(), 15000, '학년 정보 확인');

    showLoading(false);
    renderApp();
  } catch (err) {
    console.error('데이터 로드 실패:', err);
    showLoadError(err.message);
  }
}

/** 학생: 본인 학년(=코호트)로 고정. 교사·관리자: activeGrade(기본 1학년) 코호트 —
 *  단, 담임/학년부장 교사는 담당 학년으로 고정한다(2026-07 추가. admin은 제외 —
 *  admin은 role이 'teacher'가 아니므로 teacherHomeroomKind가 항상 null). */
async function resolveActiveCohort() {
  if (isTeacher) {
    if (!isAdmin && teacherHomeroomKind && teacherHomeroomGrade) {
      activeGrade = Number(teacherHomeroomGrade) || activeGrade;
    }
    applyActiveGrade(activeGrade);
    return;
  }
  // ⚠ 2026-07 버그 수정: student_selections.grade가 비어 있으면(드물지만, 계정 일괄
  // 생성/재업로드 파이프라인의 과거 버그 등으로 값이 갱신되지 않았거나 애초에 행이
  // 없는 경우) 아래에서 cohortYear가 null이 되고, 그 다음 줄의 `?? currentAcademicYear`
  // fallback이 "당해 연도 신입생(1학년) 코호트"를 그대로 써버린다 — 그 결과 실제로는
  // 2·3학년인 학생이 화면에서 계속 1학년 교육과정을 보게 되는 문제가 있었다. 이를 막기
  // 위해 student_selections에 값이 없으면 가입 신청 당시 기록(student_requests)을
  // fallback으로 한 번 더 확인하고, 거기서라도 학년을 찾으면 student_selections에도
  // 반영해 다음부터는 바로 정상 조회되도록 자체 복구한다.
  let myGrade = '';
  try {
    const mine = await fetchStudentSelection(currentUser?.email);
    myGrade = mine?.grade || '';
  } catch {
    // 프로필 미등록 등 — 무시하고 아래 fallback으로 진행
  }
  if (!myGrade) {
    try {
      const requestInfo = await fetchMyStudentRequest(currentUser?.email);
      if (requestInfo?.grade) {
        myGrade = requestInfo.grade;
        console.warn(
          `student_selections에 학년 정보가 없어 student_requests의 값(${requestInfo.grade}학년)으로 대체합니다. ` +
          `프로필을 자동 복구합니다: ${currentUser?.email}`
        );
        await saveStudentProfile(currentUser?.email, {
          name: requestInfo.name || currentUser?.name || '',
          grade: requestInfo.grade,
          classNo: requestInfo.classNo,
          number: requestInfo.number,
        }).catch(err => console.warn('학생 프로필 자동 복구 실패:', err.message));
      }
    } catch {
      // student_requests에도 정보가 없음 — 아래 fallback(당해 연도 코호트)으로 진행
    }
  }
  if (!myGrade) {
    console.warn(
      `학생(${currentUser?.email})의 학년 정보를 어디에서도 찾지 못해 당해 연도 코호트로 대체합니다. ` +
      `관리자에게 "학생 회원 관리"에서 학년을 확인해 달라고 요청하세요.`
    );
  }
  const cohortYear = myGrade ? getCohortYear(myGrade, currentAcademicYear) : null;
  semesterCourses = pickCohortSemesters(allCohortGroups, cohortYear ?? currentAcademicYear);
  rebuildAllCoursesIndex();
}

/** 교사·관리자가 탐색/선택 탭에서 볼 학년(코호트)을 전환. */
function applyActiveGrade(grade) {
  activeGrade = Number(grade) || 1;
  const cohortYear = getCohortYear(activeGrade, currentAcademicYear) ?? currentAcademicYear;
  semesterCourses = pickCohortSemesters(allCohortGroups, cohortYear);
  rebuildAllCoursesIndex();
}

function rebuildAllCoursesIndex() {
  const allCourses = semesterCourses.flatMap(group =>
    group.courses.map(c => ({ ...c, semester: group.semester }))
  );
  setAllCourses(allCourses);
}

// 상단 필터(계열/학과 또는 대학+계열/대학+학과 등 조합)가 선택돼 있을 때, 그 조건에 맞는
// 대학 반영과목 행들의 핵심·권장과목(반영과목 중 reflected는 제외)을 모아 반환한다.
// 학기별 과목 리스트 표에서 이 과목들과 일치하는 과목명을 빨강색으로 강조하는 데 쓰인다.
// ⚠ "대학"만 선택되고 계열·학과가 둘 다 비어 있으면 강조하지 않음(요구사항: 계열, 학과,
// 대학-계열, 대학-학과, 대학-계열-학과 조합에서만 강조).
function getHighlightSubjects() {
  if (!filterState.series.size && !filterState.department.size) return new Set();
  const rows = getFilteredCatalog(universityCatalog);
  const subjects = new Set();
  rows.forEach(item => {
    item.core.forEach(s => subjects.add(s));
    item.recommended.forEach(s => subjects.add(s));
  });
  return subjects;
}

function renderSemestersWithHighlight() {
  renderSemesters(semesterCourses, getHighlightSubjects());
}

/** 특정 학년의 코호트 학기별 과목 목록 (myplan/teacherView 등에서 학생별 개별 조회용) */
function getSemesterCoursesForGrade(grade) {
  const cohortYear = grade ? getCohortYear(grade, currentAcademicYear) : null;
  if (cohortYear == null) return semesterCourses;
  return pickCohortSemesters(allCohortGroups, cohortYear);
}

function renderApp() {
  // 탭 + controls 표시
  document.getElementById('tabNav').classList.remove('tab-nav-hidden');
  document.getElementById('controlsBar').classList.remove('controls-hidden');
  document.getElementById('mainContent').classList.add('visible');
  initStickyOffsetSync();

  // 탐색 모드
  renderSemesterFilterButtons(semesterCourses);
  renderSemestersWithHighlight();
  update();
  bindFilterEvents(update);
  updateRoleTabVisibility();

  const recommendSubViewBtns = document.querySelectorAll('.recommend-subview-btn');
  recommendSubViewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.subview;
      if (!view || view === activeRecommendSubView) return;
      activeRecommendSubView = view;
      recommendSubViewBtns.forEach(b => b.classList.toggle('active', b === btn));
      update();
    });
  });

  const semesterToggle = document.getElementById('semesterToggle');
  const semesterPanel = document.getElementById('semesterPanel');
  if (semesterToggle && semesterPanel) {
    semesterToggle.onclick = () => {
      const isCollapsed = semesterPanel.classList.toggle('collapsed');
      semesterToggle.textContent = isCollapsed ? '펼치기' : '접기';
      semesterToggle.setAttribute('aria-expanded', String(!isCollapsed));
    };
  }

  // 교육과정-반영과목 탭 필터 영역 접기/펼치기 (좁은 화면에서 필터가 여러 줄을 차지할 때
  // 공간을 절약할 수 있도록 함. controlsBar 자체의 표시 여부(tab 전환)와는 별개 상태)
  const filtersToggleBtn = document.getElementById('filtersToggleBtn');
  const controlsBar = document.getElementById('controlsBar');
  if (filtersToggleBtn && controlsBar) {
    filtersToggleBtn.onclick = () => {
      const isCollapsed = controlsBar.classList.toggle('filters-collapsed');
      filtersToggleBtn.textContent = isCollapsed ? '필터 펼치기' : '필터 접기';
      filtersToggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
    };
  }

  // 교사·관리자: 탐색/선택 탭에서 볼 학년(코호트) 선택기 노출.
  // 담임/학년부장 교사(2026-07 추가)는 담당 학년으로 고정되므로 선택기를 비활성화한다
  // (activeGrade는 이미 resolveActiveCohort()에서 담당 학년으로 맞춰져 있음 — admin 제외).
  const isHomeroomRestricted = !isAdmin && Boolean(teacherHomeroomKind);
  const cohortBox = document.getElementById('cohortGradeBox');
  const cohortSelect = document.getElementById('cohortGradeSelect');
  if (cohortBox) cohortBox.hidden = !isTeacher;
  if (cohortSelect) {
    cohortSelect.value = String(activeGrade);
    cohortSelect.disabled = isHomeroomRestricted;
    cohortSelect.title = isHomeroomRestricted
      ? (teacherHomeroomKind === 'homeroom' ? '담임 학급 학년으로 고정되어 있습니다.' : '학년부장 담당 학년으로 고정되어 있습니다.')
      : '';
    cohortSelect.onchange = async () => {
      applyActiveGrade(cohortSelect.value);
      renderSemesterFilterButtons(semesterCourses);
      renderSemestersWithHighlight();
      // 과목 선택하기 탭이 이미 초기화된 경우 새 코호트로 다시 초기화
      if (selectionInited && !isAdmin) {
        const examples = await getSubjectExamplesForSelection();
        await initSelectionView(semesterCourses, universityCatalog, examples);
      } else if (selectionInited && isAdmin) {
        const examples = await getSubjectExamplesForSelection();
        await initSelectionView(semesterCourses, universityCatalog, examples, {
          isAdmin: true,
          allStudents: teacherRecords,
          onAdminFetch: (email) => fetchStudentSelection(email),
          onAdminSave: async (email, { selectedMap }) => {
            const rec = teacherRecords.find(r => r.email === email);
            await adminUpdateStudent(email, {
              name: rec?.name || '',
              grade: rec?.grade || '',
              classNo: rec?.classNo || '',
              number: rec?.number || '',
              selectedMap,
            });
            if (rec) rec.selectedMap = selectedMap;
          },
        });
      }
    };
  }

  bindTabEvents();
}

let selectionInited = false;
let tabEventsBound = false; // bindTabEvents()가 두 번 호출돼도(예: 게스트 재입장) 리스너가 중복 등록되지 않도록 가드

function bindTabEvents() {
  if (tabEventsBound) return;
  tabEventsBound = true;
  document.getElementById('tabNav')?.addEventListener('click', async e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tabId = btn.dataset.tab;
    // 비회원(게스트)은 "계열(학과)-과목 탐색"/"참고" 외 탭에 접근할 수 없다(2026-07 추가).
    // 해당 탭 버튼은 updateRoleTabVisibility()에서 이미 숨겨지지만, 방어적으로 한 번 더 막는다.
    if (isGuest && tabId !== 'majorSeries' && tabId !== 'links') return;
    if (tabId === 'teacher' && !isTeacher) return;
    if (tabId === 'admin' && !isAdmin) return;
    if (tabId === 'mypage' && !canAccessMyPage) return;

    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === btn));
    document.getElementById('tabExplore').classList.toggle('active', tabId === 'explore');
    document.getElementById('tabSelect').classList.toggle('active', tabId === 'select');
    document.getElementById('tabMyplan').classList.toggle('active', tabId === 'myplan');
    document.getElementById('tabMajorSeries').classList.toggle('active', tabId === 'majorSeries');
    document.getElementById('tabLinks').classList.toggle('active', tabId === 'links');
    document.getElementById('tabTeacher').classList.toggle('active', tabId === 'teacher');
    document.getElementById('tabAdmin').classList.toggle('active', tabId === 'admin');
    document.getElementById('tabMypage').classList.toggle('active', tabId === 'mypage');

    // 탐색 탭일 때만 controls 표시
    document.getElementById('controlsBar').classList.toggle('controls-hidden', tabId !== 'explore');

    if (tabId === 'select') {
      const examples = await getSubjectExamplesForSelection();
      if (!selectionInited) {
        selectionInited = true;
        // 관리자: 학생 목록을 먼저 확보
        if (isAdmin) {
          try { await ensureTeacherRecords(); } catch { /* 무시 */ }
        }
        const adminOpts = isAdmin ? {
          isAdmin: true,
          allStudents: teacherRecords,
          onAdminFetch: (email) => fetchStudentSelection(email),
          onAdminSave: async (email, { selectedMap }) => {
            const rec = teacherRecords.find(r => r.email === email);
            await adminUpdateStudent(email, {
              name: rec?.name || '',
              grade: rec?.grade || '',
              classNo: rec?.classNo || '',
              number: rec?.number || '',
              selectedMap,
            });
            // 로컬 레코드 업데이트
            if (rec) rec.selectedMap = selectedMap;
          },
        } : {};
        await initSelectionView(semesterCourses, universityCatalog, examples, adminOpts);
      } else if (isAdmin) {
        // 이미 초기화된 경우에도 학생 목록 갱신 (새 학생 추가 대응)
        await initSelectionView(semesterCourses, universityCatalog, examples, {
          isAdmin: true,
          allStudents: teacherRecords,
          onAdminFetch: (email) => fetchStudentSelection(email),
          onAdminSave: async (email, { selectedMap }) => {
            const rec = teacherRecords.find(r => r.email === email);
            await adminUpdateStudent(email, {
              name: rec?.name || '',
              grade: rec?.grade || '',
              classNo: rec?.classNo || '',
              number: rec?.number || '',
              selectedMap,
            });
            if (rec) rec.selectedMap = selectedMap;
          },
        });
      }
    }

    if (tabId === 'majorSeries') {
      await ensureMsTabContent();
    }

    if (tabId === 'links') {
      try {
        const links = await fetchLinks();
        renderLinks(links);
      } catch (err) {
        document.getElementById('linksContent').innerHTML =
          '<div class="links-empty">사이트 목록을 불러오지 못했습니다.</div>';
      }
    }

    if (tabId === 'teacher') {
      await ensureTeacherContent();
    }

    if (tabId === 'admin') {
      await ensureAdminContent();
    }

    if (tabId === 'mypage') {
      await ensureMyPageContent();
    }

    if (tabId === 'myplan') {
      const picker = document.getElementById('myplanStudentPicker');
      const myplanTitle = document.getElementById('myplanTitle');
      const myplanDesc  = document.getElementById('myplanDesc');

      if (isTeacher) {
        // 교사·관리자: 학생 선택기 표시 후 선택 데이터 로드
        if (picker) picker.style.display = '';
        if (myplanTitle) myplanTitle.textContent = '과목 선택 현황(개별)';
        if (myplanDesc)  myplanDesc.textContent  = '학생을 선택하면 교육과정이 표시됩니다.';
        document.getElementById('myplanContent').innerHTML =
          '<div class="mpicker-hint">위 목록에서 학생을 선택하세요.</div>';

        try {
          await ensureTeacherRecords();
          initMyplanStudentPicker();
        } catch (err) {
          const r = document.getElementById('pickerResult');
          if (r) r.innerHTML = '<span class="mpicker-empty">학생 데이터를 불러오지 못했습니다.</span>';
        }
      } else {
        // 학생: 자신의 교육과정
        if (picker) picker.style.display = 'none';
        if (myplanTitle) myplanTitle.textContent = '내 교육과정 흐름';
        if (myplanDesc)  myplanDesc.textContent  = '선택한 과목을 교과군별·학기별로 정리한 수형도입니다.';
        if (!selectionInited) {
          selectionInited = true;
          await initSelectionView(semesterCourses, universityCatalog, await getSubjectExamplesForSelection());
        }
        renderMyplan(semesterCourses, getSelectedMap());
      }
    }
  });
}

async function getSubjectExamplesForSelection() {
  try {
    return await ensureSubjectExamples();
  } catch (err) {
    console.warn('선택 탭 예시 데이터 로드 실패:', err);
    return [];
  }
}

async function update() {
  const isExampleMode = filterState.sort === 'example';
  updateExploreChrome(isExampleMode);
  // 상단 필터(계열/학과 등) 변경은 모드와 무관하게 학기별 과목 리스트 표의 강조 표시에 반영됨
  renderSemestersWithHighlight();

  if (!isExampleMode) {
    if (activeRecommendSubView === 'matrix') {
      if (activeExploreMode !== 'matrix') {
        renderSeriesMatrixTableShell();
        activeExploreMode = 'matrix';
      }
      const stats = document.getElementById('recommendStats');
      if (stats && !seriesMatrixData) stats.textContent = '계열별 대표 모집단위 반영과목을 불러오는 중입니다.';
      try {
        const matrix = await ensureSeriesMatrix();
        if (activeRecommendSubView !== 'matrix') return;
        // 표 헤더 드롭다운(계열/모집단위)은 필터가 바뀔 때마다 매번 다시 그려
        // 캐스케이딩(서로 좁혀지는) 옵션 목록을 최신 상태로 유지한다.
        renderSeriesMatrixFilterOptions(matrix);
        renderSeriesMatrix(getFilteredSeriesMatrix(matrix));
      } catch (err) {
        console.error('계열별 반영과목 매트릭스 로드 실패:', err);
        if (activeRecommendSubView !== 'matrix') return;
        if (stats) stats.textContent = '';
        const body = document.getElementById('seriesMatrixTableBody');
        if (body) body.innerHTML = '<tr><td class="empty">계열별 대표 모집단위 반영과목을 불러오지 못했습니다.</td></tr>';
      }
      return;
    }

    if (activeExploreMode !== 'recommend') {
      renderRecommendTableShell();
      activeExploreMode = 'recommend';
    }
    // 표 헤더 드롭다운과 상단 툴바 드롭다운(미러)이 항상 같은 선택 상태를 보여주도록
    // 필터가 바뀔 때마다(모드 진입 시뿐 아니라) 매번 다시 그린다.
    renderFilterOptions(universityCatalog, { mode: 'recommend' });
    renderRecommendations(getFilteredCatalog(universityCatalog));
    return;
  }

  if (activeExploreMode !== 'example' && activeExploreMode !== 'example-loading') {
    renderFilterOptions([], { mode: 'example' });
    activeExploreMode = 'example-loading';
  }

  const grid = document.getElementById('recommendGrid');
  const stats = document.getElementById('recommendStats');
  if (grid && !subjectExamples) {
    grid.innerHTML = '<div class="empty">계열·학과별 선택과목 예시를 불러오는 중입니다.</div>';
  }
  if (stats && !subjectExamples) stats.textContent = '';

  try {
    const examples = await ensureSubjectExamples();
    if (filterState.sort !== 'example') return;
    if (activeExploreMode !== 'example') {
      renderFilterOptions(examples, { mode: 'example' });
      activeExploreMode = 'example';
    }
    renderSubjectExamples(getFilteredExamples(examples));
  } catch (err) {
    console.error('선택과목 예시 로드 실패:', err);
    if (filterState.sort !== 'example') return;
    if (stats) stats.textContent = '';
    if (grid) {
      grid.innerHTML = '<div class="empty">계열·학과별 선택과목 예시를 불러오지 못했습니다.</div>';
    }
  }
}

function ensureSeriesMatrix() {
  if (seriesMatrixData) return Promise.resolve(seriesMatrixData);
  if (!seriesMatrixPromise) {
    seriesMatrixPromise = fetchSeriesMatrix()
      .then(data => {
        seriesMatrixData = data;
        return data;
      })
      .catch(err => {
        seriesMatrixPromise = null;
        throw err;
      });
  }
  return seriesMatrixPromise;
}

function ensureSubjectExamples() {
  if (subjectExamples) return Promise.resolve(subjectExamples);
  if (!subjectExamplesPromise) {
    subjectExamplesPromise = fetchSubjectExamples()
      .then(data => {
        subjectExamples = data;
        return data;
      })
      .catch(err => {
        subjectExamplesPromise = null;
        throw err;
      });
  }
  return subjectExamplesPromise;
}

function ensureMajorSeriesContent() {
  if (majorSeriesLoaded) return Promise.resolve();
  if (!majorSeriesPromise) {
    const container = document.getElementById('majorSeriesContent');
    if (!container) return Promise.resolve();

    majorSeriesPromise = fetch('./data/major-series-tab.html')
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then(html => {
        container.innerHTML = html;
        initMajorSeriesSearch(container);
        majorSeriesLoaded = true;
      })
      .catch(err => {
        console.error('전공 계열 탭 로드 실패:', err);
        container.innerHTML = `
          <div class="major-series-wrap">
            <div class="empty">전공 계열과 주요 학과 정보를 불러오지 못했습니다.</div>
          </div>
        `;
      })
      .finally(() => {
        majorSeriesPromise = null;
      });
  }
  return majorSeriesPromise;
}

// ──────────────────────────────────────────────────
// 계열(학과)-과목 탐색 탭 — 서브뷰 관리
// ──────────────────────────────────────────────────

// 2022SubjectGuide is kept as raw <main> HTML fragments under data/.
// Styling and interaction live in index.html and this file.
const SG_DATA_BASE = './data/2022SubjectGuide';
const SG_INDEX_URL = {
  track:      `${SG_DATA_BASE}/tracks/index.html`,
  department: `${SG_DATA_BASE}/departments/index.html`,
  subject:    `${SG_DATA_BASE}/subjects/index.html`,
};
const SG_SOURCE_HTML = `
  <footer class="source-attribution sg-source-note" aria-label="자료 출처">
    출처: 이 자료는 서울진로진학정보센터의 『2022 개정 교육과정 선택과목 안내서』 내용을 토대로 제작했습니다.
  </footer>
`;

/** 상대 경로 → 절대 경로 변환 (fake base URL 트릭) */
function resolveSgUrl(base, rel) {
  try {
    const fakeBase = 'https://x/' + base.replace(/^\.\//, '');
    const resolved = new URL(rel, fakeBase);
    return './' + resolved.pathname.slice(1);
  } catch {
    return rel;
  }
}

/** 서브 네비 이벤트 초기화 (최초 1회) */
function initMsSubnav() {
  if (msSubnavInited) return;
  msSubnavInited = true;
  document.getElementById('msSubnav')?.addEventListener('click', async e => {
    const btn = e.target.closest('.ms-subnav-btn');
    if (!btn) return;
    const view = btn.dataset.sgview;
    if (view === sgCurrentView) return;
    await switchSgView(view);
  });
}

/** majorSeries 탭 진입 시 호출 */
async function ensureMsTabContent() {
  initMsSubnav();
  if (sgCurrentView === 'series') {
    await ensureMajorSeriesContent();
  }
  // 다른 뷰는 이미 DOM에 있으므로 재로드 불필요
}

/** 서브뷰 전환 */
async function switchSgView(view) {
  sgCurrentView = view;

  // 서브 네비 활성 상태
  document.querySelectorAll('.ms-subnav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.sgview === view);
  });

  const viewSeries = document.getElementById('msViewSeries');
  const viewSg     = document.getElementById('msViewSg');

  if (view === 'series') {
    if (viewSeries) viewSeries.hidden = false;
    if (viewSg)     viewSg.hidden     = true;
    await ensureMajorSeriesContent();
    return;
  }

  if (viewSeries) viewSeries.hidden = true;
  if (viewSg)     viewSg.hidden     = false;

  // 이 섹션 뷰가 이미 로드된 경우 재사용
  const current = viewSg?.dataset.sgSection;
  if (current === view) return;

  await loadSgPage(view, SG_INDEX_URL[view]);
}

/** 2022SubjectGuide HTML 페이지를 fetch 후 <main> 주입 */
async function loadSgPage(sectionView, url) {
  const container = document.getElementById('sgContent');
  if (!container) return;

  container.innerHTML = '<div class="home-shell"><div class="sg-loading">불러오는 중...</div></div>';

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const parser = new DOMParser();
    const doc    = parser.parseFromString(html, 'text/html');
    const main   = doc.querySelector('main');
    if (!main) throw new Error('<main> 요소 없음');

    container.innerHTML = main.innerHTML;
    container.querySelectorAll('.source-attribution').forEach(el => el.remove());
    container.insertAdjacentHTML('beforeend', SG_SOURCE_HTML);

    // 내부 링크 인터셉트
    container.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto')) return;
      const resolved = resolveSgUrl(url, href);
      a.href = '#';
      a.addEventListener('click', async e => {
        e.preventDefault();
        await loadSgPage(sectionView, resolved);
      });
    });

    // 검색/필터 재초기화
    initSgSearch(url, container);

    // 현재 로드된 섹션 기록 (인덱스 페이지에서만 갱신)
    if (Object.values(SG_INDEX_URL).includes(url)) {
      const viewSg = document.getElementById('msViewSg');
      if (viewSg) viewSg.dataset.sgSection = sectionView;
    }

  } catch (err) {
    console.error('SubjectGuide 페이지 로드 실패:', err);
    container.innerHTML = '<div class="home-shell"><div class="sg-loading">내용을 불러오지 못했습니다.</div></div>';
  }
}

/** URL에 따라 2022SubjectGuide 검색/필터 초기화 */
function initSgSearch(url, container) {
  if (url.includes('/subjects/index')) {
    initSgCourseSearch(container);
  } else if (url.includes('/departments/index')) {
    initSgDepartmentSearch(container);
  } else if (url.includes('/tracks/index')) {
    initSgTrackSearch(container);
  }
}

// ── 2022SubjectGuide 검색 유틸리티 ──

function sgGetSearchText(card) {
  return (card.dataset.search || '').toLowerCase();
}
function sgGetSectionLabel(section, selector) {
  return (section.querySelector(selector)?.textContent || '').trim();
}
function sgGetCardTitle(card) {
  return (card.querySelector('strong')?.textContent || '').trim();
}
function sgAddSelectOptions(select, values) {
  const seen = new Set();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = value;
    select.append(opt);
  }
}

/** subjects/index.html 교과 검색 */
function initSgCourseSearch(container) {
  const input          = container.querySelector('#courseSearch');
  const categoryFilter = container.querySelector('#courseCategoryFilter');
  const trackFilter    = container.querySelector('#courseTrackFilter');
  const sections       = [...container.querySelectorAll('[data-category-section]')];
  const count          = container.querySelector('#resultCount');
  if (!input || !categoryFilter || !trackFilter || !sections.length) return;

  sgAddSelectOptions(categoryFilter,
    sections
      .filter(s => sgGetSectionLabel(s, '.category-head p') === '제1부 교과(군)별')
      .map(s => sgGetSectionLabel(s, '.category-head h2'))
  );
  sgAddSelectOptions(trackFilter,
    sections
      .filter(s => sgGetSectionLabel(s, '.category-head p') === '제2부 계열별')
      .map(s => sgGetSectionLabel(s, '.category-head h2'))
  );

  function update() {
    const query    = input.value.trim().toLowerCase();
    const selCat   = categoryFilter.value;
    const selTrack = trackFilter.value;
    let visible = 0;
    for (const section of sections) {
      const type = sgGetSectionLabel(section, '.category-head p');
      const name = sgGetSectionLabel(section, '.category-head h2');
      const filterOk =
        (!selCat && !selTrack) ||
        (selCat   && type === '제1부 교과(군)별' && name === selCat) ||
        (selTrack && type === '제2부 계열별'      && name === selTrack);
      const cards = [...section.querySelectorAll('[data-course-card]')];
      let sectionVisible = false;
      for (const card of cards) {
        const ok = filterOk && (!query || sgGetSearchText(card).includes(query));
        card.hidden = !ok;
        if (ok) { visible++; sectionVisible = true; }
      }
      section.hidden = !sectionVisible;
    }
    if (count) count.textContent = visible + '개 과목';
  }

  categoryFilter.addEventListener('change', () => { trackFilter.value = ''; update(); });
  trackFilter.addEventListener('change',    () => { categoryFilter.value = ''; update(); });
  input.addEventListener('input', update);
  update();
}

/** departments/index.html 학과 검색 */
function initSgDepartmentSearch(container) {
  const input         = container.querySelector('#departmentSearch');
  const nameFilter    = container.querySelector('#departmentNameFilter');
  const sectionFilter = container.querySelector('#departmentSectionFilter');
  const sections      = [...container.querySelectorAll('[data-department-section]')];
  const count         = container.querySelector('#departmentResultCount');
  const cards         = [...container.querySelectorAll('[data-department-card]')];
  if (!input || !nameFilter || !sectionFilter || !sections.length || !cards.length) return;

  sgAddSelectOptions(nameFilter,    cards.map(sgGetCardTitle));
  sgAddSelectOptions(sectionFilter, sections.map(s => sgGetSectionLabel(s, '.category-head h2')));

  function update() {
    const query      = input.value.trim().toLowerCase();
    const selDept    = nameFilter.value;
    const selSection = sectionFilter.value;
    let visible = 0;
    for (const section of sections) {
      const secName = sgGetSectionLabel(section, '.category-head h2');
      const secOk   = !selSection || secName === selSection;
      const secCards = [...section.querySelectorAll('[data-department-card]')];
      let sectionVisible = false;
      for (const card of secCards) {
        const deptOk    = !selDept || sgGetCardTitle(card) === selDept;
        const filterOk  = selDept ? deptOk : secOk;
        const ok = filterOk && (!query || sgGetSearchText(card).includes(query));
        card.hidden = !ok;
        if (ok) { visible++; sectionVisible = true; }
      }
      section.hidden = !sectionVisible;
    }
    if (count) count.textContent = visible + '개 학과';
  }

  nameFilter.addEventListener('change',    () => { sectionFilter.value = ''; update(); });
  sectionFilter.addEventListener('change', () => { nameFilter.value    = ''; update(); });
  input.addEventListener('input', update);
  update();
}

/** tracks/index.html 계열 검색 */
function initSgTrackSearch(container) {
  const input    = container.querySelector('#trackSearch');
  const cards    = [...container.querySelectorAll('[data-track-card]')];
  const sections = [...container.querySelectorAll('[data-track-section]')];
  const count    = container.querySelector('#trackResultCount');
  if (!input || !cards.length) return;

  function update() {
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const ok = !query || sgGetSearchText(card).includes(query);
      card.hidden = !ok;
      if (ok) visible++;
    }
    for (const section of sections) {
      const sectionCards = [...section.querySelectorAll('[data-track-card]')];
      section.hidden = sectionCards.length > 0 && !sectionCards.some(c => !c.hidden);
    }
    if (count) count.textContent = visible + '개 계열';
  }

  input.addEventListener('input', update);
  update();
}

// ──────────────────────────────────────────────────
// (이하 기존 major-series-tab.html 검색 로직)
// ──────────────────────────────────────────────────

function initMajorSeriesSearch(container) {
  const searchInput = container.querySelector('#majorSeriesSearchInput');
  const clearButton = container.querySelector('#majorSeriesSearchClear');
  const countEl = container.querySelector('#majorSeriesSearchCount');
  const mainTable = container.querySelector('.major-series-main-table');
  if (!searchInput || !mainTable) return;

  const mainData = {
    groups: collectMajorSeriesMainGroups(mainTable),
    empty: createMajorSeriesEmpty(mainTable),
  };

  const similarTables = [...container.querySelectorAll('.major-series-table:not(.major-series-main-table)')]
    .map(table => ({
      rows: [...(table.tBodies[0]?.rows || [])].map(row => ({
        row,
        searchText: normalizeMajorSeriesSearchText(row.textContent),
      })),
      empty: createMajorSeriesEmpty(table),
    }));

  const totalRows = mainData.groups.reduce((sum, group) => sum + group.rows.length, 0) +
    similarTables.reduce((sum, table) => sum + table.rows.length, 0);

  const applySearch = () => {
    clearMajorSeriesHighlights(container);

    const rawQuery = searchInput.value;
    const query = normalizeMajorSeriesSearchText(searchInput.value);
    const mainVisibleCount = applyMajorSeriesMainSearch(mainData.groups, query);
    let visibleCount = mainVisibleCount;
    mainData.empty?.classList.toggle('visible', Boolean(query) && mainVisibleCount === 0);

    for (const table of similarTables) {
      const tableVisibleCount = applyMajorSeriesSimpleSearch(table.rows, query);
      visibleCount += tableVisibleCount;
      table.empty?.classList.toggle('visible', Boolean(query) && tableVisibleCount === 0);
    }

    if (query) highlightMajorSeriesVisibleRows(container, rawQuery);
    if (countEl) countEl.textContent = query ? `검색 결과 ${visibleCount}개` : `전체 ${totalRows}개`;
    if (clearButton) clearButton.hidden = !query;
  };

  searchInput.addEventListener('input', applySearch);
  clearButton?.addEventListener('click', () => {
    searchInput.value = '';
    searchInput.focus();
    applySearch();
  });

  applySearch();
}

function collectMajorSeriesMainGroups(table) {
  const groups = [];
  let currentGroup = null;
  let rowsLeftInGroup = 0;

  for (const row of [...(table.tBodies[0]?.rows || [])]) {
    if (!currentGroup || rowsLeftInGroup <= 0) {
      const cell = row.cells[0];
      if (!cell) continue;

      currentGroup = {
        cell,
        originalRow: row,
        originalRowSpan: cell.rowSpan || 1,
        rows: [],
        activeClone: null,
      };
      groups.push(currentGroup);
      rowsLeftInGroup = currentGroup.originalRowSpan;
    }

    currentGroup.rows.push({
      row,
      searchText: normalizeMajorSeriesSearchText(`${currentGroup.cell.textContent} ${row.textContent}`),
    });
    rowsLeftInGroup -= 1;
  }

  return groups;
}

function applyMajorSeriesMainSearch(groups, query) {
  let visibleCount = 0;

  for (const group of groups) {
    if (group.activeClone?.isConnected) group.activeClone.remove();
    group.activeClone = null;
    group.cell.rowSpan = group.originalRowSpan;
    group.cell.style.display = '';

    const matches = query
      ? group.rows.filter(item => item.searchText.includes(query))
      : group.rows;
    const visibleRows = new Set(matches.map(item => item.row));
    visibleCount += matches.length;

    for (const { row } of group.rows) {
      row.hidden = !visibleRows.has(row);
    }

    if (!query || matches.length === 0) continue;

    const firstVisibleRow = matches[0].row;
    if (firstVisibleRow === group.originalRow) {
      group.cell.rowSpan = matches.length;
    } else {
      group.cell.style.display = 'none';
      const clone = group.cell.cloneNode(true);
      clone.removeAttribute('id');
      clone.dataset.majorSeriesClone = 'true';
      clone.style.display = '';
      clone.rowSpan = matches.length;
      firstVisibleRow.insertBefore(clone, firstVisibleRow.firstElementChild);
      group.activeClone = clone;
    }
  }

  return visibleCount;
}

function applyMajorSeriesSimpleSearch(rows, query) {
  let visibleCount = 0;

  for (const item of rows) {
    const isVisible = !query || item.searchText.includes(query);
    item.row.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  }

  return visibleCount;
}

function createMajorSeriesEmpty(table) {
  const wrap = table.closest('.major-series-table-wrap');
  if (!wrap) return null;

  const empty = document.createElement('div');
  empty.className = 'major-series-empty';
  empty.textContent = '검색 결과가 없습니다.';
  wrap.insertAdjacentElement('afterend', empty);
  return empty;
}

function normalizeMajorSeriesSearchText(value) {
  return String(value || '').replace(/\s/g, '').toLowerCase();
}

function clearMajorSeriesHighlights(container) {
  for (const highlight of [...container.querySelectorAll('.major-series-highlight')]) {
    const parent = highlight.parentNode;
    highlight.replaceWith(document.createTextNode(highlight.textContent || ''));
    parent?.normalize();
  }
}

function highlightMajorSeriesVisibleRows(container, value) {
  const terms = getMajorSeriesHighlightTerms(value);
  if (!terms.length) return;

  container.querySelectorAll('.major-series-table tbody tr:not([hidden])').forEach(row => {
    highlightMajorSeriesElement(row, terms);
  });
}

async function loadTeacherPermission() {
  // role은 auth.js의 acceptSession에서 이미 판별됨 → currentUser.role 사용
  const role = currentUser?.role;
  isAdmin   = role === 'admin';
  isTeacher = role === 'teacher' || role === 'admin'; // 관리자도 교사 탭 접근 가능
  canAccessMyPage = role === 'teacher' || role === 'student'; // 마이페이지는 교사·학생 전용(관리자 제외)

  // 담임/학년부장 정보 조회(2026-07 추가). admin은 role이 'teacher'가 아니므로 대상 밖
  // (관리자는 항상 전체 학년/학급에 제한 없이 접근) — isAdmin이 true인 동안 아래 값들은
  // 사용되지 않지만, 재로그인 시 이전 값이 남지 않도록 매번 초기화한다.
  teacherHomeroomGrade = '';
  teacherHomeroomClass = '';
  teacherHomeroomKind = null;
  if (role === 'teacher') {
    try {
      const profile = await fetchMyTeacherProfile(currentUser.email);
      teacherHomeroomGrade = profile?.homeroomGrade || '';
      teacherHomeroomClass = profile?.homeroomClass || '';
      teacherHomeroomKind = deriveTeacherHomeroomKind(teacherHomeroomGrade, teacherHomeroomClass);
    } catch (err) {
      console.warn('담임/학년부장 정보 조회 실패(제한 없이 진행):', err.message);
    }
  }
}

function updateRoleTabVisibility() {
  // 비회원(게스트): "계열(학과)-과목 탐색"/"참고" 탭만 노출 (2026-07 추가)
  if (isGuest) {
    const guestAllowedTabs = new Set(['majorSeries', 'links']);
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.hidden = !guestAllowedTabs.has(btn.dataset.tab);
    });
    const guestOrders = { majorSeries: 1, links: 2 };
    for (const [tab, order] of Object.entries(guestOrders)) {
      const el = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
      if (el) el.style.order = order;
    }
    return;
  }

  // 교사용 탭 (teacher, admin 둘 다 접근 가능)
  const teacherBtn = document.querySelector('.tab-btn[data-tab="teacher"]');
  const teacherPanel = document.getElementById('tabTeacher');
  if (teacherBtn) teacherBtn.hidden = !isTeacher;
  if (teacherPanel) teacherPanel.hidden = !isTeacher;

  // 관리자 탭 (admin만 접근 가능)
  const adminBtn = document.querySelector('.tab-btn[data-tab="admin"]');
  const adminPanel = document.getElementById('tabAdmin');
  if (adminBtn) adminBtn.hidden = !isAdmin;
  if (adminPanel) adminPanel.hidden = !isAdmin;

  // 마이페이지 탭 (교사·학생 전용, 관리자 제외, 항상 맨 오른쪽 — 2026-07 추가)
  const myPageBtn = document.querySelector('.tab-btn[data-tab="mypage"]');
  const myPagePanel = document.getElementById('tabMypage');
  if (myPageBtn) myPageBtn.hidden = !canAccessMyPage;
  if (myPagePanel) myPagePanel.hidden = !canAccessMyPage;

  // 탭 레이블: 학생은 "내 교육과정 보기", 교사/관리자는 "과목 선택 현황(개별)"
  const myplanBtn = document.querySelector('.tab-btn[data-tab="myplan"]');
  if (myplanBtn) myplanBtn.textContent = isTeacher ? '과목 선택 현황(개별)' : '내 교육과정 보기';

  // 탭 순서: flex order로 역할별 배치. 마이페이지(8)는 교사·학생 모두에서 항상 맨 뒤.
  // 학생: 전공계열(1)/교육과정탐색(2)/내과목선택(3)/내교육과정보기(4)/참고사이트(5)/마이페이지(8)
  // 교사/관리자: 전공계열(1)/교육과정탐색(2)/내과목선택(3)/참고사이트(4)/개별교육과정보기(5)/교사용(6)/관리자(7)/마이페이지(8)
  const orders = isTeacher
    ? { majorSeries: 1, explore: 2, select: 3, links: 4, myplan: 5, teacher: 6, admin: 7, mypage: 8 }
    : { majorSeries: 1, explore: 2, select: 3, myplan: 4, links: 5, teacher: 6, admin: 7, mypage: 8 };

  for (const [tab, order] of Object.entries(orders)) {
    const el = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
    if (el) el.style.order = order;
  }
}

// ── 학생 선택 데이터 로드 (공통) ──────────────────────────
async function ensureTeacherRecords() {
  if (teacherLoaded) return;
  if (teacherPromise) return teacherPromise;
  teacherPromise = (async () => {
    try {
      const token = await requestAccessToken();
      if (!token) throw new Error('로그인 세션을 확인하지 못했습니다.');
      teacherRecords = await fetchStudentSelections();
      teacherLoaded = true;
    } finally {
      teacherPromise = null;
    }
  })();
  return teacherPromise;
}

async function ensureTeacherContent(force = false) {
  if (!isTeacher) return;
  if (force) teacherLoaded = false;

  // 담임/학년부장 필터 고정(2026-07 추가). admin은 제외(항상 null → 제한 없음).
  const restriction = (!isAdmin && teacherHomeroomKind)
    ? { grade: teacherHomeroomGrade, classNo: teacherHomeroomClass, kind: teacherHomeroomKind }
    : null;

  const teacherOptions = {
    semesterCourses,
    allCohortGroups,
    currentAcademicYear,
    onRefresh: () => ensureTeacherContent(true),
    onViewStudent: viewStudentInMyplan,
    restriction,
  };

  const container = document.getElementById('teacherContent');

  try {
    if (container && force) {
      container.innerHTML = `<div class="teacher-wrap"><div class="teacher-empty">학생 선택 데이터를 불러오는 중입니다.</div></div>`;
    }
    await ensureTeacherRecords();
    renderTeacherView(teacherRecords, teacherOptions);
  } catch (err) {
    console.error('교사용 선택 현황 로드 실패:', err);
    if (container) {
      container.innerHTML = `<div class="teacher-wrap"><div class="teacher-empty">학생 선택 데이터를 불러오지 못했습니다. 시트 접근 권한을 확인해 주세요.</div></div>`;
    }
  }
}

async function ensureAdminContent(force = false) {
  if (!isAdmin) return;
  if (force) { teacherLoaded = false; adminLoaded = false; adminMembersLoaded = false; }

  initAdminSubnav();

  if (adminCurrentView === 'members') {
    await ensureAdminMembersContent(force);
  } else if (adminCurrentView === 'data') {
    await ensureAdminDataContent();
  } else {
    await ensureAdminSelectionContent(force);
  }
}

/** 마이페이지(교사·학생 전용, 2026-07 추가) — 열 때마다 최신 정보를 다시 불러와
 *  렌더링한다(다른 admin 서브탭처럼 "최초 1회만 렌더링"할 이유가 없음 — 내부 상태를
 *  들고 있을 필요가 없는 단순 폼이라 매번 새로 그리는 편이 최신값을 보장해 더 안전함). */
async function ensureMyPageContent() {
  if (!canAccessMyPage) return;
  const container = document.getElementById('myPageContent');
  if (!container) return;
  const role = currentUser?.role;

  container.innerHTML = `
    <div class="mypage-wrap">
      <div class="links-header"><h2>마이페이지</h2><p class="links-desc">불러오는 중...</p></div>
    </div>`;

  try {
    let profile = {};
    if (role === 'teacher') {
      const p = await fetchMyTeacherProfile(currentUser.email);
      profile = { name: p?.name || currentUser?.name || '', subjectArea: p?.subjectArea || '' };
    } else if (role === 'student') {
      const p = await fetchStudentSelection(currentUser.email);
      profile = {
        name: p?.name || currentUser?.name || '',
        grade: p?.grade || '',
        classNo: p?.classNo || '',
        number: p?.number || '',
      };
    } else {
      return; // admin은 접근 불가 (canAccessMyPage로 이미 걸러지지만 방어적으로 재확인)
    }

    renderMyPage(container, {
      role,
      profile,
      onSaveProfile: async (next) => {
        if (role === 'teacher') {
          await updateMyTeacherProfile(currentUser.email, next);
        } else {
          await saveStudentProfile(currentUser.email, next);
        }

        // 헤더에 표시되는 이름(#userName)도 함께 갱신 — 실패해도 위 프로필 저장은 이미
        // 끝났으므로 별도로 감싸 무시한다(치명적이지 않은 보조 동작).
        try {
          await updateMyDisplayName(next.name);
        } catch (err) {
          console.warn('표시 이름 갱신 실패(무시 가능):', err.message);
        }
        const nameEl = document.getElementById('userName');
        if (nameEl) nameEl.textContent = next.name;
        if (currentUser) currentUser.name = next.name;

        // 학생이 학년을 바꾸면 코호트(입학년도별 교육과정)가 달라지므로, 탐색 탭 데이터를
        // 새 학년 기준으로 다시 계산해 반영한다. 이미 초기화된 "과목 선택하기" 탭은 다음에
        // 열 때 새 코호트로 다시 초기화되도록 selectionInited를 리셋한다.
        if (role === 'student') {
          await resolveActiveCohort();
          renderSemesterFilterButtons(semesterCourses);
          renderSemestersWithHighlight();
          update();
          selectionInited = false;
        }
      },
      onChangePassword: async (newPassword) => {
        await updateMyPassword(newPassword);
      },
    });
  } catch (err) {
    console.error('마이페이지 로드 실패:', err);
    container.innerHTML = `
      <div class="mypage-wrap">
        <div class="links-header"><h2>마이페이지</h2><p class="links-desc">정보를 불러오지 못했습니다.</p></div>
      </div>`;
  }
}

function initAdminSubnav() {
  if (adminSubnavInited) return;
  adminSubnavInited = true;

  const subnav = document.getElementById('adminSubnav');
  if (!subnav) return;

  subnav.addEventListener('click', async e => {
    const btn = e.target.closest('.admin-subnav-btn');
    if (!btn) return;
    const view = btn.dataset.adminview;
    if (view === adminCurrentView) return;

    adminCurrentView = view;
    subnav.querySelectorAll('.admin-subnav-btn').forEach(b =>
      b.classList.toggle('active', b === btn)
    );
    document.getElementById('adminContent').hidden         = view !== 'selection';
    document.getElementById('adminMembersContent').hidden  = view !== 'members';
    document.getElementById('adminDataContent').hidden     = view !== 'data';

    if (view === 'members') await ensureAdminMembersContent();
    if (view === 'data') await ensureAdminDataContent();
  });
}

/** 관리자 "데이터 관리" 서브탭 — curriculum-cohorts.xlsx 형식 업로드로
 *  semester_courses를 설정/갱신하는 화면. 내부 상태(선택한 파일, 미리보기 등)는
 *  dataManageView.js의 클로저에서 관리하므로, 여기서는 최초 1회만 렌더링하면 된다
 *  (탭을 다시 열 때 매번 다시 그리면 "현재 등록된 교육과정 현황"만 새로고침되고
 *  진행 중이던 업로드/미리보기 상태가 사라지는 게 오히려 부자연스럽다). */
async function ensureAdminDataContent() {
  if (!isAdmin) return;
  if (adminDataInited) return;

  const container = document.getElementById('adminDataContent');
  if (!container) return;

  adminDataInited = true;
  renderDataManageView(container, {
    fetchConfig,
    saveAppSettings,
    fetchCohortSummary: fetchSemesterCourseCohortSummary,
    fetchCohortRows: fetchSemesterCourseRowsForCohorts,
    replaceCohortCourses: replaceSemesterCoursesForCohort,
    fetchUniversitySummary: fetchUniversityRecommendationsSummary,
    fetchUniversityRows: fetchUniversityRecommendationRows,
    replaceUniversityRecommendations: async rows => {
      await replaceAllUniversityRecommendations(rows);
    },
    fetchSeriesSummary: fetchSeriesMatrixSummary,
    fetchSeriesRows: fetchSeriesMatrixRowsForCompare,
    replaceSeriesMatrix: async rows => {
      await replaceAllSeriesReflectedMatrix(rows);
    },
    // 대학 추천과목 파싱 시 반영과목 보강 소스로 쓰임 — 앱 전역 캐시(ensureSeriesMatrix)가
    // 아니라 항상 DB에서 직접 조회해, 방금 반영과목을 갱신했다면 그 최신 값을 즉시 반영한다.
    fetchSeriesMatrixRows: fetchSeriesMatrix,
    fetchLinksSummary,
    fetchLinkRows: fetchLinkRowsForCompare,
    replaceLinks: async rows => {
      await replaceAllLinks(rows);
    },
    // 네 섹션(교육과정/대학 추천과목/반영과목/참고사이트) 중 어느 것을 적용했는지 구분하지
    // 않고 매번 캐시를 모두 새로고침한다 — 자주 일어나는 동작이 아니라 약간의 중복 조회는
    // 문제되지 않고, 어떤 데이터를 바꿨든 탐색/추천/참고 화면이 항상 최신 상태를 보여준다.
    onApplied: reloadAllDataManagedCaches,
  });
}

/** 데이터 관리 탭에서 교육과정을 반영(적용)한 뒤, 이미 로드해 둔 allCohortGroups/
 *  semesterCourses가 새 내용을 반영하도록 다시 불러오고, 현재 화면(탐색/선택 등)에
 *  즉시 반영한다. sessionStorage 캐시는 replaceSemesterCoursesForCohort()가 이미
 *  비웠으므로 fetchSemesterCourses()는 항상 서버에서 새로 조회한다. */
async function reloadCurriculumData() {
  try {
    allCohortGroups = await fetchSemesterCourses();
    if (isTeacher) {
      applyActiveGrade(activeGrade);
    } else {
      await resolveActiveCohort();
    }
    renderSemesterFilterButtons(semesterCourses);
    renderSemestersWithHighlight();
  } catch (err) {
    console.error('교육과정 재로드 실패:', err);
  }
}

/** 데이터 관리 탭에서 대학 추천과목을 반영한 뒤, universityCatalog를 다시 불러오고
 *  현재 화면(교육과정-반영과목 탭의 대학별 추천 카드 등)에 즉시 반영한다.
 *  sessionStorage 캐시는 replaceAllUniversityRecommendations()가 이미 비웠으므로
 *  fetchUniversityRecommendations()는 항상 서버에서 새로 조회한다. */
async function reloadUniversityCatalogData() {
  try {
    universityCatalog = await fetchUniversityRecommendations();
    await update();
  } catch (err) {
    console.error('대학 추천과목 재로드 실패:', err);
  }
}

/** 데이터 관리 탭에서 계열별 반영과목을 반영한 뒤, 앱이 들고 있던 캐시(seriesMatrixData)를
 *  무효화한다. sessionStorage 캐시는 replaceAllSeriesReflectedMatrix()가 이미 비웠으므로,
 *  다음에 ensureSeriesMatrix()가 호출될 때(예: update()가 매트릭스 보기를 그릴 때) 서버에서
 *  새로 조회된다. */
async function reloadSeriesMatrixCache() {
  seriesMatrixData = null;
  seriesMatrixPromise = null;
  try {
    await update();
  } catch (err) {
    console.error('계열별 반영과목 재로드 실패:', err);
  }
}

/** 데이터 관리 탭의 세 업로드 섹션(교육과정/대학 추천과목/계열별 반영과목) 중 어느 것을
 *  적용했든 공통으로 호출되는 콜백 — 세 캐시를 모두 새로고침한다. */
async function reloadAllDataManagedCaches() {
  const config = await fetchConfig().catch(() => ({}));
  applyRuntimeBranding(config);
  currentAcademicYear = Number(config.current_academic_year) || currentAcademicYear || new Date().getFullYear();
  await reloadCurriculumData();
  await reloadUniversityCatalogData();
  await reloadSeriesMatrixCache();
}

async function ensureAdminSelectionContent(force = false) {
  const adminOptions = {
    semesterCourses,
    allCohortGroups,
    currentAcademicYear,
    onRefresh: () => ensureAdminContent(true),
    onApprove: approveTeacherRequest,
    onReject: rejectTeacherRequest,
    onRemove: removeTeacherEmail,
    fetchRequests: fetchTeacherRequests,
    onAdminUpdateStudent: adminUpdateStudent,
    onAdminBulkSelectionUpload: async rows => {
      await adminBulkUpdateStudentSelections(rows);
      teacherLoaded = false;
      await ensureTeacherRecords();
    },
    onAdminDeleteStudent: adminDeleteStudent,
    onAdminResetPassword: adminResetPassword,
  };

  const container = document.getElementById('adminContent');

  if (adminLoaded && !force) {
    renderAdminView(teacherRecords, adminOptions);
    return;
  }
  if (adminPromise) return adminPromise;

  if (container) {
    container.innerHTML = `<div class="teacher-wrap"><div class="teacher-empty">관리자 데이터를 불러오는 중입니다.</div></div>`;
  }

  adminPromise = (async () => {
    try {
      await ensureTeacherRecords();
      adminLoaded = true;
      renderAdminView(teacherRecords, adminOptions);
    } catch (err) {
      console.error('관리자 데이터 로드 실패:', err);
      if (container) {
        container.innerHTML = `<div class="teacher-wrap"><div class="teacher-empty">관리자 데이터를 불러오지 못했습니다. 권한을 확인해 주세요.</div></div>`;
      }
    } finally {
      adminPromise = null;
    }
  })();

  return adminPromise;
}

async function ensureAdminMembersContent(force = false) {
  if (!isAdmin) return;
  if (adminMembersLoaded && !force) return;

  const container = document.getElementById('adminMembersContent');
  if (!container) return;

  try {
    await ensureTeacherRecords();
    renderMemberPanel(container, {
      records: teacherRecords,
      onApprove: approveTeacherRequest,
      onReject:  rejectTeacherRequest,
      onRemove:  removeTeacherEmail,
      fetchRequests:        fetchTeacherRequests,
      directAddTeacher:     directAddTeacherEmail,
      fetchTeacherEmailsList: fetchTeacherEmails,
      fetchStudentRequests: fetchStudentRequests,
      onAdminUpdateStudentRequest: adminUpdateStudentRequestInfo,
      onApproveStudent: (requestId, email) => approveStudentRequest(requestId, email),
      onRejectStudent:  (requestId) => rejectStudentRequest(requestId),
      onRemoveStudent:  (email) => removeStudentEmail(email),
      onAdminUpdateStudent: async (email, data) => {
        await adminUpdateStudent(email, data);
        const rec = teacherRecords.find(r => r.email === email);
        if (rec) Object.assign(rec, data);
      },
      onAdminDeleteStudent: async (email) => {
        await adminDeleteStudent(email);
        const idx = teacherRecords.findIndex(r => r.email === email);
        if (idx !== -1) teacherRecords.splice(idx, 1);
      },
      onUpdateStudentPortalUrl: async (email, portalUrl) => {
        await adminUpdateStudentPortalUrl(email, portalUrl);
        const rec = teacherRecords.find(r => r.email === email);
        if (rec) rec.portalUrl = portalUrl;
      },
      onUpdateTeacherPortalUrl: adminUpdateTeacherPortalUrl,
      onAdminUpdateTeacherProfile: async (email, data) => {
        await adminUpdateTeacherProfile(email, data);
        const rec = teacherRecords.find(r => r.email === email);
        if (rec) Object.assign(rec, data);
      },
      onAdminResetPassword: adminResetPassword,
      fetchStudentEmailsCount,
      bulkCreateAccounts,
      onRefresh: () => ensureAdminMembersContent(true),
    });
    adminMembersLoaded = true;
  } catch (err) {
    console.error('회원 관리 패널 로드 실패:', err);
    if (container) {
      container.innerHTML = `<div class="teacher-wrap"><div class="teacher-empty">회원 데이터를 불러오지 못했습니다.</div></div>`;
    }
  }
}

// ── 개별 학생 교육과정 뷰어 (교사·관리자용) ──────────────

function makeStudentLabel(r) {
  return [
    r.grade   ? r.grade + '학년'         : '',
    r.classNo ? Number(r.classNo) + '반' : '',
    r.number  ? Number(r.number)  + '번' : '',
    r.name || '',
  ].filter(Boolean).join(' ');
}

// 왼쪽 패널에서 현재 선택(표시 중)된 학생의 email — 목록 강조 표시용
let _myplanSelectedEmail = null;

function renderStudentChips(records, resultEl) {
  resultEl.innerHTML = `
    <div class="mpicker-list-title">검색 결과 ${records.length}명 — 학생을 선택하세요.</div>
    <div class="mpicker-multi-list">
      ${records.map(r => `
        <button class="mpicker-student${r.email === _myplanSelectedEmail ? ' active' : ''}" data-email="${r.email}" type="button">
          <span class="mpicker-student-info">${r.grade || ''}학년 ${Number(r.classNo) || ''}반 ${Number(r.number) || ''}번</span>
          <span class="mpicker-student-name">${r.name || r.email}</span>
        </button>`).join('')}
    </div>`;
  resultEl.querySelectorAll('.mpicker-student').forEach(btn => {
    btn.addEventListener('click', () => {
      const rec = teacherRecords.find(r => r.email === btn.dataset.email);
      if (rec) {
        _myplanSelectedEmail = rec.email;
        selectStudentMyplan(rec);
        resultEl.querySelectorAll('.mpicker-student').forEach(b => b.classList.toggle('active', b === btn));
      }
    });
  });
}

function initMyplanStudentPicker() {
  const gradeSelect  = document.getElementById('pickerGrade');
  const classInput   = document.getElementById('pickerClass');
  const numberInput  = document.getElementById('pickerNumber');
  const nameInput    = document.getElementById('pickerName');
  const searchBtn    = document.getElementById('pickerSearchBtn');
  const resultEl     = document.getElementById('pickerResult');
  if (!searchBtn || !resultEl) return;

  // 담임/학년부장 교사(2026-07 추가): 담임은 학년+반, 부장은 학년만 고정하고 입력을
  // 막는다(admin은 제외 — isAdmin이면 아래는 모두 false). 값 자체는 프로그램적으로
  // 채워 넣고 disabled로 잠가, 사용자가 다른 학년/반을 검색할 수 없게 한다.
  const isRestricted = !isAdmin && Boolean(teacherHomeroomKind);
  const isHomeroom = isRestricted && teacherHomeroomKind === 'homeroom';
  if (gradeSelect) gradeSelect.disabled = isRestricted;
  if (classInput) classInput.disabled = isHomeroom;
  if (isRestricted) {
    if (gradeSelect) gradeSelect.value = teacherHomeroomGrade;
    if (isHomeroom && classInput) classInput.value = teacherHomeroomClass;
  }

  const doSearch = () => {
    const grade  = (gradeSelect?.value  || '').trim();
    const classNo = (classInput?.value  || '').trim();
    const number  = (numberInput?.value || '').trim();
    const name    = (nameInput?.value   || '').trim();

    // 아무 조건도 없으면 안내
    if (!grade && !classNo && !number && !name) {
      resultEl.innerHTML = '<span class="mpicker-empty">학년·반·번호·이름 중 하나 이상 입력 후 검색하세요.</span>';
      return;
    }

    let filtered = teacherRecords;
    if (grade)  filtered = filtered.filter(r => r.grade === grade);
    if (classNo) filtered = filtered.filter(r => Number(r.classNo) === Number(classNo));
    if (number)  filtered = filtered.filter(r => Number(r.number)  === Number(number));
    if (name)    filtered = filtered.filter(r => (r.name || '').includes(name));

    filtered = filtered.sort((a, b) => {
      const g = Number(a.grade) - Number(b.grade);
      if (g) return g;
      const c = Number(a.classNo) - Number(b.classNo);
      if (c) return c;
      return Number(a.number) - Number(b.number);
    });

    if (filtered.length === 0) {
      _myplanSelectedEmail = null;
      resultEl.innerHTML = '<span class="mpicker-empty">검색 결과가 없습니다.</span>';
      return;
    }

    // 결과가 1명이면 바로 표시하되, 목록도 함께 보여주어 강조 표시
    if (filtered.length === 1) {
      _myplanSelectedEmail = filtered[0].email;
      selectStudentMyplan(filtered[0]);
    }

    renderStudentChips(filtered, resultEl);
  };

  // 검색 버튼 (그대로 두되, 굳이 누르지 않아도 됨)
  searchBtn.onclick = doSearch;

  // 입력/선택 즉시 반영 (실시간 검색)
  if (gradeSelect) gradeSelect.onchange = doSearch;
  [classInput, numberInput, nameInput].forEach(el => {
    if (el) el.oninput = doSearch;
  });

  // Enter 키 지원 (호환성 유지용, 실시간 검색이라 사실상 불필요)
  [classInput, numberInput, nameInput].forEach(el => {
    if (el) el.onkeydown = e => { if (e.key === 'Enter') doSearch(); };
  });

  // 담임/학년부장은 값을 프로그램적으로 채워 넣었을 뿐 change/input 이벤트가 발생하지
  // 않으므로, 탭 진입 시 바로 자신의 학년(-반) 학생 목록이 보이도록 한 번 직접 실행한다.
  if (isRestricted) doSearch();
}

/** 과목 선택 현황(통계) 탭의 학생 이름 클릭 → '과목 선택 현황(개별)'(myplan) 탭으로 이동해 해당 학생을 표시. */
async function viewStudentInMyplan(record) {
  const tabBtn = document.querySelector('.tab-btn[data-tab="myplan"]');
  if (!tabBtn) return;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b === tabBtn));
  document.getElementById('tabExplore')?.classList.remove('active');
  document.getElementById('tabSelect')?.classList.remove('active');
  document.getElementById('tabMyplan')?.classList.add('active');
  document.getElementById('tabMajorSeries')?.classList.remove('active');
  document.getElementById('tabLinks')?.classList.remove('active');
  document.getElementById('tabTeacher')?.classList.remove('active');
  document.getElementById('tabAdmin')?.classList.remove('active');
  document.getElementById('controlsBar')?.classList.add('controls-hidden');

  const picker = document.getElementById('myplanStudentPicker');
  const myplanTitle = document.getElementById('myplanTitle');
  const myplanDesc  = document.getElementById('myplanDesc');
  if (picker) picker.style.display = '';
  if (myplanTitle) myplanTitle.textContent = '과목 선택 현황(개별)';
  if (myplanDesc)  myplanDesc.textContent  = '선택한 과목을 교과군별·학기별로 정리한 수형도입니다.';

  try {
    await ensureTeacherRecords();
    initMyplanStudentPicker();
  } catch {
    // 무시 — 아래에서 바로 해당 학생을 표시
  }

  const liveRecord = teacherRecords.find(r => r.email === record.email) || record;
  _myplanSelectedEmail = liveRecord.email;
  selectStudentMyplan(liveRecord);
  const resultEl = document.getElementById('pickerResult');
  if (resultEl) renderStudentChips([liveRecord], resultEl);
}

function selectStudentMyplan(record) {
  const title = document.getElementById('myplanTitle');
  const desc  = document.getElementById('myplanDesc');
  if (title) title.textContent = makeStudentLabel(record) + ' 교육과정';
  if (desc)  desc.textContent  = '선택한 과목을 교과군별·학기별로 정리한 수형도입니다.';
  // 학생 본인의 학년(코호트)에 맞는 교육과정으로 표시 (교사·관리자가 보는 학년과 무관)
  renderMyplan(getSemesterCoursesForGrade(record.grade), record.selectedMap || {});
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getMajorSeriesHighlightTerms(value) {
  const raw = String(value || '').trim();
  const collapsed = raw.replace(/\s/g, '');
  const terms = [raw, collapsed, ...raw.split(/\s+/)]
    .map(term => term.trim())
    .filter(Boolean);
  const seen = new Set();

  return terms
    .filter(term => {
      const key = term.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.length - a.length)
    .map(term => ({
      text: term,
      lower: term.toLowerCase(),
    }));
}

function highlightMajorSeriesElement(element, terms) {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        return node.nodeValue.trim()
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    }
  );
  const nodes = [];
  let node = walker.nextNode();

  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }

  nodes.forEach(node => highlightMajorSeriesTextNode(node, terms));
}

function highlightMajorSeriesTextNode(node, terms) {
  const text = node.nodeValue || '';
  const lowerText = text.toLowerCase();
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  let hasMatch = false;

  while (cursor < text.length) {
    const match = terms.find(term => lowerText.startsWith(term.lower, cursor));

    if (!match) {
      fragment.append(document.createTextNode(text[cursor]));
      cursor += 1;
      continue;
    }

    const highlight = document.createElement('strong');
    highlight.className = 'major-series-highlight';
    highlight.textContent = text.slice(cursor, cursor + match.text.length);
    fragment.append(highlight);
    cursor += match.text.length;
    hasMatch = true;
  }

  if (hasMatch) node.replaceWith(fragment);
}

function updateExploreChrome(isExampleMode) {
  const title = document.getElementById('recommendTitle');
  const footer = document.getElementById('recommendFooter');
  const searchInput = document.getElementById('searchInput');
  const subviewToggle = document.getElementById('recommendSubViewToggle');
  const compareFilterGroups = document.getElementById('compareFilterGroups');
  const isMatrixView = !isExampleMode && activeRecommendSubView === 'matrix';

  if (subviewToggle) subviewToggle.hidden = isExampleMode;
  // 권역/지역/대학/계열/학과 상단 필터(표 헤더 미러)는 매트릭스 표에는 적용되지 않으므로
  // 비교 표(compare) 모드에서만 노출한다.
  if (compareFilterGroups) compareFilterGroups.hidden = isExampleMode || isMatrixView;

  if (title) {
    title.textContent = isExampleMode
      ? '계열·학과별 선택과목 예시'
      : (isMatrixView
        ? '계열별 대표 모집단위 반영과목'
        : '권역·계열·학과별 대학 반영과목 비교');
  }

  if (footer) {
    const sourceYear = textSetting('recommendation_source_year', '2028');
    footer.textContent = isExampleMode
      ? '선택과목 예시는 Supabase의 계열별 학과 안내 및 선택과목 예시 데이터를 기준으로 표시합니다.'
      : (isMatrixView
        ? `계열별 대표 모집단위 반영과목은 ${sourceYear}학년도 계열별 대표 모집단위별 반영과목 엑셀 자료를 기준으로 표시합니다. 계열별 대표 모집단위 16개만 포함된 보조 자료입니다.`
        : `추천 과목 데이터는 ${sourceYear}학년도 계열별 대표 모집단위별 반영과목 엑셀 자료를 기준으로 변환했습니다. 실제 상담 자료로 사용할 때는 각 대학의 최신 모집요강과 전공 안내 자료로 최종 확인하세요.`);
  }

  if (searchInput) {
    searchInput.placeholder = isExampleMode
      ? '계열, 학과, 유사학과, 과목 검색'
      : '과목, 대학, 권역, 계열, 학과, 키워드 검색';
  }
}

function inferArea(name) {
  const n = name.replace(/\s/g, '').toLowerCase();
  if (['대수','미적분ⅰ','미적분i','확률과통계','기하'].includes(n)) return 'math';
  if (n.includes('영어') || n.includes('영미')) return 'english';
  if (n.includes('문학') || n.includes('독서') || n.includes('화법') || n.includes('작문')) return 'korean';
  if (n.includes('사회') || n.includes('역사') || n.includes('경제') || n.includes('윤리') || n.includes('지리')) return 'social';
  if (n.includes('물리') || n.includes('화학') || n.includes('생명') || n.includes('지구') || n.includes('과학')) return 'science';
  return 'liberal';
}

function showLoading(visible) {
  document.getElementById('loadingScreen').classList.toggle('visible', visible);
  if (visible) document.getElementById('mainContent').classList.remove('visible');
}

function showLoadError(msg) {
  document.getElementById('loadingScreen').innerHTML = `
    <div style="text-align:center;padding:32px;">
      <div style="color:#d14a3a;font-weight:800;margin-bottom:8px;">데이터 로드 실패</div>
      <div style="color:#667085;font-size:0.85rem;">${msg}</div>
      <button onclick="location.reload()"
        style="margin-top:16px;padding:8px 16px;border:1.5px solid #d9dee8;border-radius:8px;background:#fff;cursor:pointer;font-weight:700;">
        새로고침
      </button>
    </div>
  `;
  document.getElementById('loadingScreen').classList.add('visible');
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  // 게스트는 Supabase 세션 자체가 없으므로 signOut()은 사실상 아무 세션도 지우지 않지만,
  // appScreen을 숨기고 로그인 화면을 다시 보여주는 setLoggedOutUI() 흐름은 그대로 재사용할
  // 수 있어 문제없이 동작한다(2026-07 추가).
  isGuest = false;
  await signOut();
});
document.getElementById('guestLoginBtn')?.addEventListener('click', enterGuestMode);
initAuth(onLoginSuccess);

// ── 교사 신청 모달 ─────────────────────────────────────
(function initTeacherRequestModal() {
  const modal   = document.getElementById('teacherRequestModal');
  const openBtn = document.getElementById('openTeacherRequestBtn');
  const closeBtn= document.getElementById('closeTeacherRequestBtn');
  const submitBtn = document.getElementById('submitTeacherRequestBtn');
  const msgEl   = document.getElementById('trMsg');
  if (!modal || !openBtn) return;

  function openModal() {
    modal.classList.add('open');
    document.getElementById('trName').value = '';
    document.getElementById('trEmail').value = '';
    document.getElementById('trMessage').value = '';
    msgEl.textContent = '';
    msgEl.className = 'modal-msg';
    submitBtn.disabled = false;
  }
  function closeModal() {
    modal.classList.remove('open');
  }

  openBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  submitBtn.addEventListener('click', async () => {
    const name    = document.getElementById('trName').value.trim();
    const email   = document.getElementById('trEmail').value.trim();
    const message = document.getElementById('trMessage').value.trim();

    if (!name || !email) {
      msgEl.textContent = '이름과 이메일은 필수 입력 항목입니다.';
      msgEl.className = 'modal-msg error';
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      msgEl.textContent = '올바른 이메일 형식을 입력해 주세요.';
      msgEl.className = 'modal-msg error';
      return;
    }

    submitBtn.disabled = true;
    msgEl.textContent = '신청 중...';
    msgEl.className = 'modal-msg';

    try {
      await submitTeacherRequest({ name, email, message });
      msgEl.textContent = '신청이 완료되었습니다. 관리자 승인 후 로그인하실 수 있습니다.';
      msgEl.className = 'modal-msg success';
      closeBtn.textContent = '닫기';
    } catch (err) {
      msgEl.textContent = err.message || '신청 중 오류가 발생했습니다.';
      msgEl.className = 'modal-msg error';
      submitBtn.disabled = false;
    }
  });
})();
