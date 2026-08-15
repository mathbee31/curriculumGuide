// src/utils/accountsXlsxParser.js
//
// 관리자 탭 "회원 관리" → "계정 일괄 생성"에서 업로드하는 학생-교사정보.xlsx 형식의
// 엑셀 파일을 브라우저에서 직접 파싱해, api/bulk-create-accounts.js에 그대로 보낼 수
// 있는 계정 행 배열로 변환한다.
//
// 지원 시트 이름: "N학년-학생" / "N학년-교사" (N은 1자리 이상 숫자, 공백은 무시).
// 그 외 이름의 시트는 건너뛰고 skippedSheets에 기록한다.
//
//   학생 시트 열 순서: 학년 | 반 | 번호 | 이름 | ID | PW | URL
//   교사 시트 열 순서: 담임(학년) | 담임(반) | 고유번호(사용 안 함) | 교사명 | ID | PW | URL
//   두 시트 모두 1행은 헤더, 2행부터 데이터.
//
//   URL 열은 실제 수강신청/수강신청 결과 확인용 개인별 웹주소(school-specific portal
//   URL)이다. student_requests.portal_url / teacher_requests.portal_url 컬럼에 저장되어
//   로그인 후 헤더의 "수강신청 바로가기" 버튼과 관리자 "회원 관리"의 URL 개별 수정에
//   쓰인다(2026-07 추가). 비어 있어도 계정 생성 자체는 그대로 진행된다(경고 없음 —
//   부장 등 일부 교사는 개인별 URL이 없을 수 있음).
//
// 교사 시트의 "담임(반)"이 0이면 학급 담임이 아닌 교사(부장 등)로 간주해 담임 표시를
// 만들지 않는다(0보다 크면 "담임: N학년 M반").
//
// xlsx 파싱 자체는 SheetJS(xlsx 패키지)를 esm.sh CDN에서 동적 import한다 — 다른
// */Xlsx*Parser.js 파일들과 동일한 패턴이며, "계정 일괄 생성" 화면을 열고 파일을
// 선택했을 때만 로드되므로 이 기능을 쓰지 않는 사용자에게는 번들 크기 영향이 없다.

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toIntOrDefault(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const STUDENT_SHEET_RE = /^(\d+)\s*학년\s*-\s*학생$/;
const TEACHER_SHEET_RE = /^(\d+)\s*학년\s*-\s*교사$/;
const PLAIN_ID_RE = /^[a-z0-9._-]{2,40}$/i;

/** arrayBuffer(ArrayBuffer) → { accounts, warnings, skippedSheets } */
export async function parseAccountsWorkbook(arrayBuffer) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const accounts = [];
  const warnings = [];
  const skippedSheets = [];
  const seenIds = new Map(); // id(소문자) → 처음 등장한 위치 라벨

  for (const sheetName of workbook.SheetNames) {
    const studentMatch = sheetName.match(STUDENT_SHEET_RE);
    const teacherMatch = !studentMatch && sheetName.match(TEACHER_SHEET_RE);

    if (!studentMatch && !teacherMatch) {
      skippedSheets.push(sheetName);
      continue;
    }

    const ws = workbook.Sheets[sheetName];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r] || [];
      const rowNum = r + 1;
      const rowLabel = `[${sheetName}] ${rowNum}행`;

      if (studentMatch) {
        const [grade, classNo, number, name, id, pw, url] = row;
        const cleanId = text(id);
        const cleanPw = pw === null || pw === undefined ? '' : String(pw);
        const cleanName = text(name);
        const cleanUrl = text(url);

        if (!cleanId && !cleanPw && !cleanName) continue; // 완전히 빈 행

        if (!cleanId || !cleanPw) {
          warnings.push(`${rowLabel}: 아이디 또는 비밀번호가 비어 있어 건너뜁니다.`);
          continue;
        }
        if (!PLAIN_ID_RE.test(cleanId)) {
          warnings.push(`${rowLabel}: 아이디 "${cleanId}"에 허용되지 않는 문자가 포함되어 있을 수 있습니다(영문/숫자/.,_,- 2~40자 권장).`);
        }
        const idKey = cleanId.toLowerCase();
        if (seenIds.has(idKey)) {
          // ⚠ 아이디는 도메인과 결합해 Supabase Auth 계정 하나로 변환되므로(toAuthIdentifier),
          // 같은 아이디가 학생/교사 시트를 가리지 않고 중복되면 실제로는 "같은 계정"이 된다.
          // 예전에는 경고만 남기고 그대로 accounts에 다시 push해서, 처리 순서상 나중에
          // 처리되는 쪽(예: 교사)이 서버에서 "이미 존재함(skipped)"으로 건너뛰어지고 그
          // 역할로는 전혀 등록되지 않는 문제가 있었다(→ 교사로 로그인해도 학생 화면처럼
          // 보이는 원인). 지금은 경고 문구("하나만 생성되고 나머지는 건너뜁니다")대로
          // 실제로 건너뛴다(처음 등장한 것만 accounts에 남김).
          warnings.push(`${rowLabel}: 아이디 "${cleanId}"가 ${seenIds.get(idKey)}과(와) 중복됩니다(하나만 생성되고 나머지는 건너뜁니다).`);
          continue;
        }
        seenIds.set(idKey, rowLabel);

        accounts.push({
          role: 'student',
          id: cleanId,
          password: cleanPw,
          name: cleanName,
          grade: text(grade),
          classNo: text(classNo),
          number: text(number),
          portalUrl: cleanUrl,
          sheetName,
          rowNum,
        });
      } else {
        const [hGrade, hClass, , name, id, pw, url] = row; // 3번째 열(고유번호)은 사용하지 않음
        const cleanId = text(id);
        const cleanPw = pw === null || pw === undefined ? '' : String(pw);
        const cleanName = text(name);
        const cleanUrl = text(url);

        if (!cleanId && !cleanPw && !cleanName) continue;

        if (!cleanId || !cleanPw) {
          warnings.push(`${rowLabel}: 아이디 또는 비밀번호가 비어 있어 건너뜁니다.`);
          continue;
        }
        if (!PLAIN_ID_RE.test(cleanId)) {
          warnings.push(`${rowLabel}: 아이디 "${cleanId}"에 허용되지 않는 문자가 포함되어 있을 수 있습니다(영문/숫자/.,_,- 2~40자 권장).`);
        }
        const idKey = cleanId.toLowerCase();
        if (seenIds.has(idKey)) {
          // (학생 시트 쪽과 동일한 이유로 실제로 건너뜀 — 위 학생 분기 주석 참고)
          warnings.push(`${rowLabel}: 아이디 "${cleanId}"가 ${seenIds.get(idKey)}과(와) 중복됩니다(하나만 생성되고 나머지는 건너뜁니다).`);
          continue;
        }
        seenIds.set(idKey, rowLabel);

        const gradeText = text(hGrade);
        const classNum = toIntOrDefault(hClass, 0);
        const message = classNum > 0
          ? `담임: ${gradeText}학년 ${classNum}반`
          : (gradeText ? `${gradeText}학년 부장(비담임)` : '');

        // 담임/학년부장 구조화 정보(2026-07 추가) — teacher_requests.homeroom_grade/
        // homeroom_class에 그대로 저장되어, 로그인 후 탭별 데이터 제한에 쓰인다.
        // gradeText가 비어 있으면(담임도 부장도 아닌 일반 교사) 둘 다 빈 문자열로 둔다.
        const homeroomGrade = gradeText;
        const homeroomClass = !gradeText ? '' : (classNum > 0 ? String(classNum) : '0');

        accounts.push({
          role: 'teacher',
          id: cleanId,
          password: cleanPw,
          name: cleanName,
          subjectArea: '',
          message,
          homeroomGrade,
          homeroomClass,
          portalUrl: cleanUrl,
          sheetName,
          rowNum,
        });
      }
    }
  }

  return { accounts, warnings, skippedSheets };
}

/** 미리보기용 요약 — 역할/학년별 건수 */
export function summarizeAccounts(accounts) {
  const order = [];
  const counts = new Map();
  for (const a of accounts) {
    const key = a.role === 'teacher' ? '교사' : `${a.grade || '?'}학년 학생`;
    if (!counts.has(key)) order.push(key);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return order.map(key => ({ label: key, count: counts.get(key) }));
}
