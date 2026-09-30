// 刻意設成 UTC 以外的時區：exceljs 的日期是 UTC 錨定的，程式如果誤用本地 getDate()，
// 在 UTC 的 CI runner 上測不出來，在 UTC-7 就會整個差一天。這行不要拿掉。
process.env.TZ = "America/Los_Angeles";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { LOG_HEADERS, TODO_HEADERS, readLegacyWorkbook, writeSnapshotXlsx } from "../backend/lib/xlsx.js";
import { migrate } from "../scripts/migrate.js";
import { loadStore } from "../backend/lib/store.js";

const d = (y, m, day) => new Date(Date.UTC(y, m - 1, day));

// 仿照精簡版 Excel 的結構做一份測試用檔案（內容是虛構的）
async function makeLegacyWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  const todo = wb.addWorksheet("待辦");
  todo.addRow(["建立日", "專案", "內容", "狀態", "期限", "完成日", "備註（卡關／下一步）"]);
  todo.addRow([d(2026, 9, 7), "專案A", "SOP 製作 ", "完成", null, d(2026, 9, 17), "已交付"]);
  todo.addRow([d(2026, 9, 17), "專案A", { richText: [{ text: "備品" }, { text: "清單" }] }, "進行中", d(2026, 10, 3), null, null]);
  todo.addRow([d(2026, 9, 18), "行政", "舊狀態", "OK", null, null, null]);
  todo.addRow([d(2026, 9, 19), "行政", "完成但沒填完成日", "完成", null, null, null]);
  todo.addRow([null, null, null, null, null, null, null]); // 空列要略過

  const log = wb.addWorksheet("日誌");
  log.addRow(["日期", "工作類別", "工作內容", "問題／明日計畫", "欄1"]);
  log.addRow([d(2026, 9, 7), "專案A", "SOP製作－開機流程", null, null]);
  log.addRow([d(2026, 9, 29), "專案A", "月保養", null, "0800-0940"]);
  log.addRow(["2026/9/30", "專案A", "拆模 ", "明天補料", "整天"]);
  log.addRow([d(2026, 9, 30), "專案A", "裝模", null, "1100-1120"]);

  const opt = wb.addWorksheet("選項");
  opt.addRow(["專案", "狀態", null, "使用說明"]);
  opt.addRow(["MES", "未開始", null, "說明文字"]);
  opt.addRow(["專案A", "進行中"]);
  opt.addRow(["行政", "等待中"]);
  await wb.xlsx.writeFile(file);
}

test("readLegacyWorkbook：日期不受時區影響、時段拆成 start/end、看不懂的保留原文", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pwd-xlsx-"));
  const file = path.join(dir, "legacy.xlsx");
  await makeLegacyWorkbook(file);

  const { projects, todos, logs, warnings } = await readLegacyWorkbook(file);
  assert.deepEqual(projects, ["MES", "專案A", "行政"]);

  assert.equal(todos.length, 4);
  assert.deepEqual(todos[0], {
    id: 1, created: "2026-09-07", project: "專案A", content: "SOP 製作", status: "完成",
    due: null, done: "2026-09-17", note: "已交付", updatedAt: null,
  });
  assert.equal(todos[1].content, "備品清單");
  assert.equal(todos[1].due, "2026-10-03");
  assert.equal(todos[2].status, "未開始", "不認得的狀態改成未開始");
  assert.equal(todos[3].done, null, "舊資料沒填完成日就留空，不拿搬遷當天補");

  assert.equal(logs.length, 4);
  assert.equal(logs[0].date, "2026-09-07");
  assert.deepEqual([logs[1].start, logs[1].end], ["08:00", "09:40"]);
  assert.equal(logs[2].date, "2026-09-30", "手打的 2026/9/30 字串也要認得");
  assert.equal(logs[2].content, "拆模");
  assert.equal(logs[2].start, null);
  assert.equal(logs[2].note, "明天補料 （原時段：整天）");

  assert.ok(warnings.some((w) => w.includes("OK")));
  assert.ok(warnings.some((w) => w.includes("整天")));
  rmSync(dir, { recursive: true, force: true });
});

test("writeSnapshotXlsx：欄位跟精簡版一樣、日期正確、順序舊到新、不留暫存檔", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pwd-xlsx-"));
  const out = path.join(dir, "out.xlsx");
  await writeSnapshotXlsx(
    {
      todos: [
        { id: 1, created: "2026-09-07", project: "A", content: "已完成的", status: "完成", due: null, done: "2026-09-17", note: "" },
        { id: 2, created: "2026-09-20", project: "B", content: "逾期的", status: "進行中", due: "2026-09-25", done: null, note: "卡關" },
      ],
      logs: [
        { id: 1, date: "2026-09-30", project: "A", content: "下午", start: "13:25", end: "13:40", note: "" },
        { id: 2, date: "2026-09-29", project: "A", content: "前一天", start: null, end: null, note: "明天做" },
        { id: 3, date: "2026-09-30", project: "A", content: "早上", start: "08:00", end: "17:00", note: "" },
      ],
    },
    out,
    "2026-09-30",
  );
  assert.deepEqual(readdirSync(dir), ["out.xlsx"]);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const tws = wb.getWorksheet("待辦");
  const lws = wb.getWorksheet("日誌");
  assert.deepEqual(tws.getRow(1).values.slice(1), TODO_HEADERS);
  assert.deepEqual(lws.getRow(1).values.slice(1), LOG_HEADERS);

  // 未完成（逾期）排前面；日期格子是真正的日期，而且用 UTC 讀回來是同一天
  assert.equal(tws.getRow(2).getCell(3).value, "逾期的");
  const due = tws.getRow(2).getCell(5).value;
  assert.ok(due instanceof Date);
  assert.equal(due.toISOString().slice(0, 10), "2026-09-25");
  assert.equal(tws.getRow(3).getCell(6).value.toISOString().slice(0, 10), "2026-09-17");

  assert.deepEqual(
    [2, 3, 4].map((r) => [lws.getRow(r).getCell(3).value, lws.getRow(r).getCell(5).value]),
    [["前一天", ""], ["早上", "08:00-17:00"], ["下午", "13:25-13:40"]],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("migrate：第一次成功；已有 data.json 不加 --force 會停下來；--force 先備份再覆蓋", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pwd-migrate-"));
  const file = path.join(dir, "legacy.xlsx");
  await makeLegacyWorkbook(file);
  const quiet = () => {};

  await migrate({ xlsxPath: file, dataDir: dir, log: quiet });
  const store = await loadStore(dir);
  assert.equal(store.todos.length, 4);
  assert.equal(store.logs.length, 4);
  assert.equal(store.meta.migratedFrom, "legacy.xlsx");

  await assert.rejects(migrate({ xlsxPath: file, dataDir: dir, log: quiet }), /--force/);

  await migrate({ xlsxPath: file, dataDir: dir, force: true, log: quiet });
  assert.ok(readdirSync(dir).some((f) => /^data\.backup-.*\.json$/.test(f)));
  assert.ok(existsSync(path.join(dir, "data.json")));

  await assert.rejects(migrate({ xlsxPath: path.join(dir, "nope.xlsx"), dataDir: dir, log: quiet }), /找不到 Excel/);
  rmSync(dir, { recursive: true, force: true });
});
