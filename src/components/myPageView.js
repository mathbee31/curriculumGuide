// ─────────────────────────────────────────
//  components/myPageView.js  —  마이페이지 (교사/학생 본인 정보 + 비밀번호 수정)
// ─────────────────────────────────────────
import { escapeHtml } from '../utils/normalize.js';

// 회원가입 모달(index.html #trSubjectArea)과 동일한 담당 교과 목록.
// teacherView.js의 SUBJECT_AREA_LABELS와도 동일한 값 집합을 사용해야
// 관리자 "회원 관리" 표의 라벨과 어긋나지 않는다.
const SUBJECT_AREA_OPTIONS = [
  { value: '', label: '선택 (선택사항)' },
  { value: 'korean', label: '국어' },
  { value: 'math', label: '수학' },
  { value: 'english', label: '영어' },
  { value: 'social', label: '사회' },
  { value: 'science', label: '과학' },
  { value: 'info', label: '정보' },
  { value: 'home', label: '기술·가정' },
  { value: 'language', label: '제2외국어' },
  { value: 'arts', label: '예술·체육' },
  { value: 'liberal', label: '교양' },
];

function subjectAreaOptionsHtml(selected) {
  return SUBJECT_AREA_OPTIONS
    .map(opt => `<option value="${opt.value}"${opt.value === selected ? ' selected' : ''}>${escapeHtml(opt.label)}</option>`)
    .join('');
}

function gradeOptionsHtml(selected) {
  const clean = String(selected ?? '').trim();
  return ['', '1', '2', '3']
    .map(v => {
      const label = v === '' ? '선택' : `${v}학년`;
      return `<option value="${v}"${v === clean ? ' selected' : ''}>${label}</option>`;
    })
    .join('');
}

function setMsg(el, text, type) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'save-status' + (type ? ` ${type}` : '');
}

/**
 * 마이페이지 렌더링.
 * @param {HTMLElement} container
 * @param {Object} opts
 * @param {'teacher'|'student'} opts.role
 * @param {{name:string, subjectArea?:string, grade?:string, classNo?:string, number?:string}} opts.profile
 * @param {(next: Object) => Promise<void>} opts.onSaveProfile - 저장할 필드만 담아 호출
 * @param {(newPassword: string) => Promise<void>} opts.onChangePassword
 */
export function renderMyPage(container, { role, profile = {}, onSaveProfile, onChangePassword } = {}) {
  if (!container) return;
  const isTeacherRole = role === 'teacher';

  const profileFieldsHtml = isTeacherRole
    ? `
      <div class="modal-field">
        <label for="mpName">이름</label>
        <input id="mpName" type="text" placeholder="홍길동" autocomplete="name" value="${escapeHtml(profile.name || '')}">
      </div>
      <div class="modal-field">
        <label for="mpSubjectArea">담당 교과</label>
        <select id="mpSubjectArea">${subjectAreaOptionsHtml(profile.subjectArea || '')}</select>
      </div>
    `
    : `
      <div class="mypage-field-row">
        <div class="modal-field">
          <label for="mpGrade">학년</label>
          <select id="mpGrade">${gradeOptionsHtml(profile.grade || '')}</select>
        </div>
        <div class="modal-field">
          <label for="mpClass">반</label>
          <input id="mpClass" type="number" min="1" max="20" placeholder="예: 3" value="${escapeHtml(profile.classNo || '')}">
        </div>
        <div class="modal-field">
          <label for="mpNumber">번호</label>
          <input id="mpNumber" type="number" min="1" max="50" placeholder="예: 15" value="${escapeHtml(profile.number || '')}">
        </div>
      </div>
      <div class="modal-field">
        <label for="mpName">이름</label>
        <input id="mpName" type="text" placeholder="홍길동" autocomplete="name" value="${escapeHtml(profile.name || '')}">
      </div>
    `;

  container.innerHTML = `
    <div class="mypage-wrap">
      <div class="links-header">
        <h2>마이페이지</h2>
        <p class="links-desc">${isTeacherRole ? '이름·담당 교과와 비밀번호를 수정합니다.' : '학년·반·번호·이름과 비밀번호를 수정합니다.'}</p>
      </div>
      <div class="mypage-cards">
        <div class="sel-card">
          <div class="sel-card-title">기본 정보</div>
          ${profileFieldsHtml}
          <button class="save-btn" id="mpProfileSaveBtn" type="button">정보 저장</button>
          <div class="save-status" id="mpProfileStatus"></div>
        </div>

        <div class="sel-card">
          <div class="sel-card-title">비밀번호 변경</div>
          <div class="modal-field">
            <label for="mpNewPassword">새 비밀번호</label>
            <input id="mpNewPassword" type="password" placeholder="6자 이상" autocomplete="new-password">
          </div>
          <div class="modal-field">
            <label for="mpNewPasswordConfirm">새 비밀번호 확인</label>
            <input id="mpNewPasswordConfirm" type="password" placeholder="비밀번호 재입력" autocomplete="new-password">
          </div>
          <button class="save-btn" id="mpPasswordSaveBtn" type="button">비밀번호 변경</button>
          <div class="save-status" id="mpPasswordStatus"></div>
        </div>
      </div>
    </div>
  `;

  const profileSaveBtn = container.querySelector('#mpProfileSaveBtn');
  const profileStatus  = container.querySelector('#mpProfileStatus');
  profileSaveBtn?.addEventListener('click', async () => {
    const name = container.querySelector('#mpName')?.value.trim() || '';
    if (!name) {
      setMsg(profileStatus, '이름을 입력해 주세요.', 'error');
      return;
    }

    let payload;
    if (isTeacherRole) {
      const subjectArea = container.querySelector('#mpSubjectArea')?.value || '';
      payload = { name, subjectArea };
    } else {
      const grade   = container.querySelector('#mpGrade')?.value || '';
      const classNo = container.querySelector('#mpClass')?.value.trim() || '';
      const number  = container.querySelector('#mpNumber')?.value.trim() || '';
      if (!grade || !classNo || !number) {
        setMsg(profileStatus, '학년·반·번호를 모두 입력해 주세요.', 'error');
        return;
      }
      if (!/^\d+$/.test(classNo) || !/^\d+$/.test(number)) {
        setMsg(profileStatus, '반과 번호는 숫자로 입력해 주세요.', 'error');
        return;
      }
      payload = { name, grade, classNo, number };
    }

    profileSaveBtn.disabled = true;
    setMsg(profileStatus, '저장 중...', '');
    try {
      await onSaveProfile?.(payload);
      setMsg(profileStatus, '저장했습니다.', 'success');
    } catch (err) {
      setMsg(profileStatus, err.message || '저장에 실패했습니다.', 'error');
    } finally {
      profileSaveBtn.disabled = false;
    }
  });

  const passwordSaveBtn = container.querySelector('#mpPasswordSaveBtn');
  const passwordStatus  = container.querySelector('#mpPasswordStatus');
  passwordSaveBtn?.addEventListener('click', async () => {
    const pw = container.querySelector('#mpNewPassword')?.value || '';
    const pwConfirm = container.querySelector('#mpNewPasswordConfirm')?.value || '';
    if (!pw || pw.length < 6) {
      setMsg(passwordStatus, '비밀번호는 6자 이상이어야 합니다.', 'error');
      return;
    }
    if (pw !== pwConfirm) {
      setMsg(passwordStatus, '비밀번호가 일치하지 않습니다.', 'error');
      return;
    }

    passwordSaveBtn.disabled = true;
    setMsg(passwordStatus, '변경 중...', '');
    try {
      await onChangePassword?.(pw);
      setMsg(passwordStatus, '비밀번호를 변경했습니다.', 'success');
      const pwEl = container.querySelector('#mpNewPassword');
      const pwConfirmEl = container.querySelector('#mpNewPasswordConfirm');
      if (pwEl) pwEl.value = '';
      if (pwConfirmEl) pwConfirmEl.value = '';
    } catch (err) {
      setMsg(passwordStatus, err.message || '비밀번호 변경에 실패했습니다.', 'error');
    } finally {
      passwordSaveBtn.disabled = false;
    }
  });
}
