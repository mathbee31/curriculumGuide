# Curriculum Navigator — 고등학교 교육과정 탐색 템플릿

## 배포 스택

| 항목 | 내용 |
|------|------|
| 호스팅 | **Vercel** (main 브랜치 push → 자동 배포) |
| 인증 | **Supabase Auth** + Google OAuth 2.0 |
| 데이터 | **Supabase** (PostgreSQL + Row Level Security) |

---

## 원작자 및 문의

이 프로젝트는 전주여자고등학교 교육과정 탐색 웹앱을 바탕으로 합니다.
학교별 교육과정에 맞게 포크·수정하여 사용할 수 있으며, 재배포하거나 수정본을 공개할 때는
원작자 정보를 함께 남겨 주세요.

| 항목 | 내용 |
|------|------|
| 원작자 | 권혁득 |
| 원본 저장소 | [wlog31/curriculumGuide](https://github.com/wlog31/curriculumGuide) |
| 개선 제안·오류 제보 | [wloghd@gmail.com](mailto:wloghd@gmail.com) |

버그, 보안 이슈, 학교별 적용 과정에서 필요한 개선 사항은 위 이메일 또는 GitHub Issue로
제안해 주세요.

---

## 1. Supabase 프로젝트 설정 ← 반드시 완료 필요

### 1-1. SQL 스키마 실행

Supabase 대시보드 → **SQL Editor** 에서 `supabase/schema.sql` 전체를 실행합니다.

관리자는 더 이상 `app_settings`나 환경 변수로 미리 지정하지 않습니다. `admins` 테이블이
비어 있으면 앱이 자동으로 "최초 관리자 등록" 화면을 띄우고, 그 화면에서 이메일/비밀번호
또는 Google 계정으로 첫 관리자를 등록합니다 (아래 3장 참고).

### 1-2. Google OAuth 공급자 활성화 (선택 — 최초 관리자 등록 화면에서만 사용)

평소 로그인/회원가입은 전부 아이디·비밀번호 방식이며 Google 로그인 버튼은 화면에서
숨겨져 있습니다. 다만 "최초 관리자 등록" 화면에서는 Google 계정으로도 관리자를 등록할
수 있도록 코드가 유지되어 있으므로, 이 기능을 쓰려면 아래 설정이 필요합니다 (이메일/비밀번호로만
관리자를 등록할 거라면 생략 가능).

**Authentication → Providers → Google** 에서:
- Google Cloud Console에서 생성한 **Client ID / Client Secret** 입력
- Google Cloud Console의 **승인된 리디렉션 URI**에 반드시 추가:
  ```
  https://<your-project-ref>.supabase.co/auth/v1/callback
  ```

### 1-3. Auth URL 설정 ← 이 단계 누락 시 "Unable to exchange external code" 오류 발생

**Authentication → URL Configuration** 에서:

| 항목 | 값 |
|------|----|
| **Site URL** | `https://<your-app>.vercel.app` |
| **Redirect URLs** | `https://<your-app>.vercel.app` (추가) |

> ⚠️ Site URL이 실제 Vercel 도메인과 다르면 OAuth 코드 교환이 실패합니다.  
> 로컬 개발 시에는 `http://localhost:5500` 등을 Redirect URLs에 추가로 등록하세요.

---

## 2. Vercel 환경 변수 설정

**Vercel 대시보드 → Project → Settings → Environment Variables** 에서 아래 값을 추가합니다.

| 변수 | 설명 | 예시 |
|------|------|------|
| `SUPABASE_URL` | Supabase 프로젝트 URL | `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon 공개 키 | `eyJhbGci...` |
| `SUPABASE_SERVICE_ROLE_KEY` | 관리자 서버 함수용 service role 키. 클라이언트에 노출 금지 | `eyJhbGci...` |
| `ID_SUFFIX` | 아이디를 Auth 이메일로 바꿀 때 붙이는 접미사. 생략 시 `ckfqhfl` | `schoolapp` |

`ADMIN_EMAIL`은 더 이상 사용하지 않습니다 (관리자는 DB의 `admins` 테이블로 식별).
`SCHOOL_DOMAIN`도 필수 환경 변수가 아닙니다. 학교 도메인은 최초 관리자 등록 화면에서
`app_settings.school_domain`에 저장됩니다.

환경 변수 추가 후 **Redeploy** 해야 적용됩니다.

---

## 3. 역할 구조 및 회원가입/승인 흐름

회원가입·로그인은 전부 **아이디/비밀번호** 방식이며, Google 로그인 기능은 코드상 유지되지만
화면에는 노출되지 않습니다(최초 관리자 등록 화면 제외).

| 역할 | 식별 방법 |
|------|----------|
| **관리자** | `admins` 테이블에 등록된 계정 |
| **교사** | `teacher_emails` 테이블에 승인된 계정 |
| **학생** | `student_emails` 테이블에 승인된 계정 |

### 최초 관리자 등록 (프로그램을 처음 배포/복제했을 때)
1. `admins` 테이블이 비어 있으면 앱이 로그인 화면 대신 "최초 관리자 등록" 화면을 보여줌
2. 이름/아이디/비밀번호를 입력해 등록하거나, 화면 하단의 Google 버튼으로 등록
3. 등록 즉시 `admins` 테이블에 행이 추가되고 이후로는 이 화면이 다시 나타나지 않음
4. (선택) 같은 화면에서 "학교 도메인 사용"을 체크하고 도메인(예: `jjg.hs.kr`)을 입력하면,
   이후 그 도메인으로 가입하는 교사·학생은 관리자 승인 없이 자동으로 가입됨 (아래
   "학교 도메인 자동승인" 참고). ⚠ 이 설정은 최초 관리자 등록 시에만 입력할 수 있고,
   이후 변경하려면 Supabase 대시보드에서 `app_settings` 값을 직접 수정해야 함.

### 교사·학생 가입 승인 절차
1. 로그인 화면 → "처음이신가요? 회원가입" → 역할(교사/학생) 선택 후 정보 입력
   - 교사: 이름(필수), 담당 교과·담임 학급(선택), 아이디, 비밀번호
   - 학생: 학년, 반, 번호, 이름, 아이디, 비밀번호
2. 신청 시 `teacher_requests`/`student_requests` 테이블에 `pending` 상태로 저장됨
3. 관리자가 "회원 관리" 탭에서 신청 목록을 확인 → 승인/거부
   - 승인 시 `teacher_emails`/`student_emails`에 등록되어 로그인 가능해짐
4. 승인된 계정은 본인이 등록한 아이디/비밀번호로 즉시 로그인 가능

### 학교 도메인과 내부 로그인 아이디
최초 관리자 등록 시 학교 도메인을 설정하면, 교사·학생이 입력한 평문 아이디가 내부적으로
`아이디.ID_SUFFIX@학교도메인` 형식의 Supabase Auth 이메일로 변환됩니다.

예를 들어 `ID_SUFFIX=schoolapp`, 학교 도메인 `example.hs.kr`, 아이디 `student01`이면
실제 Auth 계정은 `student01.schoolapp@example.hs.kr`로 생성됩니다. 실제 이메일 수신은
필요하지 않지만, Supabase Auth의 Email Provider에서 **Confirm email**은 꺼두는 것을
권장합니다.

교사·학생 회원가입은 기본적으로 관리자 승인 대기 상태로 저장되며, 관리자가 "회원 관리"
탭에서 승인해야 로그인할 수 있습니다.

### 학교 Google 계정 가입
최초 관리자 등록 시 `Google 계정 도메인`도 함께 저장합니다. 교사·학생은 회원가입 모달에서
역할별 기초정보를 먼저 입력한 뒤 `Google 계정으로 신청`을 누를 수 있습니다.

OAuth 복귀 후 Google 이메일이 등록된 도메인과 일치하면 해당 이메일로 승인 대기 신청이
생성됩니다. 관리자가 승인하면 이후에는 같은 Google 계정으로 로그인할 수 있습니다.

---

## 4. 로컬 개발

```bash
# src/config.js 를 직접 수정하거나 환경 변수로 생성
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_ANON_KEY=eyJ... \
ID_SUFFIX=schoolapp \
node scripts/generate-config.mjs

# 로컬 서버 실행 (Live Server 등)
# Supabase Auth → Redirect URLs 에 http://localhost:5500 등록 필요
```

---

## 5. 데이터 초기 적재

권장 방식은 배포 후 **관리자 탭 → 데이터 관리**에서 `data/templates/` 형식의 엑셀을
업로드하는 것입니다.

| 데이터 | 권장 템플릿 | 대상 |
|------|------------|------|
| 교육과정 | `curriculum-cohorts-template.xlsx` | `semester_courses` |
| 대학 추천과목 | `university-recommendations-template.xlsx` | `university_recommendations` |
| 계열별 대표 모집단위 반영과목 | `university-recommendations-series-template.xlsx` | `series_reflected_matrix` |
| 참고사이트 | `참고자료.xlsx` | `links` |
| 계정 일괄 생성 | `학생-교사정보.xlsx` | Auth 계정 + 승인 테이블 |

초기 데이터 적재는 관리자 화면의 엑셀 업로드를 기준으로 합니다. 운영 데이터나 개인정보가
섞일 수 있는 로컬 시드 산출물은 배포/커밋하지 않습니다.

---

## 6. 2022SubjectGuide 자료 관리

`data/2022SubjectGuide/`는 예전에 별도 사이트로 배포하던 안내서를 현재 앱 안으로 흡수한
원 데이터 영역입니다. 이 폴더에는 앱이 읽어 들일 `<main>...</main>` HTML 조각만 둡니다.

독립 사이트 시절의 CSS, JavaScript, 최상위 목차 페이지 같은 설정 파일은 이 폴더에 두지
않고 현재 웹앱의 `index.html`과 `src/app.js`에서 관리합니다.

| 항목 | 관리 위치 |
|------|-----------|
| 화면 스타일 | `index.html`의 `.sg-wrap` CSS |
| 검색/필터와 내부 링크 전환 | `src/app.js`의 `SG_DATA_BASE`, `SG_INDEX_URL`, `loadSgPage()` |
| 계열·학과·교과·과목 HTML 원자료 | `data/2022SubjectGuide/` 하위 HTML 조각 |
