// api/bulk-create-accounts.js
//
// 관리자 탭 "회원 관리" → "계정 일괄 생성"에서 호출하는 Vercel 서버리스 함수.
//
// ⚠ 왜 서버 함수가 필요한가:
//   클라이언트(anon key)만으로 계정을 만들려면 supabase.auth.signUp()을 써야 하는데,
//   /auth/v1/signup은 Supabase 기본 이메일 공급자 기준 "시간당 2건"(커스텀 SMTP 설정
//   시 시간당 30건)으로 제한된다(Confirm email을 꺼둔 것과 무관하게 이 한도가 적용됨).
//   학생 수백~수천 명을 한 번에 등록해야 하는 이 기능에는 이 한도가 사실상 사용 불가능한
//   수준이라, service_role 키로 Supabase Admin API(/auth/v1/admin/users)를 호출하는
//   이 서버 함수가 반드시 필요하다. Admin API는 위 이메일 발송 한도의 적용을 받지 않고,
//   email_confirm:true로 만들면 확인 메일 자체를 보내지 않는다.
//
// ⚠ SUPABASE_SERVICE_ROLE_KEY는 절대 클라이언트에 노출되면 안 된다 — Vercel 프로젝트
//   Settings → Environment Variables에만 등록하고, scripts/generate-config.mjs가 만드는
//   src/config.js(클라이언트 번들)에는 절대 포함시키지 않는다.
//
// 요청 형식 (POST, JSON):
//   {
//     accessToken: string,          // 호출한 관리자의 현재 Supabase 세션 access_token
//     accounts: Array<{
//       role: 'student' | 'teacher',
//       id: string,                 // 평문 아이디 (auth.js의 toAuthIdentifier와 동일 규칙)
//       password: string,
//       name?: string,
//       grade?: string, classNo?: string, number?: string,   // role === 'student'
//       subjectArea?: string, message?: string,              // role === 'teacher'
//       homeroomGrade?: string, homeroomClass?: string,      // role === 'teacher', 담임/학년부장
//                                                             // 구조화 정보(2026-07 추가). homeroomClass가
//                                                             // 비어있거나 '0'이면 학년부장(비담임).
//       portalUrl?: string,            // 실제 수강신청/결과 확인용 개인별 웹주소(공통, 2026-07 추가)
//     }>
//   }
//   accounts는 한 번에 최대 BATCH_LIMIT개까지만 허용한다 — 서버리스 함수 실행 시간
//   제한(Vercel Hobby 기본 10초, 설정에 따라 최대 60초) 때문에 클라이언트가 여러 번
//   나눠 호출해야 한다(src/sheets.js의 bulkCreateAccounts()가 이 청크 분할을 담당).
//
// 응답 형식: { results: Array<{ id, status: 'created'|'skipped'|'error', message }> }
//   status별 의미:
//     created  — Supabase Auth 계정 생성 + 승인 테이블 등록까지 완료
//     skipped  — 이미 등록된 계정(비밀번호는 덮어쓰지 않음)
//     error    — 생성 실패(응답의 message에 사유)
//
// 멱등성: 이미 만들어진 계정이 섞인 배치를 다시 보내도 안전하다(이미 있으면 skipped로
// 보고하고 승인 테이블도 있으면 상태만 approved로 맞춰준다) — 네트워크 오류로 배치
// 도중 중단됐을 때 admin이 같은 파일로 다시 "적용"을 눌러도 문제없다.
//
// ⚠ skipped(이미 존재하는 Auth 계정)여도 이번 요청이 지목한 role의 teacher_emails/
// student_emails·teacher_requests/student_requests 등록은 매번 다시 시도한다(2026-07
// 버그 수정). 예전에는 skipped일 때 portal_url만 갱신하고 끝냈는데, 그러면 아이디가
// 학생/교사 시트 양쪽에 중복 입력됐거나(과거 accountsXlsxParser.js가 이런 중복을
// 걸러내지 못했음) 이전에 다른 role로 잘못 등록된 계정을 바로잡으려 재업로드한 경우,
// 의도한 role이 끝내 허용목록에 등록되지 않아 "교사로 로그인했는데 학생 화면처럼
// 보이는" 문제가 있었다.
//
// ⚠ 같은 이유(2026-07)로, 이미 존재하는 행을 만나도 grade/class_no/number/homeroom_grade/
// homeroom_class 등 프로필 필드를 최신 업로드 값으로 갱신한다(insertOrApproveRequest 참고).
// 학생은 이 값을 student_requests뿐 아니라 실제 화면·코호트 계산에 쓰이는
// student_selections에도 함께 반영한다(upsertStudentSelectionsProfile 참고) — 그렇지
// 않으면 새 학년도에 진급한 재학생이 재업로드 후에도 계속 작년 학년(코호트)으로 보이는
// 문제가 있었다.

const BATCH_LIMIT = 50;
const DEFAULT_ID_SUFFIX = 'ckfqhfl';

function sendJson(res, status, body) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  // Vercel의 Node 런타임이 자동으로 body를 파싱하지 못한 경우를 대비한 수동 파싱
  return await new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function supabaseFetch(url, serviceRoleKey, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(options.headers || {}),
    },
  });
}

/** teacher_emails / student_emails 처럼 email이 primary key인 허용목록 테이블에
 *  멱등하게 등록(이미 있으면 조용히 통과). */
async function upsertAllowlist(baseUrl, serviceRoleKey, email) {
  const resp = await supabaseFetch(`${baseUrl}?on_conflict=email`, serviceRoleKey, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({ email }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`허용목록 등록 실패 (HTTP ${resp.status}): ${errText}`);
  }
}

/** teacher_requests / student_requests처럼 email에 "함수형(lower(email))" 유니크
 *  인덱스만 있는 테이블은 PostgREST의 on_conflict=email이 그대로 먹지 않으므로,
 *  먼저 insert를 시도하고 유니크 위반(23505/409)이면 status=approved로 갱신한다.
 *
 *  ⚠ 2026-07 버그 수정: 예전에는 이미 존재하는 신청 행을 만나면 status/reviewed_at/
 *  portal_url만 갱신하고 학년·반·번호·담임 배정 등 나머지 필드는 그대로 두었다.
 *  그런데 이 "계정 일괄 생성"은 재학생·재직 교사가 진급/재배정될 때마다 학년-교사정보.xlsx를
 *  새 학년·반·담임 정보로 갱신해 다시 업로드하는 용도로도 쓰인다 — 이미 계정이 있는
 *  행은 전부 "이미 존재"로 걸려 위 정책상 grade/homeroom_grade 등이 새 값으로 전혀
 *  반영되지 않았고, 그 결과 새 학년도가 시작돼도 재학생의 student_requests.grade(교사는
 *  homeroom_grade)가 작년 값에 그대로 머물러 있었다. resolveActiveCohort()/
 *  deriveTeacherHomeroomKind()는 이 값을 기준으로 코호트(입학년도)를 계산하므로,
 *  이 값이 갱신되지 않으면 실제로는 2·3학년인 학생·교사가 계속 당해 연도 신입생(1학년)
 *  코호트로 보이는 문제가 있었다. 이제는 insertBody의 필드 중 빈 문자열이 아닌 값은
 *  모두 patchBody에 포함해 이미 존재하는 행도 최신 업로드 내용으로 갱신한다(값이 빈
 *  문자열인 필드는 실수로 기존 값을 지우지 않도록 그대로 둔다 — portal_url과 동일한 방식). */
async function insertOrApproveRequest(baseUrl, serviceRoleKey, email, insertBody) {
  const insertResp = await supabaseFetch(baseUrl, serviceRoleKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(insertBody),
  });
  if (insertResp.ok) return;

  const errText = await insertResp.text().catch(() => '');
  const isConflict = insertResp.status === 409 || /23505/.test(errText);
  if (!isConflict) {
    throw new Error(`신청 기록 저장 실패 (HTTP ${insertResp.status}): ${errText}`);
  }

  const patchBody = { status: 'approved', reviewed_at: new Date().toISOString() };
  for (const [key, value] of Object.entries(insertBody)) {
    if (key === 'email' || key === 'status' || key === 'reviewed_at') continue;
    if (value !== undefined && value !== null && value !== '') patchBody[key] = value;
  }

  const patchResp = await supabaseFetch(
    `${baseUrl}?email=eq.${encodeURIComponent(email)}`,
    serviceRoleKey,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patchBody),
    }
  );
  if (!patchResp.ok) {
    const patchErrText = await patchResp.text().catch(() => '');
    throw new Error(`신청 상태 갱신 실패 (HTTP ${patchResp.status}): ${patchErrText}`);
  }
}

/** student_selections는 실제로 화면에 쓰이는 "현재" 학생 프로필(학년·반·번호·이름)이자
 *  resolveActiveCohort()가 코호트(입학년도)를 계산할 때 읽는 테이블이다 — student_requests는
 *  가입 신청 당시 기록일 뿐, 로그인 후 한 번이라도 화면을 그리려면 결국 이 테이블 값을 쓴다.
 *  기존에는 이 테이블이 학생의 "최초 로그인" 시점에 auth.js의 acceptSession()을 통해서만
 *  채워졌고, 계정 일괄 생성(재업로드 포함)에서는 건드리지 않았다. 그 결과 이미 한 번이라도
 *  로그인해 이 테이블에 행이 생긴 재학생은, student_requests.grade를 아무리 새로 업로드해도
 *  본인이 실제로 보는 화면(student_selections 기준)은 계속 예전 학년에 머물러 있었다.
 *  ⚠ selected_map(과목 선택 데이터)은 절대 덮어쓰지 않도록 기존 값을 먼저 조회해 그대로
 *  유지한다 — src/sheets.js의 saveStudentProfile()/adminUpdateStudent()와 동일한 패턴. */
async function upsertStudentSelectionsProfile(baseUrl, serviceRoleKey, email, { name, grade, classNo, number }) {
  const getResp = await supabaseFetch(
    `${baseUrl}?email=eq.${encodeURIComponent(email)}&select=name,grade,class_no,number,selected_map`,
    serviceRoleKey
  );
  const existingRows = await getResp.json().catch(() => []);
  const existing = Array.isArray(existingRows) ? existingRows[0] : null;

  // 업로드 행 값이 비어 있으면(malformed row 등) 기존 값을 실수로 지우지 않고 그대로 둔다.
  const nameVal = String(name || '').trim() || existing?.name || '';
  const gradeVal = String(grade || '').trim() || existing?.grade || '';
  const classNoVal = String(classNo || '').trim() || existing?.class_no || '';
  const numberVal = String(number || '').trim() || existing?.number || '';

  const payload = {
    email,
    name: nameVal,
    grade: gradeVal,
    class_no: classNoVal,
    number: numberVal,
    selected_map: existing?.selected_map || {},
    updated_at: new Date().toISOString(),
  };

  const resp = await supabaseFetch(`${baseUrl}?on_conflict=email`, serviceRoleKey, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`학생 프로필(student_selections) 갱신 실패 (HTTP ${resp.status}): ${errText}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'POST 요청만 허용됩니다.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const ID_SUFFIX = String(process.env.ID_SUFFIX || DEFAULT_ID_SUFFIX).trim().toLowerCase() || DEFAULT_ID_SUFFIX;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return sendJson(res, 500, {
      error: '서버에 SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 환경 변수가 설정되지 않았습니다. Vercel 프로젝트 설정에서 추가한 뒤 다시 배포해 주세요.',
    });
  }

  const body = await readJsonBody(req);
  const { accessToken, accounts } = body || {};

  if (!accessToken) return sendJson(res, 401, { error: '로그인 토큰이 없습니다.' });
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return sendJson(res, 400, { error: 'accounts 배열이 비어 있습니다.' });
  }
  if (accounts.length > BATCH_LIMIT) {
    return sendJson(res, 400, { error: `한 번에 최대 ${BATCH_LIMIT}건까지만 처리할 수 있습니다. 더 작은 단위로 나눠 호출해 주세요.` });
  }

  // ── 1) 호출자가 실제로 로그인된 관리자인지 확인 ──────────────
  let callerEmail = '';
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: ANON_KEY || SERVICE_ROLE_KEY,
      },
    });
    if (!userResp.ok) return sendJson(res, 401, { error: '로그인 세션이 유효하지 않습니다. 다시 로그인해 주세요.' });
    const userData = await userResp.json();
    callerEmail = String(userData?.email || '').toLowerCase();
  } catch (err) {
    return sendJson(res, 401, { error: `세션 확인 실패: ${err.message}` });
  }
  if (!callerEmail) return sendJson(res, 401, { error: '로그인 계정 정보를 확인할 수 없습니다.' });

  try {
    const adminCheckResp = await supabaseFetch(
      `${SUPABASE_URL}/rest/v1/admins?email=eq.${encodeURIComponent(callerEmail)}&select=email`,
      SERVICE_ROLE_KEY
    );
    const adminRows = await adminCheckResp.json().catch(() => []);
    if (!Array.isArray(adminRows) || adminRows.length === 0) {
      return sendJson(res, 403, { error: '관리자 계정으로 로그인한 경우에만 사용할 수 있습니다.' });
    }
  } catch (err) {
    return sendJson(res, 500, { error: `관리자 권한 확인 실패: ${err.message}` });
  }

  // ── 2) 학교 도메인 조회 (클라이언트가 보낸 값을 신뢰하지 않고 서버가 직접 확인) ──
  let domain = '';
  try {
    const cfgResp = await supabaseFetch(
      `${SUPABASE_URL}/rest/v1/app_settings?key=eq.school_domain&select=value`,
      SERVICE_ROLE_KEY
    );
    const cfgRows = await cfgResp.json().catch(() => []);
    domain = String(cfgRows?.[0]?.value || '').toLowerCase().trim();
  } catch {
    // 아래에서 domain이 비어 있으면 일괄 에러 처리
  }
  if (!domain) {
    return sendJson(res, 500, { error: '학교 도메인(app_settings.school_domain)이 설정되어 있지 않습니다. 관리자 등록 화면에서 학교 도메인을 먼저 설정해 주세요.' });
  }

  // ── 3) 행별 계정 생성 ─────────────────────────────────────
  const results = [];

  for (const acc of accounts) {
    const plainId = String(acc?.id || '').trim().toLowerCase();
    const password = acc?.password === null || acc?.password === undefined ? '' : String(acc.password);
    const role = acc?.role === 'teacher' ? 'teacher' : 'student';
    const portalUrl = String(acc?.portalUrl || '').trim();

    if (!plainId || !password) {
      results.push({ id: acc?.id || '(빈 아이디)', status: 'error', message: '아이디 또는 비밀번호가 없습니다.' });
      continue;
    }

    const authEmail = `${plainId}.${ID_SUFFIX}@${domain}`;

    try {
      const createResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: authEmail,
          password,
          email_confirm: true,
          user_metadata: { name: String(acc?.name || '') },
        }),
      });

      if (!createResp.ok) {
        const errBody = await createResp.json().catch(() => ({}));
        const msg = String(errBody?.msg || errBody?.message || errBody?.error_description || '');
        const alreadyExists = createResp.status === 422 || /already.*registered|already.*exists/i.test(msg);
        if (alreadyExists) {
          // ⚠ Auth 계정 자체는 이미 있어도(비밀번호는 덮어쓰지 않음), 이번 요청이 지목한
          // role의 허용목록(teacher_emails/student_emails)·신청 테이블 등록은 그대로
          // 시도한다. 예전에는 이 분기에서 portal_url만 갱신하고 끝냈는데, 그러면
          // - 같은 아이디가 학생/교사 시트 양쪽에 중복 입력돼 먼저 처리된 역할로만
          //   Auth 계정이 만들어진 경우(2026-07 이전 accountsXlsxParser.js 버그로 이런
          //   워크북이 이미 배포되어 있었을 수 있음), 또는
          // - 이전에 다른 역할로 잘못 일괄생성됐던 계정을 관리자가 올바른 역할로
          //   바로잡으려고 같은 파일을 다시 "적용"하는 경우
          // 의도한 역할(teacher/student)이 끝내 teacher_emails/student_emails에
          // 등록되지 않아 로그인 시 엉뚱한 화면(예: 교사인데 학생 화면)으로 보이는
          // 문제가 있었다. 아래 upsert들은 멱등이라(on_conflict/이미 approved면 그대로)
          // 여러 번 다시 적용해도 안전하다.
          try {
            if (role === 'teacher') {
              await upsertAllowlist(`${SUPABASE_URL}/rest/v1/teacher_emails`, SERVICE_ROLE_KEY, authEmail);
              await insertOrApproveRequest(`${SUPABASE_URL}/rest/v1/teacher_requests`, SERVICE_ROLE_KEY, authEmail, {
                email: authEmail,
                name: String(acc?.name || ''),
                subject_area: String(acc?.subjectArea || ''),
                auth_method: 'email',
                message: String(acc?.message || ''),
                homeroom_grade: String(acc?.homeroomGrade || ''),
                homeroom_class: String(acc?.homeroomClass || ''),
                portal_url: portalUrl,
                status: 'approved',
                reviewed_at: new Date().toISOString(),
              });
            } else {
              await upsertAllowlist(`${SUPABASE_URL}/rest/v1/student_emails`, SERVICE_ROLE_KEY, authEmail);
              await insertOrApproveRequest(`${SUPABASE_URL}/rest/v1/student_requests`, SERVICE_ROLE_KEY, authEmail, {
                email: authEmail,
                name: String(acc?.name || ''),
                grade: String(acc?.grade || ''),
                class_no: String(acc?.classNo || ''),
                number: String(acc?.number || ''),
                auth_method: 'email',
                portal_url: portalUrl,
                status: 'approved',
                reviewed_at: new Date().toISOString(),
              });
              // ⚠ 이미 로그인해 student_selections에 행이 생긴 재학생은 위 student_requests
              // 갱신만으로는 화면에 반영되지 않는다 — 실제로 화면·코호트 계산에 쓰이는 값도
              // 함께 최신 학년으로 갱신한다(위 upsertStudentSelectionsProfile 주석 참고).
              await upsertStudentSelectionsProfile(`${SUPABASE_URL}/rest/v1/student_selections`, SERVICE_ROLE_KEY, authEmail, {
                name: acc?.name,
                grade: acc?.grade,
                classNo: acc?.classNo,
                number: acc?.number,
              });
            }
            results.push({ id: plainId, status: 'skipped', message: '이미 등록된 계정입니다. (허용목록 상태는 최신화됨)' });
          } catch (err) {
            results.push({ id: plainId, status: 'error', message: `계정은 이미 있으나 허용목록 등록 실패: ${err.message}` });
          }
        } else {
          results.push({ id: plainId, status: 'error', message: msg || `계정 생성 실패 (HTTP ${createResp.status})` });
        }
        continue;
      }

      if (role === 'teacher') {
        await upsertAllowlist(`${SUPABASE_URL}/rest/v1/teacher_emails`, SERVICE_ROLE_KEY, authEmail);
        await insertOrApproveRequest(`${SUPABASE_URL}/rest/v1/teacher_requests`, SERVICE_ROLE_KEY, authEmail, {
          email: authEmail,
          name: String(acc?.name || ''),
          subject_area: String(acc?.subjectArea || ''),
          auth_method: 'email',
          message: String(acc?.message || ''),
          homeroom_grade: String(acc?.homeroomGrade || ''),
          homeroom_class: String(acc?.homeroomClass || ''),
          portal_url: portalUrl,
          status: 'approved',
          reviewed_at: new Date().toISOString(),
        });
      } else {
        await upsertAllowlist(`${SUPABASE_URL}/rest/v1/student_emails`, SERVICE_ROLE_KEY, authEmail);
        await insertOrApproveRequest(`${SUPABASE_URL}/rest/v1/student_requests`, SERVICE_ROLE_KEY, authEmail, {
          email: authEmail,
          name: String(acc?.name || ''),
          grade: String(acc?.grade || ''),
          class_no: String(acc?.classNo || ''),
          number: String(acc?.number || ''),
          auth_method: 'email',
          portal_url: portalUrl,
          status: 'approved',
          reviewed_at: new Date().toISOString(),
        });
        await upsertStudentSelectionsProfile(`${SUPABASE_URL}/rest/v1/student_selections`, SERVICE_ROLE_KEY, authEmail, {
          name: acc?.name,
          grade: acc?.grade,
          classNo: acc?.classNo,
          number: acc?.number,
        });
      }

      results.push({ id: plainId, status: 'created', message: '생성 완료' });
    } catch (err) {
      results.push({ id: plainId, status: 'error', message: err.message || '알 수 없는 오류' });
    }
  }

  return sendJson(res, 200, { results });
};
