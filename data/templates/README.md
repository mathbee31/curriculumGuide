# 엑셀 입력 템플릿

이 폴더의 `.xlsx` 파일은 관리자 화면에서 업로드할 수 있는 공개 배포용 입력 템플릿입니다.
기존 운영 파일에서 파서가 필요로 하는 시트명, 헤더, 좌표 구조만 남기고 실제 데이터 행이나
민감 값은 비워 두었습니다.

실제 학교 운영 자료, 학생/교사 명단, 선택 결과, 개인별 수강신청 URL, 비밀번호 값은 포함하지 않습니다.

## 관리자 업로드용 권장 파일

| 업로드 메뉴 | 권장 템플릿 | 대상 테이블/기능 |
|---|---|---|
| 교육과정 | `curriculum-cohorts-template.xlsx` | `semester_courses` |
| 대학 추천과목 | `university-recommendations-template.xlsx` | `university_recommendations` |
| 계열별 대표 모집단위 반영과목 | `university-recommendations-series-template.xlsx` | `series_reflected_matrix` |
| 참고사이트 | `참고자료.xlsx` | `links` |
| 계정 일괄 생성 | `학생-교사정보.xlsx` | Supabase Auth 계정 + 승인 테이블 |

## 구조 보존 규칙

- `curriculum-cohorts-template.xlsx`: `○○○○학년도 입학생 3개년` 형식의 시트명, 3~4행 헤더, I~N 학기별 학점 열을 유지합니다.
- `university-recommendations-template.xlsx`: `Sheet1`의 1~4행 헤더와 5행 이후 입력 구조를 유지합니다.
- `university-recommendations-series-template.xlsx`: `반영과목` 시트의 1~4행 다중 헤더와 C~R열 과목군 구조를 유지합니다.
- `참고자료.xlsx`: `참고사이트` 시트의 `category, name, url, description, tags` 구조를 사용합니다.
- `학생-교사정보.xlsx`: `N학년-학생`, `N학년-교사` 시트와 1행 헤더를 유지합니다.

## 참고

`template-index.json`에는 원본 파일명과 파서 호환 파일명의 매핑이 남아 있습니다. 현재 폴더에는
실제 운영 자료 대신 위 권장 파일명으로 된 공개용 템플릿을 둡니다.
