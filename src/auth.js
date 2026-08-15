import { CONFIG } from './config.js';
import { supabase } from './supabaseClient.js';
import { saveStudentProfile, fetchMyStudentRequest, fetchMyPortalUrl, fetchMyTeacherProfile } from './sheets.js';

export { CONFIG };

let currentUser = null;
let onLoginSuccess = null;
let initialized = false;
let hasActiveSession = false;
let adminExistsCache = null; // null=미확인, true/false=확인됨

const ADMIN_SETUP_PENDING_KEY = 'jjghs_admin_setup_pending';
const ADMIN_SETUP_DOMAIN_KEY = 'jjghs_admin_setup_domain';
const GOOGLE_SIGNUP_PENDING_KEY = 'jjghs_google_signup_pending';

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 응답이 지연되고 있습니다.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ── 역할 정의 (전부 DB 승인 기반. 2026-06 회원가입 승인제 전환) ──────
// admin  : admins 테이블에 등록된 계정 (앱 내 "최초 관리자 등록" 화면에서 생성)
// teacher: teacher_emails 테이블에 승인된 계정
// student: student_emails 테이블에 승인된 계정
// (그 외)  : 로그인 차단 (회원가입 신청 후 관리자 승인 필요)
//
// ⚠ Google OAuth 로그인(signInWithGoogle)은 일반 로그인 화면(#loginScreen)과
//   최초 관리자 등록 화면(#adminSetupScreen) 양쪽에 모두 노출된다. 최초 관리자를
//   Google 계정으로 등록한 경우, 이후 세션이 끊겨 재로그인이 필요할 때도 같은
//   Google 계정으로 다시 로그인할 수 있어야 하기 때문(2026-06, 관리자 요청으로 재노출).
//   학교 도메인 자동인식(isSchoolEmail)은 더 이상 분기에 쓰이지 않는 죽은 코드로 유지.
// ───────────────────────────────────────────────────────

// ⚠ 2026-06 (2차): 사용자에게 실제 이메일 입력을 요구하는 방식은 폐기.
//   대신 "최초 관리자 등록" 화면에서 관리자가 학교가 실제로 소유한 도메인(DNS에 MX/A
//   레코드가 살아있는 도메인, 예: jjg.hs.kr)을 1회 등록해두고, 교사·학생은 평문 "아이디"만
//   입력하면 내부적으로 `아이디.${ID_SUFFIX}@도메인` 형태의 Supabase Auth 계정으로 변환되어
//   가입된다. Supabase Auth(GoTrue)의 이메일 검증은 도메인 자체의 DNS 유효성만 보고 그
//   local part(아이디 부분)의 실제 메일함 존재 여부는 검사하지 않는 것으로 보이므로,
//   학교가 실제 소유한 도메인을 쓰면 진짜 메일함이 없는 임의의 "아이디"로도 가입이 통과됨.
//   `.${ID_SUFFIX}` 고정 접미사는 실제 학교 메일 계정(예: 학번·이름 패턴)과 우연히 겹칠
//   가능성을 낮추기 위한 구분자일 뿐, 검증 통과 자체에는 필요 없음.
//   ⚠ Supabase 대시보드 → Authentication → Providers → Email에서 "Confirm email"을
//   반드시 꺼야 함 — 가짜 메일함으로 확인 메일을 보내봤자 아무도 받을 수 없으므로, 켜져
//   있으면 가입 후 영원히 인증 대기 상태에 머무름. 같은 이유로 이메일 기반 비밀번호
//   재설정 기능도 사용하지 않음(이 앱에는 해당 UI 자체가 없음).
const DEFAULT_ID_SUFFIX = 'ckfqhfl';

export function getAuthIdSuffix() {
  return String(CONFIG.ID_SUFFIX || DEFAULT_ID_SUFFIX).trim().toLowerCase() || DEFAULT_ID_SUFFIX;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

/** 평문 "아이디" 형식 검사 — 영문/숫자/.,_,- 조합, 2~40자. "@" 포함 불가(직접 도메인을 붙이므로). */
export function isValidPlainId(value) {
  return /^[a-z0-9._-]{2,40}$/.test(normalizeEmail(value));
}

/** 도메인 형식(대략적인 문법) 검사 */
export function isValidDomainFormat(value) {
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(normalizeEmail(value));
}

/** 평문 아이디 + 학교 도메인을 Supabase Auth용 이메일로 변환.
 *  예: toAuthIdentifier('aaa', 'example.hs.kr') → 'aaa.<ID_SUFFIX>@example.hs.kr' */
export function toAuthIdentifier(id, domain) {
  const cleanId = normalizeEmail(id);
  const cleanDomain = normalizeEmail(domain);
  if (!cleanId || !cleanDomain) return '';
  return `${cleanId}.${getAuthIdSuffix()}@${cleanDomain}`;
}

function isSchoolEmail(email) {
  const domain = normalizeEmail(CONFIG.SCHOOL_DOMAIN);
  if (!domain) return false;
  return normalizeEmail(email).endsWith(`@${domain}`);
}

function isEmailInDomain(email, domain) {
  const cleanEmail = normalizeEmail(email);
  const cleanDomain = normalizeEmail(domain);
  return !!(cleanEmail && cleanDomain && cleanEmail.endsWith(`@${cleanDomain}`));
}

/** admins 테이블 조회로 관리자 여부 확인 */
async function isApprovedAdmin(email) {
  const target = normalizeEmail(email);
  if (!target) return false;
  try {
    const { data, error } = await supabase
      .from('admins')
      .select('email')
      .eq('email', target)
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

/** teacher_emails 테이블 조회로 승인 여부 확인 */
async function isApprovedTeacher(email) {
  const target = normalizeEmail(email);
  if (!target) return false;
  try {
    const { data, error } = await supabase
      .from('teacher_emails')
      .select('email')
      .eq('email', target)
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

/** student_emails 테이블 조회로 승인 여부 확인 */
async function isApprovedStudent(email) {
  const target = normalizeEmail(email);
  if (!target) return false;
  try {
    const { data, error } = await supabase
      .from('student_emails')
      .select('email')
      .eq('email', target)
      .maybeSingle();
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

function extractDisplayName(user) {
  const metadata = user?.user_metadata || {};
  return metadata.name || metadata.full_name || user?.email || '';
}

function toUserProfile(user, role, portalUrl = '') {
  const metadata = user?.user_metadata || {};
  const name = extractDisplayName(user);
  const givenName = metadata.given_name || name;
  return {
    name,
    email: user?.email || '',
    picture: metadata.avatar_url || metadata.picture || '',
    given_name: givenName,
    role, // 'admin' | 'teacher' | 'student'
    portalUrl, // 수강신청/결과 확인 개인별 바로가기 URL (2026-07 추가, student/teacher만 값 있음)
  };
}

function showLoginError(msg) {
  // 로그인 화면(#loginError)과 최초 관리자 등록 화면(#asError) 둘 다 채워둔다.
  // OAuth 리다이렉트 복귀 시 어느 화면이 보이고 있을지 미리 알 수 없으므로
  // (관리자 미등록 상태면 adminSetupScreen이 우선 노출되어 loginError가 숨겨짐),
  // 두 군데 모두에 표시해 에러가 "조용히 사라지는" 문제를 막는다.
  const el = document.getElementById('loginError');
  if (el) {
    el.textContent = msg;
    el.classList.add('visible');
  }
  const asEl = document.getElementById('asError');
  if (asEl) {
    asEl.textContent = msg;
    asEl.classList.add('visible');
  }
}

function hideLoginError() {
  const el = document.getElementById('loginError');
  if (el) el.classList.remove('visible');
  const asEl = document.getElementById('asError');
  if (asEl) {
    asEl.textContent = '';
    asEl.classList.remove('visible');
  }
}

function readOAuthErrorFromUrl() {
  const url = new URL(window.location.href);
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');
  if (!error && !errorDesc) return null;

  const message = decodeURIComponent(errorDesc || error).replace(/\+/g, ' ');
  ['error', 'error_description', 'error_code', 'code'].forEach(key => {
    url.searchParams.delete(key);
  });
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  return message;
}

function isOAuthCallbackUrl() {
  const url = new URL(window.location.href);
  return url.searchParams.has('code') || url.hash.includes('access_token');
}

function hideAuthCheck() {
  const el = document.getElementById('authCheck');
  if (el) el.style.display = 'none';
}

async function checkAdminExistsCached() {
  if (adminExistsCache !== null) return adminExistsCache;
  try {
    const { checkAdminExists } = await import('./sheets.js');
    adminExistsCache = await withTimeout(checkAdminExists(), 10000, '관리자 정보 확인');
  } catch (err) {
    console.error('관리자 존재 여부 확인 실패:', err);
    adminExistsCache = true; // 안전하게 "존재함"으로 간주 (관리자 등록 화면 노출 방지)
  }
  return adminExistsCache;
}

async function _resolveWithLogin() {
  if (hasActiveSession) return;
  hideAuthCheck();
  const loginScreen = document.getElementById('loginScreen');
  const adminSetupScreen = document.getElementById('adminSetupScreen');

  const adminExists = await checkAdminExistsCached();
  if (!adminExists) {
    if (loginScreen) loginScreen.style.display = 'none';
    if (adminSetupScreen) adminSetupScreen.style.display = 'flex';
    return;
  }
  if (adminSetupScreen) adminSetupScreen.style.display = 'none';
  if (loginScreen) loginScreen.style.display = 'flex';
}

function setLoggedOutUI() {
  currentUser = null;
  hasActiveSession = false;
  sessionStorage.removeItem('jjghs_user');
  const appScreen = document.getElementById('appScreen');
  if (appScreen) appScreen.classList.remove('visible');
  _resolveWithLogin();
}

function getAuthRedirectTo() {
  return `${window.location.origin}${window.location.pathname}`;
}

// ── Google OAuth 로그인 ──────────────────────────────
async function signInWithGoogle() {
  hideLoginError();
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: getAuthRedirectTo() },
  });
  if (error) {
    console.error('Supabase OAuth 시작 실패:', error);
    showLoginError('로그인을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

// ── 아이디/비밀번호 로그인 (교사·학생·관리자 공용) ──────
// id: 평문 아이디, domain: 학교 도메인(app_settings.school_domain) — 내부적으로
// toAuthIdentifier(id, domain)으로 변환해 Supabase Auth에 전달한다.
export async function signInWithEmail(id, password, domain) {
  hideLoginError();
  const email = toAuthIdentifier(id, domain);
  if (!email) {
    showLoginError('학교 도메인이 설정되지 않았습니다. 관리자에게 문의하세요.');
    return false;
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    const msg = error.message?.includes('Invalid login')
      ? '아이디 또는 비밀번호가 올바르지 않습니다.'
      : `로그인 실패: ${error.message}`;
    showLoginError(msg);
    return false;
  }
  return true;
}

// ── 아이디/비밀번호 회원가입 (교사·학생 신청 시) ─────
// ⚠ 가짜 메일함이라 확인 메일을 받을 수 없으므로 emailRedirectTo는 지정하지 않음.
//   Supabase 대시보드에서 "Confirm email"을 꺼두는 것이 전제 조건.
export async function signUpWithEmail(id, password, domain) {
  const email = toAuthIdentifier(id, domain);
  if (!email) {
    throw new Error('학교 도메인이 설정되지 않았습니다. 관리자에게 문의하세요.');
  }
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) {
    if (error.message?.includes('already registered')) {
      throw new Error('이미 등록된 아이디입니다. 로그인을 시도하세요.');
    }
    throw new Error(`회원가입 실패: ${error.message}`);
  }
}

function renderLoginButton(containerId = 'googleLoginBtn', label = 'Google 계정으로 로그인', onClick = signInWithGoogle) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const btnId = `${containerId}OAuthBtn`;
  container.innerHTML = `
    <button id="${btnId}" class="google-oauth-btn" type="button">
      <svg viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
      </svg>
      ${label}
    </button>
  `;
  document.getElementById(btnId)?.addEventListener('click', onClick);
}

// ── 최초 관리자 등록 화면 바인딩 ─────────────────────
// ⚠ 학교 도메인 등록은 이제 선택이 아니라 필수다 — Google 계정/로그인 사용 여부와
//   무관하게, 이 화면에서 등록되는 도메인이 이후 모든 교사·학생 계정의 아이디를
//   "아이디.ID_SUFFIX@도메인" 형태로 변환하는 기준이 된다.
function bindAdminSetupScreen() {
  const submitBtn = document.getElementById('asSubmitBtn');
  const errEl = document.getElementById('asError');
  const domainInput = document.getElementById('asSchoolDomain');
  const googleDomainInput = document.getElementById('asGoogleDomain');

  // errEl은 .login-error 클래스라 .visible이 없으면 display:none 상태이므로,
  // textContent만 바꾸면 화면에 아무것도 안 보이는 채로 조용히 실패한다.
  const setAsError = (msg) => {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.classList.toggle('visible', Boolean(msg));
  };

  // 관리자 등록 직후, 입력된 학교 도메인 설정을 저장 (실패해도 관리자 등록 자체는 막지 않음)
  async function persistSchoolDomainSettings(domain, googleDomain) {
    try {
      const { saveSchoolDomainSettings } = await import('./sheets.js');
      await saveSchoolDomainSettings({ enabled: true, domain, googleDomain });
    } catch (err) {
      console.error('학교 도메인 설정 저장 실패:', err);
    }
  }

  // Google로 관리자 등록: 플래그(+학교 도메인 설정)를 세팅한 뒤 OAuth 시작
  // → acceptSession에서 registerFirstAdmin + 학교 도메인 설정 저장을 처리
  renderLoginButton('asGoogleBtn', 'Google 계정으로 등록', () => {
    const domain = domainInput?.value.trim() || '';
    const googleDomain = googleDomainInput?.value.trim() || domain;
    if (!isValidDomainFormat(domain)) {
      setAsError('학교 도메인을 올바른 형식으로 입력해 주세요 (예: jjg.hs.kr).');
      return;
    }
    if (!isValidDomainFormat(googleDomain)) {
      setAsError('Google 계정 도메인을 올바른 형식으로 입력해 주세요 (예: jjg.hs.kr).');
      return;
    }
    sessionStorage.setItem(ADMIN_SETUP_PENDING_KEY, '1');
    sessionStorage.setItem(ADMIN_SETUP_DOMAIN_KEY, JSON.stringify({ enabled: true, domain, googleDomain }));
    signInWithGoogle();
  });

  submitBtn?.addEventListener('click', async () => {
    setAsError('');
    const name = document.getElementById('asName')?.value.trim() || '';
    const id = document.getElementById('asEmail')?.value.trim() || '';
    const domain = domainInput?.value.trim() || '';
    const googleDomain = googleDomainInput?.value.trim() || domain;
    const password = document.getElementById('asPassword')?.value || '';
    const passwordConfirm = document.getElementById('asPasswordConfirm')?.value || '';

    if (!name || !id || !domain || !password) {
      setAsError('모든 항목을 입력해 주세요.');
      return;
    }
    if (!isValidDomainFormat(domain)) {
      setAsError('학교 도메인을 올바른 형식으로 입력해 주세요 (예: jjg.hs.kr).');
      return;
    }
    if (!isValidDomainFormat(googleDomain)) {
      setAsError('Google 계정 도메인을 올바른 형식으로 입력해 주세요 (예: jjg.hs.kr).');
      return;
    }
    if (!isValidPlainId(id)) {
      setAsError('아이디는 영문/숫자/.,_,- 조합 2~40자로 입력해 주세요.');
      return;
    }
    if (password.length < 6) {
      setAsError('비밀번호는 6자 이상이어야 합니다.');
      return;
    }
    if (password !== passwordConfirm) {
      setAsError('비밀번호가 일치하지 않습니다.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = '등록 중...';
    try {
      const stillEmpty = !(await checkAdminExistsCached());
      if (!stillEmpty) {
        setAsError('이미 관리자가 등록되어 있습니다. 페이지를 새로고침해 주세요.');
        submitBtn.disabled = false;
        submitBtn.textContent = '관리자로 등록';
        return;
      }
      const authEmail = toAuthIdentifier(id, domain);
      const { registerFirstAdmin } = await import('./sheets.js');
      await registerFirstAdmin({ email: authEmail, name, authMethod: 'email' });
      adminExistsCache = true;
      await signUpWithEmail(id, password, domain);
      // signUp이 곧바로 세션을 발급하지 않는 환경이면 로그인 시도
      const ok = await signInWithEmail(id, password, domain);
      await persistSchoolDomainSettings(domain, googleDomain);
      if (!ok) {
        setAsError('관리자 등록이 완료됐습니다. 로그인 화면에서 다시 로그인해 주세요.');
        document.getElementById('adminSetupScreen').style.display = 'none';
        document.getElementById('loginScreen').style.display = 'flex';
      }
    } catch (err) {
      setAsError(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = '관리자로 등록';
    }
  });
}

// ── 학생 최초 로그인 프로필 입력 모달 ────────────────
function needsStudentProfile(dbProfile) {
  // grade, classNo, number 중 하나라도 비어 있으면 프로필 미완성
  return !dbProfile || !dbProfile.grade || !dbProfile.classNo || !dbProfile.number;
}

async function fetchStudentProfileFromDB(email) {
  try {
    const { data, error } = await supabase
      .from('student_selections')
      .select('name,grade,class_no,number')
      .eq('email', normalizeEmail(email))
      .maybeSingle();
    if (error || !data) return null;
    return { name: data.name || '', grade: data.grade || '', classNo: data.class_no || '', number: data.number || '' };
  } catch {
    return null;
  }
}

/** 헤더에 표시할 이름을 실제 DB 프로필(학생: student_selections.name, 교사:
 *  teacher_requests.name)로 맞춘다. 아이디/비밀번호 가입 계정은 Auth의
 *  user_metadata.name이 비어 있는 경우(회원가입 시 별도로 저장하지 않음)가 많아,
 *  기존에는 toUserProfile()의 extractDisplayName()이 user.email(예:
 *  "학생아이디.ID_SUFFIX@학교도메인" 형태의 로그인 아이디)로 폴백해 헤더에 실명 대신
 *  로그인 아이디가 노출되는 문제가 있었다. DB에 저장된 실명을 찾으면 그 값으로
 *  currentUser.name/given_name을 덮어써 항상 실명이 보이도록 한다(찾지 못하면
 *  기존 값 유지 — 관리자 등 다른 역할에는 영향 없음). */
async function syncDisplayNameFromProfile(email, role) {
  if (!currentUser) return;
  let name = '';
  try {
    if (role === 'student') {
      const profile = await fetchStudentProfileFromDB(email);
      name = profile?.name || '';
    } else if (role === 'teacher') {
      const profile = await fetchMyTeacherProfile(email);
      name = profile?.name || '';
    }
  } catch {
    name = '';
  }
  if (name && name !== currentUser.name) {
    currentUser = { ...currentUser, name, given_name: name };
    sessionStorage.setItem('jjghs_user', JSON.stringify(currentUser));
  }
}

function showStudentProfileModal(email, existingName, onComplete) {
  const modal = document.getElementById('studentProfileModal');
  if (!modal) {
    // 모달이 없으면 바로 완료 처리 (fallback)
    onComplete();
    return;
  }

  // 이름 필드 초기값 세팅
  const nameInput = document.getElementById('spName');
  if (nameInput && existingName) nameInput.value = existingName;

  modal.classList.add('visible');

  const submitBtn = document.getElementById('spSubmitBtn');
  const errEl = document.getElementById('spError');

  const handleSubmit = async () => {
    const name = document.getElementById('spName')?.value.trim() || '';
    const grade = document.getElementById('spGrade')?.value || '';
    const classNo = document.getElementById('spClass')?.value.trim() || '';
    const number = document.getElementById('spNumber')?.value.trim() || '';

    if (!name || !grade || !classNo || !number) {
      if (errEl) errEl.textContent = '모든 항목을 입력해 주세요.';
      return;
    }
    if (!/^\d+$/.test(classNo) || !/^\d+$/.test(number)) {
      if (errEl) errEl.textContent = '반과 번호는 숫자로 입력해 주세요.';
      return;
    }

    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '저장 중...'; }
    if (errEl) errEl.textContent = '';
    try {
      await saveStudentProfile(email, { name, grade, classNo, number });
      modal.classList.remove('visible');
      submitBtn.removeEventListener('click', handleSubmit);
      onComplete();
    } catch (err) {
      if (errEl) errEl.textContent = err.message;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '저장'; }
    }
  };

  submitBtn?.addEventListener('click', handleSubmit);
}

async function acceptSession(session, onSuccess) {
  const user = session?.user;
  if (!user) return false;

  const email = user.email || '';

  // 관리자 등록/도메인 자동가입 단계에서 실제로 실패한 구체적인 사유가 있으면
  // 보관해 둔다. 아래 "역할 판별" 단계의 일반적인 "승인되지 않은 계정입니다"
  // 메시지가 이 구체적인 에러를 조용히 덮어써 버려서 진짜 원인이 보이지 않는
  // 문제가 있었음 — 이 변수로 우선순위를 지킨다.
  let specificError = null;

  if (!email) {
    await supabase.auth.signOut();
    setLoggedOutUI();
    showLoginError('이메일 정보를 가져오지 못했습니다. Google 계정의 이메일 권한을 확인해 주세요.');
    return false;
  }

  // ── 최초 관리자 등록 대기 중이면 admins 테이블에 등록 ──────
  if (sessionStorage.getItem(ADMIN_SETUP_PENDING_KEY) === '1') {
    sessionStorage.removeItem(ADMIN_SETUP_PENDING_KEY);
    const alreadyAdmin = await isApprovedAdmin(email);
    if (!alreadyAdmin) {
      try {
        const { registerFirstAdmin } = await import('./sheets.js');
        await registerFirstAdmin({ email, name: extractDisplayName(user), authMethod: 'google' });
        adminExistsCache = true;
      } catch (err) {
        console.error('최초 관리자 등록 실패:', err);
        specificError = `관리자 등록에 실패했습니다: ${err.message || '알 수 없는 오류'}`;
        showLoginError(specificError);
      }
    }
    // 관리자 등록 화면에서 함께 입력한 학교 도메인 설정 저장 (있을 때만)
    const domainSettingsRaw = sessionStorage.getItem(ADMIN_SETUP_DOMAIN_KEY);
    if (domainSettingsRaw) {
      sessionStorage.removeItem(ADMIN_SETUP_DOMAIN_KEY);
      try {
        const { saveSchoolDomainSettings } = await import('./sheets.js');
        await saveSchoolDomainSettings(JSON.parse(domainSettingsRaw));
      } catch (err) {
        console.error('학교 도메인 설정 저장 실패:', err);
      }
    }
  }

  // ── 교사/학생 Google 계정 회원가입 신청 대기 처리 ─────────
  const googleSignupRaw = sessionStorage.getItem(GOOGLE_SIGNUP_PENDING_KEY);
  if (googleSignupRaw) {
    sessionStorage.removeItem(GOOGLE_SIGNUP_PENDING_KEY);
    try {
      const profile = JSON.parse(googleSignupRaw);
      const googleDomain = normalizeEmail(profile.googleDomain || await getGoogleDomain());
      if (!isEmailInDomain(email, googleDomain)) {
        throw new Error(`@${googleDomain} 학교 Google 계정으로만 신청할 수 있습니다.`);
      }

      const sheets = await import('./sheets.js');
      if (profile.role === 'teacher') {
        const dup = await sheets.checkTeacherEmailExists(email);
        if (dup.exists) throw new Error(dup.reason || '이미 신청 또는 등록된 Google 계정입니다.');
        await sheets.submitTeacherRequest({
          email,
          name: profile.name,
          subjectArea: profile.subjectArea,
          authMethod: 'google',
          message: profile.message || '',
          homeroomGrade: profile.homeroomGrade || '',
          homeroomClass: profile.homeroomClass || '',
        });
      } else {
        const dup = await sheets.checkStudentEmailExists(email);
        if (dup.exists) throw new Error(dup.reason || '이미 신청 또는 등록된 Google 계정입니다.');
        await sheets.submitStudentRequest({
          email,
          name: profile.name,
          grade: profile.grade,
          classNo: profile.classNo,
          number: profile.number,
          authMethod: 'google',
        });
      }

      await supabase.auth.signOut();
      setLoggedOutUI();
      showLoginError('Google 계정 가입 신청이 완료되었습니다. 관리자 승인 후 Google 계정으로 로그인할 수 있습니다.');
      return false;
    } catch (err) {
      await supabase.auth.signOut();
      setLoggedOutUI();
      showLoginError(`Google 계정 가입 신청 실패: ${err.message}`);
      return false;
    }
  }

  // ── 역할 판별 (전부 DB 승인 기반) ────────────────────
  // (예전에는 여기서 "학교 도메인 자동가입" 대기 플래그를 처리해 도메인이
  //  일치하면 관리자 승인을 건너뛰었으나, 이제 모든 계정이 동일하게
  //  아이디.ID_SUFFIX@도메인 형식으로 생성되므로 도메인 일치는 더 이상 식별
  //  기준이 될 수 없다. 교사/학생 가입은 항상 pending 승인 큐를 거친다.)
  let role = null;

  if (await isApprovedAdmin(email)) {
    role = 'admin';
  } else if (await isApprovedTeacher(email)) {
    role = 'teacher';
  } else if (await isApprovedStudent(email)) {
    role = 'student';
  }

  if (!role) {
    await supabase.auth.signOut();
    setLoggedOutUI();
    showLoginError(
      specificError ||
      `아직 승인되지 않은 계정입니다.\n` +
      `회원가입 후 관리자 승인이 완료되면 로그인할 수 있습니다.`
    );
    return false;
  }
  // ───────────────────────────────────────────────────

  // 헤더의 "수강신청 바로가기" 버튼용 개인별 URL(2026-07 추가). admin은 신청 기록이
  // 없으므로 조회하지 않고 빈 문자열로 둔다(버튼 자체가 숨겨짐).
  const portalUrl = await fetchMyPortalUrl(email, role).catch(() => '');

  const nextUser = toUserProfile(user, role, portalUrl);
  const isSameUser = normalizeEmail(currentUser?.email) === normalizeEmail(nextUser.email);
  currentUser = nextUser;
  sessionStorage.setItem('jjghs_user', JSON.stringify(currentUser));
  hideLoginError();

  if (!hasActiveSession || !isSameUser) {
    hasActiveSession = true;
    hideAuthCheck();

    // 학생 최초 로그인: 프로필 미완성이면 가입 신청 때 입력한 학년·반·번호로 자동 채움.
    // (학년은 더 이상 로그인 시점에 다시 "선택"받지 않는다 — 가입 신청서에 적은 값을
    // 그대로 사용한다.) 가입 신청 내역을 찾을 수 없거나 값이 불완전한 경우에만
    // 예외적으로 수동 입력 모달을 띄운다(가입 경로 변경 등으로 신청 기록이 없는 과거 계정 대비).
    if (role === 'student') {
      const dbProfile = await fetchStudentProfileFromDB(email);
      if (needsStudentProfile(dbProfile)) {
        const requestInfo = await fetchMyStudentRequest(email).catch(() => null);
        const hasFullRequestInfo = requestInfo && requestInfo.grade && requestInfo.classNo && requestInfo.number;

        if (hasFullRequestInfo) {
          try {
            await saveStudentProfile(email, {
              name: requestInfo.name || nextUser.name || '',
              grade: requestInfo.grade,
              classNo: requestInfo.classNo,
              number: requestInfo.number,
            });
          } catch (err) {
            console.error('가입 신청 정보로 프로필 자동 저장 실패:', err.message);
            const existingName = nextUser.name || '';
            showStudentProfileModal(email, existingName, async () => {
              await syncDisplayNameFromProfile(email, role);
              onSuccess?.(currentUser);
            });
            return true;
          }
        } else {
          const existingName = nextUser.name || '';
          showStudentProfileModal(email, existingName, async () => {
            await syncDisplayNameFromProfile(email, role);
            onSuccess?.(currentUser);
          });
          return true;
        }
      }
    }

    await syncDisplayNameFromProfile(email, role);
    onSuccess?.(currentUser);
  }
  return true;
}

function initAuthStateListener() {
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') {
      setLoggedOutUI();
      return;
    }
    if (!session?.user) return;
    setTimeout(() => {
      acceptSession(session, onLoginSuccess).catch(err => {
        console.error('세션 처리 실패:', err);
      });
    }, 0);
  });
}

async function _initSessionCheck() {
  const oauthCallback = isOAuthCallbackUrl();

  const oauthError = readOAuthErrorFromUrl();
  if (oauthError) {
    showLoginError(`로그인 오류: ${oauthError}`);
    _resolveWithLogin();
    return;
  }

  const saved = sessionStorage.getItem('jjghs_user');
  if (saved) {
    try { currentUser = JSON.parse(saved); } catch { sessionStorage.removeItem('jjghs_user'); }
  }

  const { data, error } = await withTimeout(supabase.auth.getSession(), 12000, '로그인 세션 확인');
  if (error) {
    console.error('Supabase 세션 조회 실패:', error);
    showLoginError(`세션 확인 실패: ${error.message || '알 수 없는 오류'}`);
    _resolveWithLogin();
    return;
  }

  const ok = await acceptSession(data.session, onLoginSuccess);
  if (!ok) {
    if (oauthCallback) {
      const fallbackTimer = setTimeout(() => {
        if (!hasActiveSession) {
          showLoginError('로그인 처리 중 오류가 발생했습니다. 다시 시도해 주세요.');
          _resolveWithLogin();
        }
      }, 8000);
      const { data: listenerData } = supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
          clearTimeout(fallbackTimer);
          listenerData.subscription.unsubscribe();
        }
      });
    } else {
      _resolveWithLogin();
    }
  }
}

// ── 학교 도메인 조회 (회원가입/로그인 화면에서 사용) ──
// 최초 관리자 등록 시 저장된 app_settings.school_domain을 그대로 돌려준다.
// (예전의 "자동승인" enabled 플래그는 더 이상 분기에 쓰지 않음 — 모든 계정이 이
//  도메인을 기반으로 생성되므로 도메인 일치 여부로 승인을 가를 이유가 없어졌다.
//  관리자 승인 절차(teacher_requests/student_requests pending)는 이전과 동일하게
//  모든 가입에 그대로 적용된다.)
async function getSchoolDomain() {
  try {
    const { fetchConfig } = await import('./sheets.js');
    const config = await fetchConfig();
    return normalizeEmail(config.school_domain || '');
  } catch (err) {
    console.error('학교 도메인 조회 실패:', err);
    return '';
  }
}

async function getGoogleDomain() {
  try {
    const { fetchConfig } = await import('./sheets.js');
    const config = await fetchConfig();
    return normalizeEmail(config.google_domain || config.school_domain || '');
  } catch (err) {
    console.error('Google 계정 도메인 조회 실패:', err);
    return '';
  }
}

// ── 회원가입 모달 이벤트 바인딩 (교사/학생 공용) ─────
function bindTeacherRequestModal() {
  const openBtn   = document.getElementById('openTeacherRequestBtn');
  const modal     = document.getElementById('teacherRequestModal');
  const closeBtn  = document.getElementById('closeTeacherRequestBtn');
  const submitBtn = document.getElementById('submitTeacherRequestBtn');
  const msgEl     = document.getElementById('trMsg');
  const checkBtn  = document.getElementById('trCheckDupBtn');
  const googleSignupBtn = document.getElementById('googleSignupBtn');
  const dupMsgEl  = document.getElementById('trDupMsg');
  const idInput   = document.getElementById('trEmail');
  const roleTeacherBtn = document.getElementById('suRoleTeacherBtn');
  const roleStudentBtn = document.getElementById('suRoleStudentBtn');
  const teacherSection = document.getElementById('suTeacherSection');
  const studentSection = document.getElementById('suStudentSection');
  const domainBanner     = document.getElementById('suDomainBanner');
  const domainBannerText = document.getElementById('suDomainBannerText');

  if (!openBtn || !modal) return;

  let dupChecked = false; // 중복 확인 완료 여부
  let currentRole = 'teacher';
  let schoolDomain = '';
  let googleDomain = '';

  function updateDomainBanner() {
    if (!domainBanner) return;
    if (schoolDomain) {
      domainBanner.style.display = 'block';
      if (domainBannerText) {
        domainBannerText.textContent =
          `아이디 가입은 "아이디.${getAuthIdSuffix()}@${schoolDomain}" 계정으로 등록됩니다. Google 가입은 @${googleDomain || schoolDomain} 계정만 사용할 수 있습니다.`;
      }
    } else {
      domainBanner.style.display = 'none';
    }
  }

  async function refreshSchoolDomain() {
    schoolDomain = await getSchoolDomain();
    googleDomain = await getGoogleDomain();
    updateDomainBanner();
  }
  refreshSchoolDomain();

  function readSignupProfile({ requireIdPassword = true } = {}) {
    const id = idInput?.value.trim() || '';
    const password = document.getElementById('trPassword')?.value || '';
    const passwordConfirm = document.getElementById('trPasswordConfirm')?.value || '';

    if (requireIdPassword) {
      if (!id) throw new Error('아이디를 입력하세요.');
      if (!isValidPlainId(id)) throw new Error('아이디는 영문/숫자/.,_,- 조합 2~40자로 입력해 주세요.');
      if (!schoolDomain) throw new Error('학교 도메인이 설정되지 않았습니다. 관리자에게 문의하세요.');
      if (!dupChecked) throw new Error('아이디 중복 확인을 먼저 해주세요.');
      if (!password || password.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다.');
      if (password !== passwordConfirm) throw new Error('비밀번호가 일치하지 않습니다.');
    }

    if (currentRole === 'teacher') {
      const name          = document.getElementById('trName')?.value.trim() || '';
      const subjectArea   = document.getElementById('trSubjectArea')?.value || '';
      const homeroomGrade = document.getElementById('trHomeroomGrade')?.value || '';
      const homeroomClass = document.getElementById('trHomeroomClass')?.value.trim() || '';
      if (!name) throw new Error('이름을 입력하세요.');
      let message = '';
      if (homeroomGrade && homeroomClass) message = `담임: ${homeroomGrade}학년 ${homeroomClass}반`;
      else if (homeroomGrade) message = `${homeroomGrade}학년 부장(비담임)`;
      return { role: 'teacher', id, password, name, subjectArea, homeroomGrade, homeroomClass, message };
    }

    const name    = document.getElementById('srName')?.value.trim() || '';
    const grade   = document.getElementById('srGrade')?.value || '';
    const classNo = document.getElementById('srClass')?.value.trim() || '';
    const number  = document.getElementById('srNumber')?.value.trim() || '';
    if (!name || !grade || !classNo || !number) {
      throw new Error('학년·반·번호·이름을 모두 입력하세요.');
    }
    return { role: 'student', id, password, name, grade, classNo, number };
  }

  function setRole(role) {
    currentRole = role;
    dupChecked = false;
    if (dupMsgEl) { dupMsgEl.textContent = ''; dupMsgEl.className = 'tr-dup-msg'; }
    roleTeacherBtn?.classList.toggle('active', role === 'teacher');
    roleStudentBtn?.classList.toggle('active', role === 'student');
    teacherSection?.classList.toggle('active', role === 'teacher');
    studentSection?.classList.toggle('active', role === 'student');
  }

  roleTeacherBtn?.addEventListener('click', () => setRole('teacher'));
  roleStudentBtn?.addEventListener('click', () => setRole('student'));

  // 아이디 변경 시 중복 확인 초기화
  idInput?.addEventListener('input', () => {
    dupChecked = false;
    if (dupMsgEl) { dupMsgEl.textContent = ''; dupMsgEl.className = 'tr-dup-msg'; }
  });

  // 중복 확인 버튼
  checkBtn?.addEventListener('click', async () => {
    const id = idInput?.value.trim() || '';
    if (!id) {
      if (dupMsgEl) { dupMsgEl.textContent = '아이디를 입력하세요.'; dupMsgEl.className = 'tr-dup-msg err'; }
      return;
    }
    if (!isValidPlainId(id)) {
      if (dupMsgEl) { dupMsgEl.textContent = '아이디는 영문/숫자/.,_,- 조합 2~40자로 입력해 주세요.'; dupMsgEl.className = 'tr-dup-msg err'; }
      return;
    }
    if (!schoolDomain) {
      if (dupMsgEl) { dupMsgEl.textContent = '학교 도메인이 설정되지 않았습니다. 관리자에게 문의하세요.'; dupMsgEl.className = 'tr-dup-msg err'; }
      return;
    }
    checkBtn.disabled = true; checkBtn.textContent = '확인 중...';
    try {
      const authEmail = toAuthIdentifier(id, schoolDomain);
      const sheets = await import('./sheets.js');
      const result = currentRole === 'student'
        ? await sheets.checkStudentEmailExists(authEmail)
        : await sheets.checkTeacherEmailExists(authEmail);
      if (result.exists) {
        if (dupMsgEl) { dupMsgEl.textContent = result.reason; dupMsgEl.className = 'tr-dup-msg err'; }
        dupChecked = false;
      } else {
        if (dupMsgEl) { dupMsgEl.textContent = '✅ 사용 가능한 아이디입니다.'; dupMsgEl.className = 'tr-dup-msg ok'; }
        dupChecked = true;
      }
    } catch {
      if (dupMsgEl) { dupMsgEl.textContent = '확인 중 오류가 발생했습니다. 계속 진행하세요.'; dupMsgEl.className = 'tr-dup-msg err'; }
      dupChecked = true; // 오류 시 제출은 허용
    } finally {
      checkBtn.disabled = false; checkBtn.textContent = '중복 확인';
    }
  });

  openBtn.addEventListener('click', () => { setRole('teacher'); refreshSchoolDomain(); modal.classList.add('visible'); });
  closeBtn?.addEventListener('click', () => { modal.classList.remove('visible'); resetTeacherModal(); });
  modal.addEventListener('click', e => {
    if (e.target === modal) { modal.classList.remove('visible'); resetTeacherModal(); }
  });

  // 신청하기 (학교 도메인 자동변환 + 관리자 승인 대기 — 항상 동일한 절차)
  submitBtn?.addEventListener('click', async () => {
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'modal-msg'; }

    let profile;
    try {
      profile = readSignupProfile({ requireIdPassword: true });
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message; msgEl.className = 'modal-msg error'; }
      return;
    }
    const authEmail = toAuthIdentifier(profile.id, schoolDomain);

    try {
      if (profile.role === 'teacher') {
        submitBtn.disabled = true; submitBtn.textContent = '신청 중...';
        await signUpWithEmail(profile.id, profile.password, schoolDomain);
        const { submitTeacherRequest } = await import('./sheets.js');
        await submitTeacherRequest({
          email: authEmail,
          name: profile.name,
          subjectArea: profile.subjectArea,
          authMethod: 'email',
          message: profile.message,
          homeroomGrade: profile.homeroomGrade,
          homeroomClass: profile.homeroomClass,
        });
      } else {
        submitBtn.disabled = true; submitBtn.textContent = '신청 중...';
        await signUpWithEmail(profile.id, profile.password, schoolDomain);
        const { submitStudentRequest } = await import('./sheets.js');
        await submitStudentRequest({
          email: authEmail,
          name: profile.name,
          grade: profile.grade,
          classNo: profile.classNo,
          number: profile.number,
          authMethod: 'email',
        });
      }

      if (msgEl) {
        msgEl.textContent = '신청이 완료됐습니다. 관리자 승인을 기다려 주세요.';
        msgEl.className = 'modal-msg success';
      }
      submitBtn.textContent = '신청 완료';
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message; msgEl.className = 'modal-msg error'; }
      submitBtn.disabled = false; submitBtn.textContent = '신청하기';
    }
  });

  googleSignupBtn?.addEventListener('click', async () => {
    if (msgEl) { msgEl.textContent = ''; msgEl.className = 'modal-msg'; }
    let profile;
    try {
      profile = readSignupProfile({ requireIdPassword: false });
      const domain = await getGoogleDomain();
      if (!domain) throw new Error('학교 Google 계정 도메인이 설정되지 않았습니다. 관리자에게 문의하세요.');
      profile.googleDomain = domain;
    } catch (err) {
      if (msgEl) { msgEl.textContent = err.message; msgEl.className = 'modal-msg error'; }
      return;
    }
    sessionStorage.setItem(GOOGLE_SIGNUP_PENDING_KEY, JSON.stringify(profile));
    signInWithGoogle();
  });
}

function resetTeacherModal() {
  ['trName', 'trEmail', 'trPassword', 'trPasswordConfirm', 'trHomeroomClass', 'srName', 'srClass', 'srNumber'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['trSubjectArea', 'trHomeroomGrade', 'srGrade'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.selectedIndex = 0;
  });
  const dupMsgEl = document.getElementById('trDupMsg');
  if (dupMsgEl) { dupMsgEl.textContent = ''; dupMsgEl.className = 'tr-dup-msg'; }
  const msgEl = document.getElementById('trMsg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'modal-msg'; }
  const submitBtn = document.getElementById('submitTeacherRequestBtn');
  if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '신청하기'; }
}

// ── 아이디/비밀번호 로그인 섹션 바인딩 (항상 노출, 교사·학생 공용) ──
// 입력된 아이디는 학교 도메인과 결합해 실제 Supabase Auth 이메일
// (아이디.ID_SUFFIX@도메인)로 변환된 뒤 로그인을 시도한다.
function bindEmailLoginSection() {
  const submitBtn = document.getElementById('emailLoginSubmitBtn');

  submitBtn?.addEventListener('click', async () => {
    const id = document.getElementById('emailLoginInput')?.value.trim() || '';
    const password = document.getElementById('passwordLoginInput')?.value || '';
    if (!id || !password) { showLoginError('아이디와 비밀번호를 입력해 주세요.'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = '로그인 중...';
    const domain = await getSchoolDomain();
    if (!domain) {
      showLoginError('학교 도메인이 설정되지 않았습니다. 관리자에게 문의하세요.');
      submitBtn.disabled = false;
      submitBtn.textContent = '로그인';
      return;
    }
    const ok = await signInWithEmail(id, password, domain);
    if (!ok) {
      submitBtn.disabled = false;
      submitBtn.textContent = '로그인';
    }
  });
}

export function initAuth(onSuccess) {
  onLoginSuccess = onSuccess;
  if (initialized) return;
  initialized = true;

  renderLoginButton();
  bindAdminSetupScreen();
  bindTeacherRequestModal();
  bindEmailLoginSection();
  initAuthStateListener();
  _initSessionCheck().catch(err => {
    console.error('인증 초기화 실패:', err);
    _resolveWithLogin();
  });
}

export async function requestAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

export async function signOut() {
  await supabase.auth.signOut();
  setLoggedOutUI();
}

export function getUser() {
  return currentUser;
}

// ── 마이페이지: 본인 비밀번호/표시 이름 변경 (2026-07 추가) ──────────
// 이미 로그인된 세션(access token)이 있으므로 기존 비밀번호 재확인 없이 바로
// 변경 가능 — Supabase Auth의 updateUser()가 세션 토큰으로 본인 계정만
// 변경할 수 있음을 보장한다.

/** 로그인한 사용자 본인의 비밀번호 변경. */
export async function updateMyPassword(newPassword) {
  const pw = String(newPassword || '');
  if (pw.length < 6) {
    throw new Error('비밀번호는 6자 이상이어야 합니다.');
  }
  const { error } = await supabase.auth.updateUser({ password: pw });
  if (error) throw new Error(`비밀번호 변경 실패: ${error.message}`);
}

/** 로그인한 사용자 본인의 표시 이름(user_metadata.name) 갱신. 마이페이지에서
 *  이름을 바꾸면 헤더의 사용자 이름(#userName)도 함께 최신 값으로 보이도록
 *  한다 — 이름 자체의 "진짜" 저장 위치는 teacher_requests.name /
 *  student_selections.name이고, 이 메타데이터는 헤더 표시용 보조 값일 뿐이다.
 *  실패해도 프로필 저장 자체를 막지 않도록 호출부에서 별도로 감싸 처리한다. */
export async function updateMyDisplayName(name) {
  const cleanName = String(name || '').trim();
  const { error } = await supabase.auth.updateUser({ data: { name: cleanName } });
  if (error) throw new Error(`표시 이름 갱신 실패: ${error.message}`);
  // 세션 캐시(sessionStorage.jjghs_user)에도 반영해, 새로고침 전까지도 일관되게 보이도록 함
  if (currentUser) {
    currentUser = { ...currentUser, name: cleanName, given_name: cleanName };
    sessionStorage.setItem('jjghs_user', JSON.stringify(currentUser));
  }
}
