import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysBetween,
  isOverdue,
  isValidDate,
  knownProjects,
  nextId,
  normalizeLog,
  normalizeTodo,
  parseTimeRange,
  sortLogs,
  sortTodos,
  todayString,
} from "../backend/lib/rules.js";

const TODAY = "2026-09-30";

test("todayString 用本地時間，不是 UTC", () => {
  // 本地 9/30 早上 7 點：在 UTC+8 換算成 UTC 是 9/29，用 toISOString() 會錯
  assert.equal(todayString(new Date(2026, 8, 30, 7, 0)), "2026-09-30");
  assert.equal(todayString(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("isValidDate 擋掉不存在的日期", () => {
  assert.ok(isValidDate("2026-02-28"));
  assert.ok(!isValidDate("2026-02-30"));
  assert.ok(!isValidDate("2026/09/30"));
  assert.ok(!isValidDate(null));
});

test("daysBetween", () => {
  assert.equal(daysBetween("2026-09-26", "2026-09-30"), 4);
  assert.equal(daysBetween("2026-09-30", "2026-10-03"), 3);
  assert.equal(daysBetween("2026-09-30", "2026-09-30"), 0);
});

test("isOverdue 跟 Excel 條件格式同一條規則", () => {
  assert.ok(isOverdue({ due: "2026-09-29", status: "進行中" }, TODAY));
  assert.ok(isOverdue({ due: "2026-09-29", status: "等待中" }, TODAY));
  assert.ok(!isOverdue({ due: "2026-09-30", status: "進行中" }, TODAY), "今天到期還不算逾期");
  assert.ok(!isOverdue({ due: "2026-09-29", status: "完成" }, TODAY));
  assert.ok(!isOverdue({ due: "2026-09-29", status: "取消" }, TODAY));
  assert.ok(!isOverdue({ due: null, status: "未開始" }, TODAY));
});

test("normalizeTodo：必填欄位", () => {
  const { value, errors } = normalizeTodo({ project: "", content: "  " }, TODAY);
  assert.equal(value, null);
  assert.ok(errors.includes("內容為必填"));
  assert.ok(errors.includes("專案為必填"));
});

test("normalizeTodo：預設值、去空白、空字串轉 null", () => {
  const { value, errors } = normalizeTodo({ project: " MES ", content: " 需求整理 ", due: "", note: undefined }, TODAY);
  assert.deepEqual(errors, []);
  assert.deepEqual(value, {
    created: TODAY,
    project: "MES",
    content: "需求整理",
    status: "未開始",
    due: null,
    done: null,
    note: "",
  });
});

test("normalizeTodo：狀態改完成會自動填完成日，已有完成日就保留", () => {
  assert.equal(normalizeTodo({ project: "A", content: "x", status: "完成" }, TODAY).value.done, TODAY);
  assert.equal(normalizeTodo({ project: "A", content: "x", status: "完成", done: "2026-09-17" }, TODAY).value.done, "2026-09-17");
});

test("normalizeTodo：改回完成以外的狀態會清掉完成日", () => {
  for (const status of ["未開始", "進行中", "等待中", "取消"]) {
    assert.equal(normalizeTodo({ project: "A", content: "x", status, done: "2026-09-17" }, TODAY).value.done, null, status);
  }
});

test("normalizeTodo：fillDoneDate:false（搬遷用）不自動補完成日", () => {
  const { value } = normalizeTodo({ project: "A", content: "x", status: "完成" }, TODAY, { fillDoneDate: false });
  assert.equal(value.done, null);
});

test("normalizeTodo：擋掉不合法的狀態和日期", () => {
  const { errors } = normalizeTodo({ project: "A", content: "x", status: "OK", due: "9/30", created: "2026-13-01" }, TODAY);
  assert.equal(errors.length, 3);
});

test("normalizeLog：必填、時段選填", () => {
  assert.equal(normalizeLog({ date: TODAY, project: "A", content: "x" }).errors.length, 0);
  const { errors } = normalizeLog({ date: "", project: "", content: "" });
  assert.equal(errors.length, 3);
});

test("normalizeLog：時段格式與先後", () => {
  const base = { date: TODAY, project: "A", content: "x" };
  assert.deepEqual(normalizeLog({ ...base, start: "25:00" }).errors, ["開始時間格式須為 HH:MM"]);
  assert.deepEqual(normalizeLog({ ...base, start: "10:00", end: "09:00" }).errors, ["結束時間不能早於開始時間"]);
  const ok = normalizeLog({ ...base, start: "09:25", end: "", note: " 明天補料 " });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.value.end, null);
  assert.equal(ok.value.note, "明天補料");
});

test("sortTodos：未結束在前、逾期最前、再依期限，已結束依完成日新到舊", () => {
  const list = [
    { id: 1, status: "完成", done: "2026-09-10", created: "2026-09-01" },
    { id: 2, status: "進行中", due: null, created: "2026-09-02" },
    { id: 3, status: "未開始", due: "2026-10-05", created: "2026-09-03" },
    { id: 4, status: "等待中", due: "2026-09-20", created: "2026-09-04" },
    { id: 5, status: "取消", done: null, created: "2026-09-05" },
    { id: 6, status: "完成", done: "2026-09-20", created: "2026-09-06" },
    { id: 7, status: "未開始", due: "2026-10-01", created: "2026-09-07" },
  ];
  assert.deepEqual(sortTodos(list, TODAY).map((t) => t.id), [4, 7, 3, 2, 6, 1, 5]);
});

test("sortLogs：日期新到舊，同一天依開始時間，沒時段的排最後", () => {
  const list = [
    { id: 1, date: "2026-09-29", start: "08:00" },
    { id: 2, date: "2026-09-30", start: null },
    { id: 3, date: "2026-09-30", start: "13:25" },
    { id: 4, date: "2026-09-30", start: "08:00" },
    { id: 5, date: "2026-09-30", start: "08:00" },
  ];
  assert.deepEqual(sortLogs(list).map((l) => l.id), [4, 5, 3, 2, 1]);
});

test("knownProjects：預設清單在前，其他用過的依最近使用排序，不重複", () => {
  const out = knownProjects({
    projects: ["MES", "機械手臂"],
    todos: [{ created: "2026-09-01", project: "舊專案" }],
    logs: [
      { date: "2026-09-30", project: "新專案" },
      { date: "2026-09-29", project: "機械手臂" },
      { date: "2026-09-28", project: " " },
    ],
  });
  assert.deepEqual(out, ["MES", "機械手臂", "新專案", "舊專案"]);
});

test("parseTimeRange 認得舊 Excel 欄1 的寫法", () => {
  assert.deepEqual(parseTimeRange("0800-1700"), { start: "08:00", end: "17:00" });
  assert.deepEqual(parseTimeRange("09:25-09:45"), { start: "09:25", end: "09:45" });
  assert.deepEqual(parseTimeRange("8:00~17:00"), { start: "08:00", end: "17:00" });
  assert.deepEqual(parseTimeRange(""), { start: null, end: null });
  assert.deepEqual(parseTimeRange(null), { start: null, end: null });
  assert.equal(parseTimeRange("整天"), null);
  assert.equal(parseTimeRange("2500-2600"), null);
});

test("nextId", () => {
  assert.equal(nextId([]), 1);
  assert.equal(nextId([{ id: 3 }, { id: 7 }, { id: 5 }]), 8);
});
