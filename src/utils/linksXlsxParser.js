// src/utils/linksXlsxParser.js
//
// 관리자 탭 "데이터 관리" 서브탭에서 업로드하는 참고사이트 엑셀 파일(예: 참고자료1.xlsx,
// jjghs-curriculum.xlsx의 "참고사이트" 시트와 동일한 형식)을 브라우저에서 직접 파싱해
// links 테이블 행 배열로 변환한다.
//
// 원본은 헤더(1행)의 실제 텍스트 내용을 읽지 않고 위치(열 순서)만으로 판단한다 —
// category | name | url | description | tags 순서로 고정. 이 파일도 동일하게 동작한다.
//
// ⚠ 한 가지 의도적인 차이: 원본 엑셀의 url 셀이 너무 긴 문자열을 이어붙인 HYPERLINK()
// 수식이라 엑셀 자체에서 이미 #VALUE! 오류로 깨져 있는 경우, 이 파일은 그 오류 셀을
// 감지해 url을 빈 문자열로 남기고 경고로만 알린다 — "#VALUE!"를
// url로 저장해 봐야 참고 탭에서 깨진 링크로 보일 뿐 아무 쓸모가 없기 때문(links 테이블에
// 이미 있는 url이 이런 값이라면 실제로는 원본 엑셀의 수식을 고쳐야 하는 문제).

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * 참고사이트 엑셀 워크북(ArrayBuffer)을 파싱해 links 행 배열로 변환한다.
 * 시트 이름이 "참고사이트"면 그 시트를, 없으면 첫 번째 시트를 사용한다(경고 추가).
 */
export async function parseLinksWorkbook(arrayBuffer) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });

  const warnings = [];
  let sheetName = workbook.SheetNames.includes('참고사이트') ? '참고사이트' : workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('시트를 찾을 수 없습니다. 참고사이트 엑셀 파일이 맞는지 확인해 주세요.');
  }
  if (sheetName !== '참고사이트') {
    warnings.push(`"참고사이트" 시트를 찾지 못해 첫 번째 시트("${sheetName}")를 대신 사용했습니다.`);
  }

  const ws = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  const dataRows = grid.slice(1); // min_row=2(1-indexed) 이후 — 1행은 헤더(내용은 보지 않고 건너뜀)

  const rows = [];
  let sortOrder = 1;
  let brokenUrlCount = 0;

  dataRows.forEach((row, offset) => {
    const sheetRowIndex0 = offset + 1; // grid의 0-based 인덱스(헤더가 0행이므로 데이터는 1행부터)
    const category = text(row?.[0]);
    const name = text(row?.[1]);
    const description = text(row?.[3]);
    const tags = text(row?.[4]);

    if (!name) return; // 빈 행 스킵

    // url 셀이 깨진 수식(#VALUE! 등 오류)인지 확인 — sheet_to_json이 오류 셀을 빈 값으로
    // 돌려주는 경우가 많아 grid만으로는 감지가 안 될 수 있으므로 원본 셀 객체를 직접 본다.
    const urlAddr = XLSX.utils.encode_cell({ r: sheetRowIndex0, c: 2 });
    const urlCell = ws[urlAddr];
    let url;
    if (urlCell && urlCell.t === 'e') {
      url = '';
      brokenUrlCount += 1;
    } else {
      url = text(row?.[2]);
    }

    rows.push({
      category,
      name,
      url,
      description,
      tags,
      sort_order: sortOrder++,
    });
  });

  if (!rows.length) {
    warnings.push('유효한 참고사이트 행을 찾지 못했습니다. 열 순서(category, name, url, description, tags)를 확인해 주세요.');
  }
  if (brokenUrlCount > 0) {
    warnings.push(
      `${brokenUrlCount}개 행의 url 셀이 깨진 수식(#VALUE! 등 오류)이라 빈 값으로 처리했습니다. ` +
      `원본 엑셀에서 해당 링크(대개 너무 긴 문자열을 이어붙인 HYPERLINK 수식)를 확인해 주세요.`
    );
  }

  return { rows, warnings, sheetName };
}
