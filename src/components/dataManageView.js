// src/components/dataManageView.js
//
// 관리자 탭 → "데이터 관리" 서브탭. 아래 네 가지 엑셀 파일을 업로드해 각각의
// Supabase 테이블을 최초 설정하거나 갱신하는 UI.
//
//   1) curriculum-cohorts.xlsx                 → semester_courses (교육과정, 코호트별 전체 교체)
//   2) university-recommendations.xlsx         → university_recommendations (대학 추천과목, 테이블 전체 교체)
//   3) university-recommendations-series.xlsx  → series_reflected_matrix (계열별 반영과목, 테이블 전체 교체)
//   4) 참고사이트 시트가 있는 엑셀(예: 참고자료1.xlsx) → links (참고 탭, 테이블 전체 교체)
//
// 공통 흐름: 파일 선택 → (브라우저에서) 파싱 → 미리보기(현재 DB 대비 변화량 + 경고 목록)
// → 관리자가 확인 후 "적용" 클릭 → 전체 교체(delete-then-insert). 실제 Supabase 반영
// 전에는 아무 것도 쓰지 않는다.
//
// ⚠ 2)와 3)은 서로 다른 테이블이지만 내용상 연결돼 있다 — university_recommendations의
// "반영과목" 컬럼 중 일부는 series_reflected_matrix 데이터로 보강된다(자세한 내용은
// utils/universityXlsxParser.js 상단 주석 참고). 이 보강은 "대학 추천과목" 파일을 파싱할
// 때 그 시점에 DB에 저장돼 있는 series_reflected_matrix를 조회해서 이뤄지므로, 두 파일을
// 반드시 같이 업로드할 필요는 없다 — 다만 반영과목 파일을 나중에 갱신하면, 이미 반영된
// 대학 추천과목의 reflected 값은 자동으로 갱신되지 않는다(대학 추천과목을 다시 적용해야
// 최신 반영과목 데이터가 반영됨). 이는 코드 상단 및 아래 안내 문구에 명시한다.

import { escapeHtml } from '../utils/normalize.js';
import { parseCohortWorkbook, summarizeCohortSemesters } from '../utils/cohortXlsxParser.js';
import {
  parseUniversityRecommendationsWorkbook,
  parseSeriesMatrixWorkbook,
  buildReflectedLookupFromStoredRows,
} from '../utils/universityXlsxParser.js';
import { parseLinksWorkbook } from '../utils/linksXlsxParser.js';

export function renderDataManageView(container, {
  fetchConfig,
  saveAppSettings,
  fetchCohortSummary,
  fetchCohortRows,
  replaceCohortCourses,
  fetchUniversitySummary,
  fetchUniversityRows,
  replaceUniversityRecommendations,
  fetchSeriesSummary,
  fetchSeriesRows,
  replaceSeriesMatrix,
  fetchSeriesMatrixRows, // 이미 저장된 반영과목(camelCase 행) 조회 — 대학 추천과목 보강용
  fetchLinksSummary,
  fetchLinkRows,
  replaceLinks,
  onApplied,
} = {}) {
  if (!container) return;

  container.innerHTML = `
    <div class="teacher-wrap">
      <div class="teacher-header">
        <div>
          <h2>데이터 관리</h2>
          <p class="teacher-desc">
            학교의 교육과정·대학 추천과목·참고사이트 원본 엑셀을 업로드해 최초 설정하거나
            이후 변경 사항을 갱신합니다. 모든 업로드는 파싱 결과를 먼저 미리보기로 보여주고,
            "적용"을 눌러야 실제로 Supabase에 반영됩니다.
          </p>
        </div>
      </div>

      <div id="dmSettingsSection"></div>
      <div id="dmCurriculumSection"></div>
      <div id="dmUnivSection"></div>
      <div id="dmSeriesSection"></div>
      <div id="dmLinksSection"></div>
    </div>
  `;

  const settingsEl = container.querySelector('#dmSettingsSection');
  const curriculumEl = container.querySelector('#dmCurriculumSection');
  const univEl = container.querySelector('#dmUnivSection');
  const seriesEl = container.querySelector('#dmSeriesSection');
  const linksEl = container.querySelector('#dmLinksSection');

  setupBasicSettingsSection(settingsEl, { fetchConfig, saveAppSettings, onApplied });

  setupCohortCurriculumSection(curriculumEl, {
    fetchCohortSummary,
    fetchCohortRows,
    replaceCohortCourses,
    onApplied,
  });

  setupUniversityRecommendationsSection(univEl, {
    fetchUniversitySummary,
    fetchUniversityRows,
    replaceUniversityRecommendations,
    fetchSeriesMatrixRows,
    onApplied,
  });

  setupSeriesMatrixSection(seriesEl, {
    fetchSeriesSummary,
    fetchSeriesRows,
    replaceSeriesMatrix,
    onApplied,
  });

  setupLinksSection(linksEl, {
    fetchLinksSummary,
    fetchLinkRows,
    replaceLinks,
    onApplied,
  });
}

const DIFF_SAMPLE_LIMIT = 20;

function compareValue(value) {
  if (Array.isArray(value)) return value.map(v => String(v ?? '').trim()).filter(Boolean).join('|');
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return String(value).trim();
}

function diffRows(existingRows = [], nextRows = [], { keyFn, labelFn, fields }) {
  const existingMap = new Map();
  const nextMap = new Map();
  for (const row of existingRows || []) {
    const key = keyFn(row);
    if (key) existingMap.set(key, row);
  }
  for (const row of nextRows || []) {
    const key = keyFn(row);
    if (key) nextMap.set(key, row);
  }

  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, row] of nextMap.entries()) {
    const prev = existingMap.get(key);
    if (!prev) {
      added.push({ key, label: labelFn(row), next: row });
      continue;
    }
    const changes = [];
    for (const field of fields) {
      const before = compareValue(field.get(prev));
      const after = compareValue(field.get(row));
      if (before !== after) changes.push({ label: field.label, before, after });
    }
    if (changes.length) changed.push({ key, label: labelFn(row), before: prev, next: row, changes });
  }

  for (const [key, row] of existingMap.entries()) {
    if (!nextMap.has(key)) removed.push({ key, label: labelFn(row), before: row });
  }

  return { added, removed, changed };
}

function renderDiffSummary(diff, {
  title = '변화 비교',
  emptyText = '기존 자료와 새 업로드 자료의 내용 차이가 없습니다.',
} = {}) {
  if (!diff) return '';
  const total = diff.added.length + diff.removed.length + diff.changed.length;
  const rows = [
    ...diff.added.slice(0, DIFF_SAMPLE_LIMIT).map(item => ({
      type: '추가',
      label: item.label,
      detail: '기존 자료에 없던 행입니다.',
    })),
    ...diff.removed.slice(0, DIFF_SAMPLE_LIMIT).map(item => ({
      type: '삭제',
      label: item.label,
      detail: '새 업로드 자료에는 없는 기존 행입니다.',
    })),
    ...diff.changed.slice(0, DIFF_SAMPLE_LIMIT).map(item => ({
      type: '변경',
      label: item.label,
      detail: item.changes
        .slice(0, 3)
        .map(change => `${change.label}: ${change.before || '(빈 값)'} → ${change.after || '(빈 값)'}`)
        .join(' / '),
    })),
  ];

  return `
    <div class="dm-cohort-card">
      <div class="dm-cohort-card-head">
        <div class="dm-cohort-title">${escapeHtml(title)}</div>
        <div class="dm-cohort-diff">추가 ${diff.added.length} · 삭제 ${diff.removed.length} · 변경 ${diff.changed.length}</div>
      </div>
      ${total === 0
        ? `<div class="member-empty">${escapeHtml(emptyText)}</div>`
        : `<div class="member-table-wrap">
            <table class="member-table dm-semester-table">
              <thead><tr><th>구분</th><th>대상</th><th>내용</th></tr></thead>
              <tbody>
                ${rows.map(row => `
                  <tr>
                    <td>${escapeHtml(row.type)}</td>
                    <td>${escapeHtml(row.label)}</td>
                    <td>${escapeHtml(row.detail)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          ${total > rows.length ? `<div class="dm-cohort-sheets">대표 ${rows.length}건만 표시했습니다. 전체 변화 ${total}건</div>` : ''}`
      }
    </div>
  `;
}

function setupBasicSettingsSection(root, { fetchConfig, saveAppSettings, onApplied }) {
  if (!root) return;
  root.innerHTML = `
    <section class="member-section" id="dmSettingsPanel">
      <div class="member-section-head">
        <h3>기본 설정</h3>
      </div>
      <p class="dm-section-desc">
        학교명, 기준 학년도, 아이디/Google 계정 도메인을 설정합니다. Google 계정 도메인은
        교사·학생이 Google 계정으로 회원가입을 신청할 때 허용되는 학교 도메인입니다.
      </p>
      <div class="admin-edit-grid">
        <div class="modal-field">
          <label for="dmSchoolName">학교명</label>
          <input id="dmSchoolName" type="text" placeholder="예: 전주여자고등학교">
        </div>
        <div class="modal-field">
          <label for="dmAppName">앱 이름</label>
          <input id="dmAppName" type="text" placeholder="교육과정 탐색">
        </div>
        <div class="modal-field">
          <label for="dmAcademicYear">현재 학년도</label>
          <input id="dmAcademicYear" type="number" min="2020" max="2100" placeholder="예: 2026">
        </div>
        <div class="modal-field">
          <label for="dmRecommendationYear">추천자료 기준 학년도</label>
          <input id="dmRecommendationYear" type="number" min="2020" max="2100" placeholder="예: 2028">
        </div>
        <div class="modal-field">
          <label for="dmSchoolDomain">아이디 로그인 도메인</label>
          <input id="dmSchoolDomain" type="text" placeholder="예: jjg.hs.kr">
        </div>
        <div class="modal-field">
          <label for="dmGoogleDomain">Google 계정 도메인</label>
          <input id="dmGoogleDomain" type="text" placeholder="예: jjg.hs.kr">
        </div>
      </div>
      <div class="dm-apply-bar">
        <button class="modal-btn modal-btn-submit" id="dmSettingsSaveBtn" type="button">기본 설정 저장</button>
        <span class="dm-apply-msg" id="dmSettingsMsg"></span>
      </div>
    </section>
  `;

  const fields = {
    school_name: root.querySelector('#dmSchoolName'),
    app_name: root.querySelector('#dmAppName'),
    current_academic_year: root.querySelector('#dmAcademicYear'),
    recommendation_source_year: root.querySelector('#dmRecommendationYear'),
    school_domain: root.querySelector('#dmSchoolDomain'),
    google_domain: root.querySelector('#dmGoogleDomain'),
  };
  const msg = root.querySelector('#dmSettingsMsg');
  const saveBtn = root.querySelector('#dmSettingsSaveBtn');

  async function loadSettings() {
    try {
      const config = await fetchConfig?.();
      for (const [key, el] of Object.entries(fields)) {
        if (el) el.value = config?.[key] || '';
      }
    } catch (err) {
      if (msg) { msg.textContent = `설정을 불러오지 못했습니다: ${err.message}`; msg.className = 'dm-apply-msg err'; }
    }
  }

  saveBtn?.addEventListener('click', async () => {
    const payload = {};
    for (const [key, el] of Object.entries(fields)) payload[key] = el?.value || '';
    if (payload.google_domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(payload.google_domain)) {
      if (msg) { msg.textContent = 'Google 계정 도메인 형식을 확인해 주세요.'; msg.className = 'dm-apply-msg err'; }
      return;
    }
    if (payload.school_domain && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(payload.school_domain)) {
      if (msg) { msg.textContent = '아이디 로그인 도메인 형식을 확인해 주세요.'; msg.className = 'dm-apply-msg err'; }
      return;
    }
    saveBtn.disabled = true;
    if (msg) { msg.textContent = '저장 중...'; msg.className = 'dm-apply-msg'; }
    try {
      await saveAppSettings?.(payload);
      if (msg) { msg.textContent = '저장 완료'; msg.className = 'dm-apply-msg ok'; }
      await onApplied?.();
    } catch (err) {
      if (msg) { msg.textContent = `저장 실패: ${err.message}`; msg.className = 'dm-apply-msg err'; }
    } finally {
      saveBtn.disabled = false;
    }
  });

  loadSettings();
}

// ══════════════════════════════════════════════════════════
//  1) 교육과정(semester_courses) — 코호트(입학년도)별 전체 교체
// ══════════════════════════════════════════════════════════

function setupCohortCurriculumSection(root, { fetchCohortSummary, fetchCohortRows, replaceCohortCourses, onApplied }) {
  if (!root) return;
  let applying = false;

  root.innerHTML = `
    <section class="member-section" id="dmCurrentSection">
      <div class="member-section-head">
        <h3>교육과정</h3>
        <button class="teacher-refresh-btn" id="dmRefreshBtn" type="button">새로고침</button>
      </div>
      <p class="dm-section-desc">
        curriculum-cohorts.xlsx와 같은 형식(시트 이름 "○○○○학년도 입학생 3개년")의 엑셀
        파일을 업로드합니다. 파일에 포함된 입학년도(코호트)만 반영되며, 그 입학년도의 기존
        데이터는 전체 교체됩니다.
      </p>
      <div id="dmCurrentBody"><div class="member-empty">불러오는 중...</div></div>
      <div class="dm-upload-body">
        <label class="dm-file-label" for="dmFileInput">
          <input id="dmFileInput" type="file" accept=".xlsx" hidden>
          <span id="dmFileLabelText">엑셀 파일 선택 (.xlsx)</span>
        </label>
        <div id="dmParseStatus" class="dm-parse-status"></div>
      </div>
      <div id="dmPreviewBody"></div>
    </section>
  `;

  const currentBody = root.querySelector('#dmCurrentBody');
  const fileInput = root.querySelector('#dmFileInput');
  const fileLabelText = root.querySelector('#dmFileLabelText');
  const parseStatus = root.querySelector('#dmParseStatus');
  const previewBody = root.querySelector('#dmPreviewBody');
  const refreshBtn = root.querySelector('#dmRefreshBtn');

  async function loadCurrentSummary() {
    if (!currentBody) return;
    currentBody.innerHTML = `<div class="member-empty">불러오는 중...</div>`;
    try {
      const rows = await fetchCohortSummary();
      renderCurrentSummary(rows);
    } catch (err) {
      currentBody.innerHTML = `<div class="member-empty">현재 현황을 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderCurrentSummary(rows) {
    if (!rows || !rows.length) {
      currentBody.innerHTML = `<div class="member-empty">아직 등록된 교육과정이 없습니다. 아래에서 엑셀 파일을 업로드해 최초 설정해 주세요.</div>`;
      return;
    }
    currentBody.innerHTML = `
      <div class="member-table-wrap">
        <table class="member-table">
          <thead><tr><th>입학년도</th><th>등록된 과목 행 수</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr><td>${escapeHtml(String(r.cohortYear))}학년도 입학생</td><td>${Number(r.count).toLocaleString('ko-KR')}행</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
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
      const result = await parseCohortWorkbook(buffer);
      await renderPreview(result);
      parseStatus.innerHTML = `<span class="dm-status-ok">분석 완료 — 아래 미리보기를 확인한 뒤 "적용" 버튼을 눌러주세요.</span>`;
    } catch (err) {
      console.error('교육과정 엑셀 분석 실패:', err);
      parseStatus.innerHTML = `<span class="dm-status-err">분석 실패: ${escapeHtml(err.message)}</span>`;
    } finally {
      fileInput.value = '';
    }
  });

  async function renderPreview(result) {
    const { cohorts, warnings, skippedSheets } = result;

    let existingByYear = new Map();
    let diffHtml = '';
    try {
      const current = await fetchCohortSummary();
      existingByYear = new Map(current.map(r => [r.cohortYear, r.count]));
      const years = cohorts.map(c => c.cohortYear);
      const existingRows = await fetchCohortRows?.(years);
      const nextRows = cohorts.flatMap(cohort => cohort.rows);
      const diff = diffRows(existingRows || [], nextRows, {
        keyFn: row => [
          row.cohort_year ?? row.cohortYear,
          row.semester,
          row.group_name ?? row.groupName,
          row.name,
        ].map(compareValue).join('::'),
        labelFn: row => `${row.cohort_year ?? row.cohortYear}학년도 · ${row.semester || ''} · ${(row.group_name ?? row.groupName) || ''} · ${row.name || ''}`,
        fields: [
          { label: '교과군', get: row => row.area },
          { label: '과목유형', get: row => row.type },
          { label: '선택과목수', get: row => row.pick },
          { label: '학점', get: row => row.credit },
        ],
      });
      diffHtml = renderDiffSummary(diff, { title: '교육과정 변화 비교' });
    } catch (err) {
      diffHtml = `<div class="member-empty">기존 자료와의 비교 정보를 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }

    const warningsHtml = warnings.length
      ? `<div class="dm-warning-box">
          <div class="dm-warning-title">⚠ 확인이 필요한 항목 (${warnings.length}건)</div>
          <ul class="dm-warning-list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>`
      : '';

    const skippedHtml = skippedSheets.length
      ? `<div class="dm-skipped-note">"○○○○학년도 입학생 3개년" 형식이 아니어서 건너뛴 시트: ${skippedSheets.map(escapeHtml).join(', ')}</div>`
      : '';

    const cardsHtml = cohorts.map(cohort => {
      const before = existingByYear.has(cohort.cohortYear) ? existingByYear.get(cohort.cohortYear) : null;
      const after = cohort.rows.length;
      const semesterRows = summarizeCohortSemesters(cohort.rows);
      const diffLabel = before === null
        ? `신규 등록 (0 → ${after}행)`
        : `${before}행 → ${after}행${after < before ? ' (감소)' : ''}`;

      return `
        <div class="dm-cohort-card" data-cohort-year="${cohort.cohortYear}">
          <div class="dm-cohort-card-head">
            <div class="dm-cohort-title">${escapeHtml(String(cohort.cohortYear))}학년도 입학생</div>
            <div class="dm-cohort-diff">${escapeHtml(diffLabel)}</div>
          </div>
          <div class="dm-cohort-sheets">시트: ${cohort.sheetNames.map(escapeHtml).join(', ')}</div>
          <div class="member-table-wrap">
            <table class="member-table dm-semester-table">
              <thead><tr><th>학기</th><th>과목 수</th></tr></thead>
              <tbody>
                ${semesterRows.length
                  ? semesterRows.map(s => `<tr><td>${escapeHtml(s.semester)}</td><td>${s.count}행</td></tr>`).join('')
                  : `<tr><td colspan="2">유효한 과목 행이 없습니다.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }).join('');

    previewBody.innerHTML = `
      ${warningsHtml}
      ${skippedHtml}
      <div class="dm-cohort-grid">${cardsHtml}</div>
      ${diffHtml}
      <div class="dm-apply-bar">
        <button class="member-add-btn" id="dmApplyBtn" type="button">적용 (전체 교체)</button>
        <span class="dm-apply-msg" id="dmApplyMsg"></span>
      </div>
    `;

    const applyBtn = previewBody.querySelector('#dmApplyBtn');
    const applyMsg = previewBody.querySelector('#dmApplyMsg');

    applyBtn?.addEventListener('click', async () => {
      if (applying) return;
      if (!cohorts.length) return;

      const totalRows = cohorts.reduce((sum, c) => sum + c.rows.length, 0);
      const yearList = cohorts.map(c => `${c.cohortYear}학년도`).join(', ');
      const confirmed = window.confirm(
        `${yearList} 입학생의 기존 교육과정을 모두 삭제하고, 업로드한 엑셀 내용(총 ${totalRows}행)으로 완전히 교체합니다.\n` +
        `이 작업은 되돌릴 수 없습니다. 계속할까요?`
      );
      if (!confirmed) return;

      applying = true;
      applyBtn.disabled = true;
      applyBtn.textContent = '적용 중...';
      applyMsg.textContent = '';
      applyMsg.className = 'dm-apply-msg';

      try {
        for (const cohort of cohorts) {
          applyMsg.textContent = `${cohort.cohortYear}학년도 입학생 반영 중... (${cohort.rows.length}행)`;
          await replaceCohortCourses(cohort.cohortYear, cohort.rows);
        }
        applyMsg.textContent = `완료: ${yearList} 입학생 교육과정이 갱신되었습니다.`;
        applyMsg.classList.add('ok');
        await loadCurrentSummary();
        await onApplied?.();
      } catch (err) {
        console.error('교육과정 반영 실패:', err);
        // ⚠ 코호트별로 순차 반영하므로, 중간에 실패해도 이미 반영된 코호트는 그대로 남는다.
        // delete-then-insert는 같은 코호트를 다시 적용해도 안전(멱등)하므로, 실패 시
        // 안내는 "새로고침 후 다시 적용"을 권장하는 형태로 남긴다.
        applyMsg.textContent = `반영 실패: ${err.message} — 새로고침 후 같은 파일로 다시 시도해 주세요.`;
        applyMsg.classList.add('err');
        await loadCurrentSummary();
      } finally {
        applying = false;
        applyBtn.disabled = false;
        applyBtn.textContent = '적용 (전체 교체)';
      }
    });
  }

  loadCurrentSummary();
}

// ══════════════════════════════════════════════════════════
//  공용: 코호트 구분 없는 "전역 테이블 전체 교체" 업로드 섹션
//  (university_recommendations / series_reflected_matrix가 이 패턴을 공유)
// ══════════════════════════════════════════════════════════

function renderSimpleUploadShell(root, { idPrefix, title, description }) {
  root.innerHTML = `
    <section class="member-section" id="${idPrefix}Section">
      <div class="member-section-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="teacher-refresh-btn" id="${idPrefix}RefreshBtn" type="button">새로고침</button>
      </div>
      <p class="dm-section-desc">${description}</p>
      <div id="${idPrefix}CurrentBody"><div class="member-empty">불러오는 중...</div></div>
      <div class="dm-upload-body">
        <label class="dm-file-label" for="${idPrefix}FileInput">
          <input id="${idPrefix}FileInput" type="file" accept=".xlsx" hidden>
          <span id="${idPrefix}FileLabelText">엑셀 파일 선택 (.xlsx)</span>
        </label>
        <div id="${idPrefix}ParseStatus" class="dm-parse-status"></div>
      </div>
      <div id="${idPrefix}PreviewBody"></div>
    </section>
  `;
}

// ══════════════════════════════════════════════════════════
//  2) 대학 추천과목(university_recommendations) — 테이블 전체 교체
// ══════════════════════════════════════════════════════════

function setupUniversityRecommendationsSection(root, {
  fetchUniversitySummary,
  fetchUniversityRows,
  replaceUniversityRecommendations,
  fetchSeriesMatrixRows,
  onApplied,
}) {
  if (!root) return;
  const idPrefix = 'dmUniv';
  let applying = false;

  renderSimpleUploadShell(root, {
    idPrefix,
    title: '대학 추천과목 (권역별·대학별)',
    description: `
      university-recommendations.xlsx와 같은 형식(시트 이름 "Sheet1", 5행부터 데이터)의
      엑셀 파일을 업로드합니다. 적용 시 university_recommendations 테이블 전체가 새 내용으로
      교체됩니다. "반영과목" 컬럼 일부는 아래 "계열별 대표 모집단위 반영과목" 데이터로
      보강되는데, 이 보강은 적용 시점에 DB에 저장돼 있는 반영과목 데이터를 기준으로 하므로
      — 반영과목을 나중에 갱신했다면 이 대학 추천과목도 다시 적용해야 최신 내용이 반영됩니다.
    `,
  });

  const currentBody = root.querySelector(`#${idPrefix}CurrentBody`);
  const fileInput = root.querySelector(`#${idPrefix}FileInput`);
  const fileLabelText = root.querySelector(`#${idPrefix}FileLabelText`);
  const parseStatus = root.querySelector(`#${idPrefix}ParseStatus`);
  const previewBody = root.querySelector(`#${idPrefix}PreviewBody`);
  const refreshBtn = root.querySelector(`#${idPrefix}RefreshBtn`);

  async function loadCurrentSummary() {
    if (!currentBody) return;
    currentBody.innerHTML = `<div class="member-empty">불러오는 중...</div>`;
    try {
      const { count } = await fetchUniversitySummary();
      currentBody.innerHTML = count
        ? `<div class="dm-current-count">현재 등록된 대학 추천과목: <strong>${count.toLocaleString('ko-KR')}행</strong></div>`
        : `<div class="member-empty">아직 등록된 대학 추천과목이 없습니다. 아래에서 엑셀 파일을 업로드해 최초 설정해 주세요.</div>`;
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

      // 적용 시점의 DB 반영과목 데이터를 보강 소스로 사용(두 파일을 같이 올릴 필요 없음).
      let reflectedLookup = new Map();
      try {
        const seriesRows = await fetchSeriesMatrixRows();
        reflectedLookup = buildReflectedLookupFromStoredRows(seriesRows);
      } catch {
        // 반영과목 조회 실패는 보강만 생략하고 계속 진행
      }

      const result = await parseUniversityRecommendationsWorkbook(buffer, reflectedLookup);
      await renderPreview(result);
      parseStatus.innerHTML = `<span class="dm-status-ok">분석 완료 — 아래 미리보기를 확인한 뒤 "적용" 버튼을 눌러주세요.</span>`;
    } catch (err) {
      console.error('대학 추천과목 엑셀 분석 실패:', err);
      parseStatus.innerHTML = `<span class="dm-status-err">분석 실패: ${escapeHtml(err.message)}</span>`;
    } finally {
      fileInput.value = '';
    }
  });

  async function renderPreview(result) {
    const { rows, warnings } = result;

    let before = null;
    let diffHtml = '';
    try {
      const { count } = await fetchUniversitySummary();
      before = count;
      const existingRows = await fetchUniversityRows?.();
      const diff = diffRows(existingRows || [], rows, {
        keyFn: row => [
          row.region_area ?? row.regionArea,
          row.university,
          row.detail_department ?? row.detailDepartment,
          row.department,
        ].map(compareValue).join('::'),
        labelFn: row => {
          const detail = row.detail_department ?? row.detailDepartment ?? row.department ?? '';
          return `${row.university || ''} · ${detail} · ${row.department || ''}`;
        },
        fields: [
          { label: '권역-지역', get: row => row.region_area ?? row.regionArea },
          { label: '계열', get: row => row.series },
          { label: '핵심과목', get: row => row.core },
          { label: '권장과목', get: row => row.recommended },
          { label: '반영과목', get: row => row.reflected },
          { label: '비고', get: row => row.note },
        ],
      });
      diffHtml = renderDiffSummary(diff, { title: '대학 추천과목 변화 비교' });
    } catch (err) {
      diffHtml = `<div class="member-empty">기존 자료와의 비교 정보를 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }

    const after = rows.length;
    const diffLabel = before === null
      ? `신규 등록 (0 → ${after}행)`
      : `${before}행 → ${after}행${after < before ? ' (감소)' : ''}`;

    const warningsHtml = warnings.length
      ? `<div class="dm-warning-box">
          <div class="dm-warning-title">⚠ 확인이 필요한 항목 (${warnings.length}건)</div>
          <ul class="dm-warning-list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>`
      : '';

    const byRegion = new Map();
    for (const r of rows) {
      const key = r.region_area || '(미지정)';
      byRegion.set(key, (byRegion.get(key) || 0) + 1);
    }
    const regionRows = [...byRegion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

    previewBody.innerHTML = `
      ${warningsHtml}
      <div class="dm-cohort-card">
        <div class="dm-cohort-card-head">
          <div class="dm-cohort-title">university_recommendations</div>
          <div class="dm-cohort-diff">${escapeHtml(diffLabel)}</div>
        </div>
        <div class="member-table-wrap">
          <table class="member-table dm-semester-table">
            <thead><tr><th>권역-지역</th><th>행 수</th></tr></thead>
            <tbody>
              ${regionRows.length
                ? regionRows.map(([region, count]) => `<tr><td>${escapeHtml(region)}</td><td>${count}행</td></tr>`).join('')
                : `<tr><td colspan="2">유효한 행이 없습니다.</td></tr>`}
            </tbody>
          </table>
        </div>
        ${byRegion.size > 12 ? `<div class="dm-cohort-sheets">그 외 ${byRegion.size - 12}개 권역-지역 생략</div>` : ''}
      </div>
      ${diffHtml}
      <div class="dm-apply-bar">
        <button class="member-add-btn" id="${idPrefix}ApplyBtn" type="button">적용 (전체 교체)</button>
        <span class="dm-apply-msg" id="${idPrefix}ApplyMsg"></span>
      </div>
    `;

    const applyBtn = previewBody.querySelector(`#${idPrefix}ApplyBtn`);
    const applyMsg = previewBody.querySelector(`#${idPrefix}ApplyMsg`);

    applyBtn?.addEventListener('click', async () => {
      if (applying) return;
      if (!rows.length) return;

      const confirmed = window.confirm(
        `대학 추천과목 전체(${before ?? 0}행)를 삭제하고, 업로드한 엑셀 내용(${rows.length}행)으로 완전히 교체합니다.\n` +
        `이 작업은 되돌릴 수 없습니다. 계속할까요?`
      );
      if (!confirmed) return;

      applying = true;
      applyBtn.disabled = true;
      applyBtn.textContent = '적용 중...';
      applyMsg.textContent = '';
      applyMsg.className = 'dm-apply-msg';

      try {
        applyMsg.textContent = `반영 중... (${rows.length}행)`;
        await replaceUniversityRecommendations(rows);
        applyMsg.textContent = `완료: 대학 추천과목 ${rows.length}행이 갱신되었습니다.`;
        applyMsg.classList.add('ok');
        await loadCurrentSummary();
        await onApplied?.();
      } catch (err) {
        console.error('대학 추천과목 반영 실패:', err);
        applyMsg.textContent = `반영 실패: ${err.message} — 새로고침 후 같은 파일로 다시 시도해 주세요.`;
        applyMsg.classList.add('err');
        await loadCurrentSummary();
      } finally {
        applying = false;
        applyBtn.disabled = false;
        applyBtn.textContent = '적용 (전체 교체)';
      }
    });
  }

  loadCurrentSummary();
}

// ══════════════════════════════════════════════════════════
//  3) 계열별 대표 모집단위 반영과목(series_reflected_matrix) — 테이블 전체 교체
// ══════════════════════════════════════════════════════════

function setupSeriesMatrixSection(root, { fetchSeriesSummary, fetchSeriesRows, replaceSeriesMatrix, onApplied }) {
  if (!root) return;
  const idPrefix = 'dmSeries';
  let applying = false;

  renderSimpleUploadShell(root, {
    idPrefix,
    title: '계열별 대표 모집단위 반영과목',
    description: `
      university-recommendations-series.xlsx와 같은 형식(시트 이름 "반영과목", 5행부터
      데이터)의 엑셀 파일을 업로드합니다. 적용 시 series_reflected_matrix 테이블 전체가 새
      내용으로 교체됩니다. 표본이 16개 대표 모집단위뿐인 보조 데이터이며, 위 "대학 추천과목"
      의 반영과목 일부를 보강하는 데도 쓰입니다.
    `,
  });

  const currentBody = root.querySelector(`#${idPrefix}CurrentBody`);
  const fileInput = root.querySelector(`#${idPrefix}FileInput`);
  const fileLabelText = root.querySelector(`#${idPrefix}FileLabelText`);
  const parseStatus = root.querySelector(`#${idPrefix}ParseStatus`);
  const previewBody = root.querySelector(`#${idPrefix}PreviewBody`);
  const refreshBtn = root.querySelector(`#${idPrefix}RefreshBtn`);

  async function loadCurrentSummary() {
    if (!currentBody) return;
    currentBody.innerHTML = `<div class="member-empty">불러오는 중...</div>`;
    try {
      const { count } = await fetchSeriesSummary();
      currentBody.innerHTML = count
        ? `<div class="dm-current-count">현재 등록된 반영과목: <strong>${count.toLocaleString('ko-KR')}행</strong></div>`
        : `<div class="member-empty">아직 등록된 반영과목이 없습니다. 아래에서 엑셀 파일을 업로드해 최초 설정해 주세요.</div>`;
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
      const result = await parseSeriesMatrixWorkbook(buffer);
      await renderPreview(result);
      parseStatus.innerHTML = `<span class="dm-status-ok">분석 완료 — 아래 미리보기를 확인한 뒤 "적용" 버튼을 눌러주세요.</span>`;
    } catch (err) {
      console.error('반영과목 엑셀 분석 실패:', err);
      parseStatus.innerHTML = `<span class="dm-status-err">분석 실패: ${escapeHtml(err.message)}</span>`;
    } finally {
      fileInput.value = '';
    }
  });

  async function renderPreview(result) {
    const { rows, warnings } = result;

    let before = null;
    let diffHtml = '';
    try {
      const { count } = await fetchSeriesSummary();
      before = count;
      const existingRows = await fetchSeriesRows?.();
      const diff = diffRows(existingRows || [], rows, {
        keyFn: row => [
          row.series,
          row.department,
          row.university,
        ].map(compareValue).join('::'),
        labelFn: row => `${row.series || ''} · ${row.department || ''} · ${row.university || ''}`,
        fields: [
          { label: '반영과목', get: row => row.required_subjects ?? row.requiredSubjects },
        ],
      });
      diffHtml = renderDiffSummary(diff, { title: '계열별 반영과목 변화 비교' });
    } catch (err) {
      diffHtml = `<div class="member-empty">기존 자료와의 비교 정보를 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }

    const after = rows.length;
    const diffLabel = before === null
      ? `신규 등록 (0 → ${after}행)`
      : `${before}행 → ${after}행${after < before ? ' (감소)' : ''}`;

    const warningsHtml = warnings.length
      ? `<div class="dm-warning-box">
          <div class="dm-warning-title">⚠ 확인이 필요한 항목 (${warnings.length}건)</div>
          <ul class="dm-warning-list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>`
      : '';

    const bySeriesDept = new Map();
    for (const r of rows) {
      const key = `${r.series || '(미지정)'} · ${r.department || '(미지정)'}`;
      bySeriesDept.set(key, (bySeriesDept.get(key) || 0) + 1);
    }
    const groupRows = [...bySeriesDept.entries()];

    previewBody.innerHTML = `
      ${warningsHtml}
      <div class="dm-cohort-card">
        <div class="dm-cohort-card-head">
          <div class="dm-cohort-title">series_reflected_matrix</div>
          <div class="dm-cohort-diff">${escapeHtml(diffLabel)}</div>
        </div>
        <div class="member-table-wrap">
          <table class="member-table dm-semester-table">
            <thead><tr><th>계열 · 모집단위</th><th>대학 수</th></tr></thead>
            <tbody>
              ${groupRows.length
                ? groupRows.map(([label, count]) => `<tr><td>${escapeHtml(label)}</td><td>${count}행</td></tr>`).join('')
                : `<tr><td colspan="2">유효한 행이 없습니다.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
      ${diffHtml}
      <div class="dm-apply-bar">
        <button class="member-add-btn" id="${idPrefix}ApplyBtn" type="button">적용 (전체 교체)</button>
        <span class="dm-apply-msg" id="${idPrefix}ApplyMsg"></span>
      </div>
    `;

    const applyBtn = previewBody.querySelector(`#${idPrefix}ApplyBtn`);
    const applyMsg = previewBody.querySelector(`#${idPrefix}ApplyMsg`);

    applyBtn?.addEventListener('click', async () => {
      if (applying) return;
      if (!rows.length) return;

      const confirmed = window.confirm(
        `계열별 반영과목 전체(${before ?? 0}행)를 삭제하고, 업로드한 엑셀 내용(${rows.length}행)으로 완전히 교체합니다.\n` +
        `이 작업은 되돌릴 수 없습니다. 계속할까요?`
      );
      if (!confirmed) return;

      applying = true;
      applyBtn.disabled = true;
      applyBtn.textContent = '적용 중...';
      applyMsg.textContent = '';
      applyMsg.className = 'dm-apply-msg';

      try {
        applyMsg.textContent = `반영 중... (${rows.length}행)`;
        await replaceSeriesMatrix(rows);
        applyMsg.textContent = `완료: 반영과목 ${rows.length}행이 갱신되었습니다.`;
        applyMsg.classList.add('ok');
        await loadCurrentSummary();
        await onApplied?.();
      } catch (err) {
        console.error('반영과목 반영 실패:', err);
        applyMsg.textContent = `반영 실패: ${err.message} — 새로고침 후 같은 파일로 다시 시도해 주세요.`;
        applyMsg.classList.add('err');
        await loadCurrentSummary();
      } finally {
        applying = false;
        applyBtn.disabled = false;
        applyBtn.textContent = '적용 (전체 교체)';
      }
    });
  }

  loadCurrentSummary();
}

// ══════════════════════════════════════════════════════════
//  4) 참고사이트(links) — 테이블 전체 교체
// ══════════════════════════════════════════════════════════

function setupLinksSection(root, { fetchLinksSummary, fetchLinkRows, replaceLinks, onApplied }) {
  if (!root) return;
  const idPrefix = 'dmLinks';
  let applying = false;

  renderSimpleUploadShell(root, {
    idPrefix,
    title: '참고 사이트',
    description: `
      참고자료1.xlsx와 같은 형식(시트 이름 "참고사이트", 1행은 헤더, 2행부터 데이터, 열
      순서 category · name · url · description · tags)의 엑셀 파일을 업로드합니다. 적용 시
      links 테이블 전체가 새 내용으로 교체되어 "참고" 탭에 바로 반영됩니다.
    `,
  });

  const currentBody = root.querySelector(`#${idPrefix}CurrentBody`);
  const fileInput = root.querySelector(`#${idPrefix}FileInput`);
  const fileLabelText = root.querySelector(`#${idPrefix}FileLabelText`);
  const parseStatus = root.querySelector(`#${idPrefix}ParseStatus`);
  const previewBody = root.querySelector(`#${idPrefix}PreviewBody`);
  const refreshBtn = root.querySelector(`#${idPrefix}RefreshBtn`);

  async function loadCurrentSummary() {
    if (!currentBody) return;
    currentBody.innerHTML = `<div class="member-empty">불러오는 중...</div>`;
    try {
      const { count } = await fetchLinksSummary();
      currentBody.innerHTML = count
        ? `<div class="dm-current-count">현재 등록된 참고사이트: <strong>${count.toLocaleString('ko-KR')}행</strong></div>`
        : `<div class="member-empty">아직 등록된 참고사이트가 없습니다. 아래에서 엑셀 파일을 업로드해 최초 설정해 주세요.</div>`;
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
      const result = await parseLinksWorkbook(buffer);
      await renderPreview(result);
      parseStatus.innerHTML = `<span class="dm-status-ok">분석 완료 — 아래 미리보기를 확인한 뒤 "적용" 버튼을 눌러주세요.</span>`;
    } catch (err) {
      console.error('참고사이트 엑셀 분석 실패:', err);
      parseStatus.innerHTML = `<span class="dm-status-err">분석 실패: ${escapeHtml(err.message)}</span>`;
    } finally {
      fileInput.value = '';
    }
  });

  async function renderPreview(result) {
    const { rows, warnings } = result;

    let before = null;
    let diffHtml = '';
    try {
      const { count } = await fetchLinksSummary();
      before = count;
      const existingRows = await fetchLinkRows?.();
      const diff = diffRows(existingRows || [], rows, {
        keyFn: row => [
          row.category,
          row.name,
          row.url,
        ].map(compareValue).join('::'),
        labelFn: row => `${row.category || '(미지정)'} · ${row.name || ''}`,
        fields: [
          { label: 'URL', get: row => row.url },
          { label: '설명', get: row => row.description },
          { label: '태그', get: row => row.tags },
        ],
      });
      diffHtml = renderDiffSummary(diff, { title: '참고사이트 변화 비교' });
    } catch (err) {
      diffHtml = `<div class="member-empty">기존 자료와의 비교 정보를 불러오지 못했습니다: ${escapeHtml(err.message)}</div>`;
    }

    const after = rows.length;
    const diffLabel = before === null
      ? `신규 등록 (0 → ${after}행)`
      : `${before}행 → ${after}행${after < before ? ' (감소)' : ''}`;

    const warningsHtml = warnings.length
      ? `<div class="dm-warning-box">
          <div class="dm-warning-title">⚠ 확인이 필요한 항목 (${warnings.length}건)</div>
          <ul class="dm-warning-list">${warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>
        </div>`
      : '';

    const byCategory = new Map();
    for (const r of rows) {
      const key = r.category || '(미지정)';
      byCategory.set(key, (byCategory.get(key) || 0) + 1);
    }
    const categoryRows = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

    previewBody.innerHTML = `
      ${warningsHtml}
      <div class="dm-cohort-card">
        <div class="dm-cohort-card-head">
          <div class="dm-cohort-title">links</div>
          <div class="dm-cohort-diff">${escapeHtml(diffLabel)}</div>
        </div>
        <div class="member-table-wrap">
          <table class="member-table dm-semester-table">
            <thead><tr><th>분류</th><th>행 수</th></tr></thead>
            <tbody>
              ${categoryRows.length
                ? categoryRows.map(([category, count]) => `<tr><td>${escapeHtml(category)}</td><td>${count}행</td></tr>`).join('')
                : `<tr><td colspan="2">유효한 행이 없습니다.</td></tr>`}
            </tbody>
          </table>
        </div>
        ${byCategory.size > 12 ? `<div class="dm-cohort-sheets">그 외 ${byCategory.size - 12}개 분류 생략</div>` : ''}
      </div>
      ${diffHtml}
      <div class="dm-apply-bar">
        <button class="member-add-btn" id="${idPrefix}ApplyBtn" type="button">적용 (전체 교체)</button>
        <span class="dm-apply-msg" id="${idPrefix}ApplyMsg"></span>
      </div>
    `;

    const applyBtn = previewBody.querySelector(`#${idPrefix}ApplyBtn`);
    const applyMsg = previewBody.querySelector(`#${idPrefix}ApplyMsg`);

    applyBtn?.addEventListener('click', async () => {
      if (applying) return;
      if (!rows.length) return;

      const confirmed = window.confirm(
        `참고사이트 전체(${before ?? 0}행)를 삭제하고, 업로드한 엑셀 내용(${rows.length}행)으로 완전히 교체합니다.\n` +
        `이 작업은 되돌릴 수 없습니다. 계속할까요?`
      );
      if (!confirmed) return;

      applying = true;
      applyBtn.disabled = true;
      applyBtn.textContent = '적용 중...';
      applyMsg.textContent = '';
      applyMsg.className = 'dm-apply-msg';

      try {
        applyMsg.textContent = `반영 중... (${rows.length}행)`;
        await replaceLinks(rows);
        applyMsg.textContent = `완료: 참고사이트 ${rows.length}행이 갱신되었습니다.`;
        applyMsg.classList.add('ok');
        await loadCurrentSummary();
        await onApplied?.();
      } catch (err) {
        console.error('참고사이트 반영 실패:', err);
        applyMsg.textContent = `반영 실패: ${err.message} — 새로고침 후 같은 파일로 다시 시도해 주세요.`;
        applyMsg.classList.add('err');
        await loadCurrentSummary();
      } finally {
        applying = false;
        applyBtn.disabled = false;
        applyBtn.textContent = '적용 (전체 교체)';
      }
    });
  }

  loadCurrentSummary();
}
