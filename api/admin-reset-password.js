// api/admin-reset-password.js
//
// 관리자 탭 "회원 관리"의 "학생 회원 관리"/"교사 계정 관리" 표에서 "수정" 버튼을 눌러
// 개별 학생·교사의 비밀번호를 관리자 권한으로 재설정할 때 호출하는 Vercel 서버리스 함수.
//
// ⚠ 왜 서버 함수가 필요한가:
//   src/auth.js의 updateMyPassword()는 supabase.auth.updateUser()를 쓰는데, 이는 항상
//   "현재 로그인된 세션 본인"의 비밀번호만 바꿀 수 있다 — 관리자가 다른 사용자(학생/교사)의
//   비밀번호를 대신 바꾸는 것은 클라이언트(anon key)로는 불가능하고, service_role 키로
//   Supabase Admin API(/auth/v1/admin/users/{id})를 호출해야 한다. api/bulk-create-accounts.js와
//   같은 이유로 이 별도 서버 함수가 필요하다.
//
// ⚠ SUPABASE_SERVICE_ROLE_KEY는 절대 클라이언트에 노출되면 안 된다 — Vercel 프로젝트
//   Settings → Environment Variables에만 등록하고, src/config.js(클라이언트 번들)에는
//   절대 포함시키지 않는다. bulk-create-accounts.js와 동일한 환경 변수를 그대로 재사용한다.
//
// 요청 형식 (POST, JSON):
//   {
//     accessToken: string,   // 호출한 관리자의 현재 Supabase 세션 access_token
//     targetEmail: string,   // 비밀번호를 바꿀 대상의 Auth 이메일(아이디.ID_SUFFIX@도메인 형식)
//     newPassword: string,   // 새 비밀번호 (6자 이상)
//   }
//
// 응답 형식: { success: true } 또는 { error: string }
//
// ⚠ Supabase Admin API(GoTrue)는 이메일로 사용자를 직접 조회하는 공식 엔드포인트가 없다
//   (버전에 따라 동작이 다른 비공식 filter 파라미터만 있어 신뢰할 수 없음 — 2026-08 확인).
//   그래서 /auth/v1/admin/users를 페이지 단위(최대 1000명씩)로 순회하며 이메일이 일치하는
//   사용자를 찾아 id를 얻은 뒤, /auth/v1/admin/users/{id}를 PUT으로 호출해 비밀번호를
//   바꾼다. 학교 규모(학생·교사 수천 명 이하)에서는 보통 1~2페이지 안에 찾는다.

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

/** GoTrue admin 사용자 목록을 페이지 단위로 순회하며 이메일이 일치하는 사용자의 id를 찾는다.
 *  이메일 필터 쿼리 파라미터가 버전마다 신뢰할 수 없어 직접 순회하는 방식을 쓴다. */
async function findUserIdByEmail(SUPABASE_URL, SERVICE_ROLE_KEY, targetEmail) {
  const lowerTarget = targetEmail.toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 10; page++) {
    const resp = await supabaseFetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      SERVICE_ROLE_KEY
    );
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`사용자 목록 조회 실패 (HTTP ${resp.status}): ${errText}`);
    }
    const data = await resp.json().catch(() => ({}));
    const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
    const found = users.find((u) => String(u?.email || '').toLowerCase() === lowerTarget);
    if (found) return found.id;
    if (users.length < perPage) break; // 마지막 페이지
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'POST 요청만 허용됩니다.' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return sendJson(res, 500, {
      error: '서버에 SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 환경 변수가 설정되지 않았습니다. Vercel 프로젝트 설정에서 추가한 뒤 다시 배포해 주세요.',
    });
  }

  const body = await readJsonBody(req);
  const { accessToken, targetEmail, newPassword } = body || {};

  if (!accessToken) return sendJson(res, 401, { error: '로그인 토큰이 없습니다.' });

  const cleanTargetEmail = String(targetEmail || '').trim().toLowerCase();
  const cleanPassword = String(newPassword || '');
  if (!cleanTargetEmail) return sendJson(res, 400, { error: '대상 계정 이메일이 없습니다.' });
  if (cleanPassword.length < 6) return sendJson(res, 400, { error: '비밀번호는 6자 이상이어야 합니다.' });

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

  // ── 2) 대상 사용자 id 조회 후 비밀번호 갱신 ──────────────────
  try {
    const userId = await findUserIdByEmail(SUPABASE_URL, SERVICE_ROLE_KEY, cleanTargetEmail);
    if (!userId) {
      return sendJson(res, 404, { error: '해당 이메일의 계정을 찾을 수 없습니다.' });
    }

    const updateResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: cleanPassword }),
    });

    if (!updateResp.ok) {
      const errBody = await updateResp.json().catch(() => ({}));
      const msg = String(errBody?.msg || errBody?.message || errBody?.error_description || `HTTP ${updateResp.status}`);
      return sendJson(res, 500, { error: `비밀번호 변경 실패: ${msg}` });
    }
  } catch (err) {
    return sendJson(res, 500, { error: `비밀번호 변경 실패: ${err.message}` });
  }

  return sendJson(res, 200, { success: true });
};
