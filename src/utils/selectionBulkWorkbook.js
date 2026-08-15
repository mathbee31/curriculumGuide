function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function toIntText(value) {
  const clean = text(value);
  if (!clean) return '';
  const n = Number(clean);
  if (!Number.isFinite(n)) return clean;
  return String(Math.trunc(n));
}

function semesterShortToLabel(value) {
  const clean = text(value);
  const m = /^([123])\s*-\s*([12])$/.exec(clean);
  if (!m) return clean;
  return `${m[1]}학년 ${m[2]}학기`;
}

function semesterLabelToShort(value) {
  const clean = text(value);
  const m = /^([123])학년\s*([12])학기$/.exec(clean);
  if (!m) return clean;
  return `${m[1]}-${m[2]}`;
}

function groupTextToGroup(value) {
  const clean = text(value);
  if (!clean) return '';
  const direct = /^선택\s*(\d+)$/.exec(clean);
  if (direct) return `선택${Number(direct[1])}`;
  if (/^[A-Z]$/i.test(clean)) {
    const idx = clean.toUpperCase().charCodeAt(0) - 64;
    return idx > 0 ? `선택${idx}` : '';
  }
  return clean;
}

function groupToLetter(value) {
  const m = /^선택\s*(\d+)$/.exec(text(value));
  if (!m) return text(value);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 1 || n > 26) return text(value);
  return String.fromCharCode(64 + n);
}

function selectedFlag(value) {
  const clean = text(value);
  return clean === '1' || clean === '1.0' || clean.toUpperCase() === 'Y' || clean === '✓';
}

function parseStudentCode(value, fallbackGrade) {
  const raw = toIntText(value);
  if (!raw || raw === '0') return null;
  const padded = raw.padStart(5, '0');
  const grade = fallbackGrade || String(Number(padded.slice(0, -4)) || '');
  const tail = padded.slice(-4);
  return {
    raw,
    grade,
    classNo: String(Number(tail.slice(0, 2)) || ''),
    number: String(Number(tail.slice(2, 4)) || ''),
  };
}

function studentCode(record, grade) {
  const g = Number(grade || record.grade) || 0;
  const cls = String(record.classNo || '').padStart(2, '0');
  const num = String(record.number || '').padStart(2, '0');
  if (!g || !record.classNo || !record.number) return '';
  return `${g}${cls}${num}`;
}

function getCell(row, col) {
  return row && col < row.length ? row[col] : '';
}

function buildCourseColumns(allCohortGroups, cohortYear) {
  const target = String(cohortYear || '');
  const columns = [];
  for (const group of allCohortGroups || []) {
    if (String(group.cohortYear || '') !== target) continue;
    const shortSemester = semesterLabelToShort(group.semester);
    for (const course of group.courses || []) {
      const groupName = text(course.group);
      const groupMatch = /^선택\s*(\d+)$/.exec(groupName);
      const groupNo = groupMatch ? Number(groupMatch[1]) : 0;
      if (groupName === '지정' || groupNo < 3) continue;
      columns.push({
        semester: group.semester,
        semesterShort: shortSemester,
        group: groupName,
        groupLetter: groupToLetter(groupName),
        courseName: course.name,
        key: `${group.semester}::${groupName}::${course.name}`,
      });
    }
  }
  return columns;
}

function normalizeRecordKey(record) {
  return [record.grade, record.classNo, record.number].map(toIntText).join('::');
}

function hasStudentIdentity(record) {
  return Boolean(toIntText(record.grade) && toIntText(record.classNo) && toIntText(record.number));
}

export async function parseSelectionBulkWorkbook(arrayBuffer) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('수강신청 시트를 찾지 못했습니다.');

  const ws = workbook.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  if (grid.length < 6) throw new Error('수강신청 양식의 1~5행 헤더와 학생 행을 확인해 주세요.');

  const semesterHeader = grid[1] || [];
  const groupHeader = grid[2] || [];
  const courseHeader = grid[3] || [];
  const idHeader = grid[4] || [];
  const columns = [];
  let lastSemester = '';
  let lastGroup = '';
  const maxCols = Math.max(semesterHeader.length, groupHeader.length, courseHeader.length, idHeader.length);
  for (let col = 5; col < maxCols; col++) {
    const semesterCell = text(getCell(semesterHeader, col));
    const groupCell = text(getCell(groupHeader, col));
    if (semesterCell) lastSemester = semesterCell;
    if (groupCell) lastGroup = groupCell;
    const semester = semesterShortToLabel(lastSemester);
    const group = groupTextToGroup(lastGroup);
    const courseName = text(getCell(courseHeader, col));
    if (!semester || !group || !courseName) continue;
    columns.push({
      col,
      semester,
      group,
      courseName,
      courseId: text(getCell(idHeader, col)),
      key: `${semester}::${group}::${courseName}`,
    });
  }

  const students = [];
  const warnings = [];
  for (let r = 5; r < grid.length; r++) {
    const row = grid[r] || [];
    const name = text(getCell(row, 3));
    const studentIds = [0, 1, 2]
      .map(col => {
        const gradeLabel = text(getCell(semesterHeader, col));
        const grade = /^([123])/.exec(gradeLabel)?.[1] || String(col + 1);
        return parseStudentCode(getCell(row, col), grade);
      })
      .filter(Boolean);
    if (!name && !studentIds.length) continue;
    if (studentIds.length !== 1) {
      warnings.push(`${r + 1}행 ${name || '(이름 없음)'}: A~C 학년별 번호 칸 중 하나만 입력되어야 합니다.`);
      continue;
    }
    const id = studentIds[0];
    const selectedMap = {};
    for (const colInfo of columns) {
      if (selectedFlag(getCell(row, colInfo.col))) selectedMap[colInfo.key] = true;
    }
    students.push({
      rowNo: r + 1,
      name,
      grade: id.grade,
      classNo: id.classNo,
      number: id.number,
      externalId: text(getCell(row, 4)),
      selectedMap,
      selectedCount: Object.keys(selectedMap).length,
    });
  }

  return { sheetName, columns, students, warnings };
}

export async function downloadSelectionStatusWorkbook({
  records = [],
  allCohortGroups = [],
  currentAcademicYear,
  getCohortYear,
  fileName = 'selection-status.xlsx',
} = {}) {
  const XLSX = await import('https://esm.sh/xlsx@0.18.5');
  const workbook = XLSX.utils.book_new();
  const grades = [...new Set(records.map(r => text(r.grade)).filter(Boolean))]
    .sort((a, b) => Number(a) - Number(b));

  for (const grade of grades) {
    const cohortYear = getCohortYear?.(grade, currentAcademicYear);
    const columns = buildCourseColumns(allCohortGroups, cohortYear);
    const gradeRecords = records
      .filter(r => text(r.grade) === grade)
      .sort((a, b) => (Number(a.classNo) - Number(b.classNo)) || (Number(a.number) - Number(b.number)));
    const colCount = 5 + columns.length;
    const aoa = [
      ["고유번호는 절대 변경하지 말고 수강신청 여부만 '1'과 '0'으로 구분하여 입력하세요."],
      ['1학년', '2학년', '3학년', '이름', '학기'],
      [null, null, null, null, '선택그룹'],
      [null, null, null, null, '과목'],
      [null, null, null, null, '고유번호'],
    ];
    for (let i = 0; i < columns.length; i++) {
      const c = 5 + i;
      aoa[1][c] = columns[i].semesterShort;
      aoa[2][c] = columns[i].groupLetter;
      aoa[3][c] = columns[i].courseName;
      aoa[4][c] = `${columns[i].semesterShort.replace('-', 'Y')}ST${String(i + 1).padStart(3, '0')}`;
    }
    for (const record of gradeRecords) {
      const row = [0, 0, 0, record.name || '', record.email || ''];
      const gradeCol = Math.max(0, Math.min(2, Number(record.grade) - 1));
      row[gradeCol] = studentCode(record, record.grade);
      const selectedMap = record.selectedMap || {};
      for (const column of columns) row.push(selectedMap[column.key] ? 1 : 0);
      aoa.push(row);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: Math.max(0, colCount - 1) } },
      { s: { r: 1, c: 0 }, e: { r: 4, c: 0 } },
      { s: { r: 1, c: 1 }, e: { r: 4, c: 1 } },
      { s: { r: 1, c: 2 }, e: { r: 4, c: 2 } },
      { s: { r: 1, c: 3 }, e: { r: 4, c: 3 } },
    ];

    for (let start = 5; start < colCount;) {
      const semester = aoa[1][start];
      let end = start;
      while (end + 1 < colCount && aoa[1][end + 1] === semester) end++;
      if (end > start) ws['!merges'].push({ s: { r: 1, c: start }, e: { r: 1, c: end } });
      start = end + 1;
    }
    for (let start = 5; start < colCount;) {
      const group = aoa[2][start];
      let end = start;
      while (end + 1 < colCount && aoa[2][end + 1] === group) end++;
      if (end > start) ws['!merges'].push({ s: { r: 2, c: start }, e: { r: 2, c: end } });
      start = end + 1;
    }

    ws['!cols'] = Array.from({ length: colCount }, (_, i) => ({ wch: i < 5 ? 12 : 16 }));
    XLSX.utils.book_append_sheet(workbook, ws, `${grade}학년`);
  }

  if (!grades.length) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['다운로드할 학생이 없습니다.']]), '수강신청');
  }
  XLSX.writeFile(workbook, fileName);
}

export function matchBulkSelectionStudents(parsedStudents, records) {
  const recordByKey = new Map();
  const duplicates = new Set();
  for (const record of records || []) {
    if (!hasStudentIdentity(record)) continue;
    const key = normalizeRecordKey(record);
    if (recordByKey.has(key)) duplicates.add(key);
    recordByKey.set(key, record);
  }

  const matched = [];
  const missing = [];
  for (const student of parsedStudents || []) {
    const key = normalizeRecordKey(student);
    const record = recordByKey.get(key);
    if (!record || duplicates.has(key)) {
      missing.push({ ...student, reason: duplicates.has(key) ? '동일 학번 학생이 여러 명입니다.' : '승인된 학생 목록에서 찾지 못했습니다.' });
      continue;
    }
    matched.push({ ...student, email: record.email, previousCount: record.selections?.length || 0 });
  }
  return { matched, missing };
}
