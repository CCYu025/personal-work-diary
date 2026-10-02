import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, reportKind, reportPeriod, weekdayLabel } from "../backend/lib/rules.js";

// 2026-10-02 是週五
const TODAY = "2026-10-02";

test("reportPeriod：今天／本週（週一到週日）／上週／本月", () => {
  assert.deepEqual(reportPeriod("today", TODAY), { start: "2026-10-02", end: "2026-10-02" });
  assert.deepEqual(reportPeriod("week", TODAY), { start: "2026-09-28", end: "2026-10-04" });
  assert.deepEqual(reportPeriod("lastweek", TODAY), { start: "2026-09-21", end: "2026-09-27" });
  assert.deepEqual(reportPeriod("month", TODAY), { start: "2026-10-01", end: "2026-10-31" });
  assert.equal(reportPeriod("nope", TODAY), null);
});

test("reportPeriod：週一、週日、跨年、二月都算對", () => {
  assert.deepEqual(reportPeriod("week", "2026-09-28"), { start: "2026-09-28", end: "2026-10-04" }, "週一");
  assert.deepEqual(reportPeriod("week", "2026-10-04"), { start: "2026-09-28", end: "2026-10-04" }, "週日算在同一週");
  assert.deepEqual(reportPeriod("lastweek", "2027-01-01"), { start: "2026-12-21", end: "2026-12-27" });
  assert.deepEqual(reportPeriod("month", "2028-02-10"), { start: "2028-02-01", end: "2028-02-29" }, "閏年");
});

test("reportKind 依期間決定報表名稱", () => {
  assert.equal(reportKind("2026-10-02", "2026-10-02"), "日報");
  assert.equal(reportKind("2026-09-28", "2026-10-04"), "週報");
  assert.equal(reportKind("2026-09-29", "2026-10-05"), "報告", "七天但不是週一開始");
  assert.equal(reportKind("2026-10-01", "2026-10-31"), "月報");
  assert.equal(reportKind("2026-10-01", "2026-10-30"), "報告", "沒到月底");
  assert.equal(reportKind("2026-09-01", "2026-10-31"), "報告", "跨兩個月");
});

test("weekdayLabel", () => {
  assert.equal(weekdayLabel("2026-10-02"), "五");
  assert.equal(weekdayLabel("2026-10-04"), "日");
});

const todo = (o) => ({ project: "A", content: "x", status: "未開始", created: "2026-09-01", due: null, done: null, note: "", ...o });
const log = (o) => ({ project: "A", content: "x", start: null, end: null, note: "", ...o });

const STORE = {
  todos: [
    todo({ id: 1, content: "上週完成", status: "完成", done: "2026-09-25" }),
    todo({ id: 2, content: "本週完成", status: "完成", done: "2026-10-01" }),
    todo({ id: 3, content: "逾期", project: "B", due: "2026-09-26" }),
    todo({ id: 4, content: "等待中", project: "C", status: "等待中", due: "2026-10-06", note: "卡關：等回覆" }),
    todo({ id: 5, content: "逾期又等待", project: "C", status: "等待中", due: "2026-09-30" }),
    todo({ id: 6, content: "進行中", status: "進行中", due: "2026-10-09" }),
    todo({ id: 7, content: "取消", status: "取消" }),
    todo({ id: 8, content: "期間結束後才建立", created: "2026-10-10" }),
  ],
  logs: [
    log({ id: 1, date: "2026-09-27", content: "上週日" }),
    log({ id: 2, date: "2026-09-30", content: "下午", start: "13:00" }),
    log({ id: 3, date: "2026-09-29", content: "沒時段" }),
    log({ id: 4, date: "2026-09-30", content: "早上", start: "08:00", note: "明天補料" }),
    log({ id: 5, date: "2026-10-01", content: "D 專案", project: "D" }),
    log({ id: 6, date: "2026-10-05", content: "下週" }),
  ],
};

test("buildReport：期間篩選、摘要數字", () => {
  const r = buildReport(STORE, "2026-09-28", "2026-10-04", TODAY);
  assert.equal(r.kind, "週報");
  assert.deepEqual(r.summary, { workDays: 3, logs: 4, completed: 1, open: 4, waiting: 2, overdue: 2 });
  assert.deepEqual(r.completed.map((t) => t.id), [2]);
  // 未完成：逾期的排最前面；取消和期間結束後才建立的不算
  assert.deepEqual(r.open.map((t) => t.id), [3, 5, 4, 6]);
});

test("buildReport：需要協助＝逾期（不論狀態）＋沒逾期的等待中＋日誌問題", () => {
  const r = buildReport(STORE, "2026-09-28", "2026-10-04", TODAY);
  assert.deepEqual(r.overdue.map((t) => t.id), [3, 5]);
  assert.deepEqual(r.waiting.map((t) => t.id), [4], "已經列在逾期的不重複列");
  assert.deepEqual(r.notes.map((l) => l.id), [4]);
  assert.equal(r.hasNotes, true);
});

test("buildReport：每日紀錄舊到新、同一天依時段", () => {
  const r = buildReport(STORE, "2026-09-28", "2026-10-04", TODAY);
  assert.deepEqual(
    r.days.map((d) => [d.date, d.logs.map((l) => l.id)]),
    [["2026-09-29", [3]], ["2026-09-30", [4, 2]], ["2026-10-01", [5]]],
  );
  assert.equal(r.singleProject, null, "有兩個專案的紀錄");
});

test("buildReport：專案燈號與排序（落後 → 注意 → 正常，再依投入天數）", () => {
  const r = buildReport(STORE, "2026-09-28", "2026-10-04", TODAY);
  assert.deepEqual(
    r.projects.map((p) => [p.name, p.rag, p.done, p.open, p.days]),
    [
      ["B", "red", 0, 1, 0],
      ["C", "red", 0, 2, 0],
      ["A", "green", 1, 1, 2],
      ["D", "green", 0, 0, 1],
    ],
  );
  const c = r.projects.find((p) => p.name === "C");
  assert.equal(c.overdue, 1);
  assert.equal(c.waiting, 2);
});

test("buildReport：只有等待中沒有逾期 → amber；整段期間只有一個專案 → singleProject", () => {
  const r = buildReport(
    { todos: [todo({ id: 1, status: "等待中", project: "CCD" })], logs: [log({ id: 1, date: TODAY, project: "機械手臂" })] },
    TODAY,
    TODAY,
    TODAY,
  );
  assert.equal(r.projects.find((p) => p.name === "CCD").rag, "amber");
  assert.equal(r.singleProject, "機械手臂");
  assert.equal(r.hasNotes, false);
});

test("buildReport：空的期間不會壞", () => {
  const r = buildReport({ todos: [], logs: [] }, "2026-01-05", "2026-01-11", TODAY);
  assert.deepEqual(r.summary, { workDays: 0, logs: 0, completed: 0, open: 0, waiting: 0, overdue: 0 });
  assert.deepEqual(r.projects, []);
  assert.deepEqual(r.days, []);
  assert.equal(r.singleProject, null);
});
