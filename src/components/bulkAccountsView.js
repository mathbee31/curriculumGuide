// src/components/bulkAccountsView.js
//
// 관리자 탭 "회원 관리" 안에 마운트되는 "계정 일괄 생성" 섹션.
// 학생-교사정보.xlsx 형식(시트 이름 "N학년-학생"/"N학년-교사")의 엑셀 파일을 업로드해
// Supabase Auth 계정 + teacher_emails/student_emails(즉시 승인) + teacher_requests/
// student_requests(approved)까지 한 번에 만든다. 실제 생성은 api/bulk-create-accounts.js
// (Vercel 서버리스 함수, service_role 키 사용)를 거친다 — 클라이언트(anon key)만으로
// signUp()을 반복 호출하면 Supabase 기본 이메일 발송 한도(시간당 2건)에 곧바로 걸려
// 수백 명 규모의 일괄 생성이 사실상 불가능하기 때문이다. 자세한 설명은
// api/bulk-create-accounts.js 상단 주석과 src/sheets.js의 bulkCreateAccounts() 주석 참고.
//
// 흐름: 파일 선택 → 브라우저에서 파싱(미리보기: 역할/학년별 건수, 경고) → 관리자가
// "일괄 생성 시작" 클릭 → 배치 단위로 서버 호출하며 진행률 표시 → 완료 후 결과 요약
// (생성/건너뜀/오류 건수) + 문제 있는 행 상세 목록.
//
// dataManageView.js와 동일한 CSS 클래스(member-section, dm-section-desc,
// dm-upload-body, dm-file-label, dm-parse-status, dm-warning-box, dm-cohort-card,
// dm-apply-bar, dm-apply-msg 등)를 그대로 재사용하므로 index.html에 새 스타일을
// 추가하지 않아도 된다.

import { escapeHtml } from '../utils/normalize.js';
import { parseAccountsWorkbook, summarizeAccounts } from '../utils/accountsXlsxParser.js';

export function renderBulkAccountsSection(root, {
  fetchTeacherEmailsList,
  fetchStudentEmailsCount,
  bulkCreateAccounts,
  onApplied,
} = {}) {
  if (!root) return;
  let applying = false;

  root.innerHTML = `
    <section class="member-section" id="bulkAcctSection">
      <div class="member-section-head">
        <h3>학생·교사 계정 일괄 생성</h3>
        <button class="teacher-refresh-btn" id="bulkAcctRefreshBtn" type="button">새로고침</button>
      </div>
      <p class="dm-section-desc">
        학생-교사정보.xlsx와 같은 형식(시트 이름 "N학년-학생" / "N학년-교사", 1행은 헤더,
        2행부터 데이터, 열 순서 학년·반·번호·이름·ID·PW·URL 또는 담임(학년)·담임(반)·고유번호·
        교사명·ID·PW·URL)의 엑셀 파일을 업로드해 계정을 한 번에 생성합니다. URL 열은 실제
        수강신청/결과 확인용 개인별 웹주소로, 로그인 후 헤더의 "수강신청 바로가기" 버튼에
        쓰입니다. 새로 생성된 계정은 관리자 승인 없이 즉시 로그인 가능한 상태로 등록되며,
        이미 등록된 아이디는 비밀번호를 덮어쓰지 않고 건너뛰되(URL만 적혀 있으면 갱신은
        시도합니다), 인원이 많으면 완료까지 다소 시간이 걸릴 수 있습니다 — 진행률이 100%가
        될 때까지 창을 닫지 말고 기다려 주세요.
      </p>
      <div id="bulkAcctCurrentBody"><div class="member-empty">불러오는 중...</div></div>
      <div class="dm-upload-body">
        <label class="dm-file-label" for="bulkAcctFileInput">
          <input id="bulkAcctFileInput" type="file" accept=".xlsx" hidden>
          <span id="bulkAcctFileLabelText">엑셀 파일 선택 (.xlsx)</span>
        </label>
        <div id="bulkAcctParseStatus" class="dm-parse-status"></div>
      </div>
      <div id="bulkAcctPreviewBody"></div>
    </section>
  `;

  const currentBody = root.querySelector('#bulkAcctCurrentBody');
  const fileInput = root.querySelector('#bulkAcctFileInput');
  const fileLabelText = root.querySelector('#bulkAcctFileLabelText');
  const parseStatus = root.querySelector('#bulkAcctParseStatus');
  const previewBody = root.querySelector('#bulkAcctPreviewBody');
  const refreshBtn = root.querySelector('#bulkAcctRefreshBtn');

  async function loadCurrentSummary() {
    if (!currentBody) return;
    currentBody.innerHTML = `<div class="member-empty">불러오는 중...</div>`;
    try {
      const [teacherEmails, studentCount] = await Promise.all([
        Promise.resolve(fetchTeacherEmailsList?.() ?? []),
        Promise.resolve(fetchStudentEmailsCount?.() ?? 0),
      ]);
      currentBody.innerHTML = `
        <div class="dm-current-count">
          현재 등록된 계정: 교사 <strong>${(teacherEmails?.length || 0).toLocaleString('ko-KR')}명</strong> ·
          학생 <strong>${Number(studentCount || 0).toLocaleString('ko-KR')}명</strong>
        </div>
      `;
    } catch (err) {
      currentBody.innerHTML = `<div class="member-empty">현재 현황을 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }
  }

  refreshBtn?.addEventListener('click', () => loadCurrentSummary());

  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    previewBody.innerHTML = '';
    fileLabelText.textContent = file.name;
    parseStatus.innerHTML = `<span class="dm-status-loading">"${escapeHtml(file.name)}" 분석 중...</span>`;

    try {
      const buffer = await file.arrayBuffer();
      const result = await parseAccountsWorkbook(buffer);
      renderPreview(result);
      parseStatus.innerHTML = `<span class="dm-status-ok">분석 완료 — 아래 미리보기를 확인한 뒤 "일괄 생성 시작" 버튼을 눌러주세요.</span>`;
    } catch (err) {
      console.error('계정 엑셀 분석 실패:', err);
      parseStatus.innerHTML = `<span class="dm-status-err">분석 실패: ${escapeHtml(err.message)}</span>`;
    } finally {
      fileInput.value = '';
    }
  });

  function renderPreview(result) {
    const { accounts, warnings, skippedSheets } = result;
    const summary = summarizeAccounts(accounts);

    const warningsHtml = warnings.length
      ? `<div class="dm-warning-box">
          <div class="dm-warning-title">⚠ 확인이 필요한 항목 (${warnings.length}건)</div>
          <ul class="dm-warning-list">${warnings.slice(0, 200).map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
          ${warnings.length > 200 ? `<div class="dm-skipped-note">그 외 ${warnings.length - 200}건 생략</div>` : ''}
        </div>`
      : '';

    const skippedHtml = skippedSheets.length
      ? `<div class="dm-skipped-note">"N학년-학생"/"N학년-교사" 형식이 아니어서 건너뛴 시트: ${skippedSheets.map(escapeHtml).join(', ')}</div>`
      : '';

    previewBody.innerHTML = `
      ${warningsHtml}
      ${skippedHtml}
      <div class="dm-cohort-card">
        <div class="dm-cohort-card-head">
          <div class="dm-cohort-title">생성 대상</div>
          <div class="dm-cohort-diff">총 ${accounts.length.toLocaleString('ko-KR')}건</div>
        </div>
        <div class="member-table-wrap">
          <table class="member-table dm-semester-table">
            <thead><tr><th>구분</th><th>건수</th></tr></thead>
            <tbody>
              ${summary.length
                ? summary.map(s => `<tr><td>${escapeHtml(s.label)}</td><td>${s.count.toLocaleString('ko-KR')}명</td></tr>`).join('')
                : `<tr><td colspan="2">유효한 행이 없습니다.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
      <div class="dm-apply-bar">
        <button class="member-add-btn" id="bulkAcctApplyBtn" type="button" ${accounts.length ? '' : 'disabled'}>일괄 생성 시작</button>
        <span class="dm-apply-msg" id="bulkAcctApplyMsg"></span>
      </div>
      <div id="bulkAcctResultBody"></div>
    `;

    const applyBtn = previewBody.querySelector('#bulkAcctApplyBtn');
    const applyMsg = previewBody.querySelector('#bulkAcctApplyMsg');
    const resultBody = previewBody.querySelector('#bulkAcctResultBody');

    applyBtn?.addEventListener('click', async () => {
      if (applying || !accounts.length) return;

      const confirmed = window.confirm(
        `${accounts.length}명의 계정을 생성합니다. 이미 존재하는 아이디는 건너뛰고, 새 계정은 ` +
        `관리자 승인 없이 즉시 로그인 가능한 상태로 등록됩니다. 계속할까요?`
      );
      if (!confirmed) return;

      applying = true;
      applyBtn.disabled = true;
      applyBtn.textContent = '생성 중...';
      applyMsg.textContent = `0 / ${accounts.length}`;
      applyMsg.className = 'dm-apply-msg';
      resultBody.innerHTML = '';

      try {
        const results = await bulkCreateAccounts(accounts, {
          batchSize: 20,
          onProgress: (done, total) => {
            applyMsg.textContent = `진행 중... ${done.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}`;
          },
        });
        renderResults(resultBody, results);
        const created = results.filter(r => r.status === 'created').length;
        const skipped = results.filter(r => r.status === 'skipped').length;
        const errored = results.filter(r => r.status === 'error').length;
        applyMsg.textContent = `완료 — 생성 ${created} · 건너뜀 ${skipped} · 오류 ${errored}`;
        applyMsg.classList.add(errored ? 'err' : 'ok');
        await loadCurrentSummary();
        await onApplied?.();
      } catch (err) {
        console.error('계정 일괄 생성 실패:', err);
        applyMsg.textContent = `실패: ${err.message}`;
        applyMsg.classList.add('err');
      } finally {
        applying = false;
        applyBtn.disabled = false;
        applyBtn.textContent = '일괄 생성 시작';
      }
    });
  }

  function renderResults(container, results) {
    if (!container) return;
    const problems = results.filter(r => r.status !== 'created');
    if (!problems.length) {
      container.innerHTML = `<div class="dm-current-count">전체 ${results.length.toLocaleString('ko-KR')}건이 모두 새로 생성되었습니다.</div>`;
      return;
    }
    const shown = problems.slice(0, 300);
    container.innerHTML = `
      <div class="member-table-wrap">
        <table class="member-table dm-semester-table">
          <thead><tr><th>아이디</th><th>상태</th><th>메시지</th></tr></thead>
          <tbody>
            ${shown.map(r => `
              <tr>
                <td>${escapeHtml(String(r.id))}</td>
                <td>${r.status === 'skipped' ? '건너뜀' : '오류'}</td>
                <td>${escapeHtml(String(r.message || ''))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${problems.length > shown.length ? `<div class="dm-skipped-note">그 외 ${problems.length - shown.length}건 생략(생성/건너뜀/오류 총계는 위 요약 참고)</div>` : ''}
    `;
  }

  loadCurrentSummary();
}
