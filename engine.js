/* ═══════════════════════════════════════════════════════════════
   결보강 탐색 엔진 (GitHub Pages 정적 버전)
   - 서버 없음: 모든 탐색·시뮬레이션이 브라우저에서 동작
   - 대장 기능 제외: 원본 시간표 기준 정적 판단만 수행
   - Code.gs(fix3)의 순수 로직을 포팅 (동등성 테스트 통과)
   ═══════════════════════════════════════════════════════════════ */

const DAY_IDX = { "월": 1, "화": 2, "수": 3, "목": 4, "금": 5 };

function extractClassName(text) {
  const t = String(text || "").trim();
  const m = t.match(/(\d+\s*-\s*\d+)/);
  return m ? m[1].replace(/\s+/g, "") : t;
}

function splitClassName(className) {
  const t = String(className || "");
  const m = t.match(/(\d+\s*-\s*\d+)/);
  if (m) {
    const cls = m[1].replace(/\s+/g, "");
    const subj = t.slice(0, m.index).replace(/[-–—\s]+$/, "").trim() || t;
    return { subj: subj, cls: cls };
  }
  return { subj: t, cls: "" };
}

/* CSV 파서 (RFC4180 간이 구현: 따옴표·콤마·개행 처리) */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const clean = String(text || "").replace(/^\uFEFF/, "");
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* 무시 */ }
      else field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/* 시트 2차원 배열 → 수업 리스트 파싱 (Code.gs와 동일 레이아웃) */
function parseSheetValues(data) {
  const teacherRow = data[3] || [];
  const teachers = [];
  for (let c = 2; c < teacherRow.length; c++) {
    const name = String(teacherRow[c] || "").trim();
    if (name) teachers.push({ colIndex: c, name: name });
  }
  const scheduleList = [];
  let currentDay = "";
  for (let r = 4; r < data.length; r++) {
    const dayCell = String(data[r][0] || "").trim();
    if (["월", "화", "수", "목", "금"].includes(dayCell)) currentDay = dayCell;
    if (!currentDay) continue;
    const periodCell = String(data[r][1] || "").trim();
    const periodMatch = periodCell.match(/(\d+)/);
    if (!periodMatch) continue;
    const period = parseInt(periodMatch[1], 10);
    teachers.forEach(function(t) {
      const rawSubject = String(data[r][t.colIndex] || "").trim();
      if (!rawSubject) return;
      const rawClassroom = String((data[r + 1] || [])[t.colIndex] || "").trim();
      const subject = rawSubject;
      const classroom = rawClassroom;
      let combinedName = subject;
      if (classroom && !subject.includes(classroom)) combinedName = subject + "-" + classroom;
      const pureClass = extractClassName(classroom) || extractClassName(subject);
      scheduleList.push({
        day: currentDay, period: period, teacher: t.name,
        subject: subject, classroom: classroom,
        className: combinedName, pureClass: pureClass
      });
    });
    r++;
  }
  return scheduleList;
}

/* 교사별/요일별/교시 인덱스: { 교사명: { 요일: { 교시: true } } } */
function buildScheduleIndex(scheduleList) {
  const idx = {};
  scheduleList.forEach(function(s) {
    if (!idx[s.teacher]) idx[s.teacher] = {};
    if (!idx[s.teacher][s.day]) idx[s.teacher][s.day] = {};
    idx[s.teacher][s.day][s.period] = true;
  });
  return idx;
}

/* 공강 여부 (원본 시간표 기준, 대장 없음) */
function isTeacherFree(scheduleIndex, teacher, day, period) {
  return !(scheduleIndex[teacher] && scheduleIndex[teacher][day] && scheduleIndex[teacher][day][period]);
}

/* 연속수업 체크 (대장 없음) */
function checkConsecutive(scheduleIndex, teacher, addDay, addPeriod, removeDay, removePeriod, limit) {
  const dayPeriods = (scheduleIndex[teacher] && scheduleIndex[teacher][addDay]) || {};
  let periods = Object.keys(dayPeriods).map(Number).filter(function(p) {
    return !(addDay === removeDay && p === removePeriod);
  });
  if (periods.indexOf(addPeriod) < 0) periods.push(addPeriod);
  periods.sort(function(a, b) { return a - b; });
  for (let i = 0; i <= periods.length - limit; i++) {
    let isSeq = true;
    for (let k = 0; k < limit - 1; k++) {
      if (periods[i + k + 1] !== periods[i + k] + 1) { isSeq = false; break; }
    }
    if (isSeq) return true;
  }
  return false;
}

function buildGridData(teacherLessons) {
  const grid = {};
  ["월", "화", "수", "목", "금"].forEach(function(d) {
    grid[d] = {};
    for (let p = 1; p <= 7; p++) grid[d][p] = "-";
  });
  teacherLessons.forEach(function(lesson) {
    if (grid[lesson.day] && grid[lesson.day][lesson.period] !== undefined) {
      grid[lesson.day][lesson.period] = lesson.className;
    }
  });
  return grid;
}

/* 교체/보강 탐색 (대장 제외 버전) */
function searchScheduleLocal(scheduleIndex, scheduleList, allTeachers, targetTeacher, targetDay, targetPeriod, consecutiveLimit, isSwap, isSub, subTargetTeacher) {
  const targetLesson = scheduleList.find(function(s) {
    return s.day === targetDay && s.period === targetPeriod && s.teacher === targetTeacher;
  });
  if (!targetLesson) {
    return { success: false, message: "선택하신 시간에 해당 교사의 수업이 없습니다. (데이터: " + targetDay + " " + targetPeriod + "교시)" };
  }
  const targetClass = targetLesson.pureClass || targetLesson.className;

  let swapList = [];
  let substituteList = [];

  if (isSwap) {
    const targetDayNum = DAY_IDX[targetDay] || 0;
    scheduleList.forEach(function(lesson) {
      const lessonClass = lesson.pureClass || lesson.className;
      if (lessonClass === targetClass && lesson.teacher !== targetTeacher) {
        const teacherB = lesson.teacher;
        const dayB = lesson.day;
        const periodB = lesson.period;
        const candidateDayNum = DAY_IDX[dayB] || 0;
        let isFutureOption = (candidateDayNum === targetDayNum) ? (periodB > targetPeriod) : true;
        if (isFutureOption) {
          const isBFreeAtTarget = isTeacherFree(scheduleIndex, teacherB, targetDay, targetPeriod);
          const isAFreeAtCandidate = isTeacherFree(scheduleIndex, targetTeacher, dayB, periodB);
          if (isBFreeAtTarget && isAFreeAtCandidate) {
            let isValid = true;
            if (consecutiveLimit > 0) {
              if (checkConsecutive(scheduleIndex, teacherB, targetDay, targetPeriod, dayB, periodB, consecutiveLimit)) isValid = false;
              else if (checkConsecutive(scheduleIndex, targetTeacher, dayB, periodB, targetDay, targetPeriod, consecutiveLimit)) isValid = false;
            }
            if (isValid) {
              swapList.push({ teacherB: teacherB, dayB: dayB, periodB: periodB, classB: lesson.className });
            }
          }
        }
      }
    });
  }

  if (isSub) {
    let targetCandidates = allTeachers;
    if (subTargetTeacher) targetCandidates = allTeachers.filter(function(t) { return t === subTargetTeacher; });
    targetCandidates.forEach(function(tName) {
      if (tName !== targetTeacher && isTeacherFree(scheduleIndex, tName, targetDay, targetPeriod)) {
        let isValid = true;
        if (consecutiveLimit > 0 && checkConsecutive(scheduleIndex, tName, targetDay, targetPeriod, "", 0, consecutiveLimit)) isValid = false;
        if (isValid) substituteList.push({ teacherB: tName });
      }
    });
  }

  return {
    success: true,
    targetClassName: targetLesson.className,
    swapData: swapList,
    substituteData: substituteList
  };
}

/* 공동 공강 탐색 (대장 제외 버전) */
function findCommonFreeTimeLocal(scheduleIndex, teacherNames) {
  const missingTeachers = teacherNames.filter(function(n) { return !scheduleIndex[n]; });
  if (missingTeachers.length > 0) {
    return { success: false, message: "다음 선생님의 시간표 데이터를 찾을 수 없습니다: " + missingTeachers.join(", ") };
  }
  const commonFreeTimes = [];
  ["월", "화", "수", "목", "금"].forEach(function(d) {
    for (let p = 1; p <= 7; p++) {
      const allFree = teacherNames.every(function(tName) { return isTeacherFree(scheduleIndex, tName, d, p); });
      if (allFree) commonFreeTimes.push({ day: d, period: p });
    }
  });
  return { success: true, teachers: teacherNames, commonFreeTimes: commonFreeTimes };
}

/* 교체 시뮬레이션 */
function simulateSwapLocal(scheduleList, teacherA, dayA, periodA, teacherB, dayB, periodB) {
  const gridA_orig = buildGridData(scheduleList.filter(function(s) { return s.teacher === teacherA; }));
  const gridB_orig = buildGridData(scheduleList.filter(function(s) { return s.teacher === teacherB; }));
  const gridA_new = JSON.parse(JSON.stringify(gridA_orig));
  const gridB_new = JSON.parse(JSON.stringify(gridB_orig));
  gridA_new[dayB][periodB] = gridB_orig[dayB][periodB];
  gridB_new[dayA][periodA] = gridA_orig[dayA][periodA];
  return { success: true, teacherA_orig: gridA_orig, teacherA_new: gridA_new, teacherB_orig: gridB_orig, teacherB_new: gridB_new };
}

/* 보강 시뮬레이션 */
function simulateSubstituteLocal(scheduleList, teacherB, dayA, periodA, classA) {
  const gridB_orig = buildGridData(scheduleList.filter(function(s) { return s.teacher === teacherB; }));
  const gridB_new = JSON.parse(JSON.stringify(gridB_orig));
  gridB_new[dayA][periodA] = classA + "(보강)";
  return { success: true, teacherB_orig: gridB_orig, teacherB_new: gridB_new };
}

/* 교사 시간표 조회 (정적) */
function getTeacherTimetableLocal(scheduleList, teacherName) {
  const lessons = scheduleList.filter(function(s) { return s.teacher === teacherName; });
  if (lessons.length === 0) return { success: false, message: teacherName + " 선생님의 시간표 데이터가 없습니다." };
  return { success: true, timetable: buildGridData(lessons) };
}

/* Node 테스트용 export */
if (typeof module !== "undefined" && module.exports) {
  module.exports = { parseCSV, parseSheetValues, buildScheduleIndex, isTeacherFree, checkConsecutive,
    searchScheduleLocal, findCommonFreeTimeLocal, simulateSwapLocal, simulateSubstituteLocal,
    getTeacherTimetableLocal, extractClassName, splitClassName, buildGridData };
}
