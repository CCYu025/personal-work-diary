// Excel 的讀（一次性搬遷用）與寫（匯出快照用）。App 平常從不讀 Excel。
//
// 注意：exceljs 把 Excel 的日期格子讀成「UTC 錨定」的 Date，一定要用 getUTC*() 取年月日。
// 用本地 getDate() 在 UTC+8 的機器上看起來沒事，但在 UTC-X 的時區會變成前一天；
// 反過來寫入時也要用 Date.UTC() 建日期，不然 Excel 裡會差一天。test/xlsx.test.js 有鎖這個行為。

import ExcelJS from "exceljs";
import { rename, rm } from "node:fs/promises";
import { STATUSES, normalizeLog, normalizeTodo, parseTimeRange, sortLogs, sortTodos } from "./rules.js";

export const TODO_HEADERS = ["建立日", "專案", "內容", "狀態", "期限", "完成日", "備註（卡關／下一步）"];
export const LOG_HEADERS = ["日期", "工作類別", "工作內容", "問題／明日計畫", "時段"];

// ---------- 讀 ----------

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return dateToString(v);
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("").trim();
    if ("result" in v) return cellText(v.result);
    if ("text" in v) return String(v.text).trim();
  }
  return String(v).trim();
}

function dateToString(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// 日期格子可能是真的 Date，也可能是有人手打的 "2026/9/7" 字串
function cellDate(v) {
  if (v instanceof Date) return dateToString(v);
  if (v && typeof v === "object" && v.result instanceof Date) return dateToString(v.result);
  const s = cellText(v);
  const m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!m) return s ? s : null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function headerIndex(ws, aliases) {
  const header = ws.getRow(1);
  const map = {};
  header.eachCell((cell, col) => {
    map[cellText(cell.value)] = col;
  });
  const out = {};
  for (const [key, names] of Object.entries(aliases)) {
    out[key] = names.map((n) => map[n]).find(Boolean) ?? null;
  }
  return out;
}

const TODO_ALIASES = {
  created: ["建立日"],
  project: ["專案"],
  content: ["內容"],
  status: ["狀態"],
  due: ["期限"],
  done: ["完成日"],
  note: ["備註（卡關／下一步）", "備註"],
};
const LOG_ALIASES = {
  date: ["日期"],
  project: ["工作類別", "專案"],
  content: ["工作內容"],
  note: ["問題／明日計畫"],
  time: ["時段", "欄1"],
};

/**
 * 讀精簡版 Excel（「待辦」「日誌」「選項」三張工作表）。
 * 回傳整理好的資料和 warnings；有問題的列不會中斷整個搬遷，只會跳過並記在 warnings。
 */
export async function readLegacyWorkbook(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const warnings = [];
  const todos = [];
  const logs = [];
  const projects = [];

  const todoWs = wb.getWorksheet("待辦");
  if (todoWs) {
    const col = headerIndex(todoWs, TODO_ALIASES);
    todoWs.eachRow((row, n) => {
      if (n === 1) return;
      const get = (k) => (col[k] ? row.getCell(col[k]).value : null);
      if (!cellText(get("content"))) return;
      let status = cellText(get("status")) || "未開始";
      if (!STATUSES.includes(status)) {
        warnings.push(`待辦第 ${n} 列：狀態「${status}」不在清單內，改成「未開始」`);
        status = "未開始";
      }
      const created = cellDate(get("created"));
      // 搬遷時不自動補完成日：舊資料沒記就留空，不要用搬遷當天假裝是完成日
      const { value, errors } = normalizeTodo(
        {
          created,
          project: cellText(get("project")) || "其他",
          content: cellText(get("content")),
          status,
          due: cellDate(get("due")),
          done: cellDate(get("done")),
          note: cellText(get("note")),
        },
        created || "1970-01-01",
        { fillDoneDate: false },
      );
      if (errors.length) warnings.push(`待辦第 ${n} 列略過：${errors.join("、")}`);
      else todos.push({ id: todos.length + 1, ...value, updatedAt: null });
    });
  } else {
    warnings.push("找不到「待辦」工作表");
  }

  const logWs = wb.getWorksheet("日誌");
  if (logWs) {
    const col = headerIndex(logWs, LOG_ALIASES);
    logWs.eachRow((row, n) => {
      if (n === 1) return;
      const get = (k) => (col[k] ? row.getCell(col[k]).value : null);
      if (!cellText(get("content"))) return;
      const rawTime = cellText(get("time"));
      const range = parseTimeRange(rawTime);
      let note = cellText(get("note"));
      if (range === null) {
        warnings.push(`日誌第 ${n} 列：時段「${rawTime}」看不懂，原文放進「問題／明日計畫」`);
        note = [note, `（原時段：${rawTime}）`].filter(Boolean).join(" ");
      }
      const { value, errors } = normalizeLog({
        date: cellDate(get("date")),
        project: cellText(get("project")) || "其他",
        content: cellText(get("content")),
        start: range?.start ?? null,
        end: range?.end ?? null,
        note,
      });
      if (errors.length) warnings.push(`日誌第 ${n} 列略過：${errors.join("、")}`);
      else logs.push({ id: logs.length + 1, ...value, updatedAt: null });
    });
  } else {
    warnings.push("找不到「日誌」工作表");
  }

  const optWs = wb.getWorksheet("選項");
  if (optWs) {
    const col = headerIndex(optWs, { project: ["專案"] }).project;
    if (col) {
      optWs.eachRow((row, n) => {
        const p = cellText(row.getCell(col).value);
        if (n > 1 && p && !projects.includes(p)) projects.push(p);
      });
    }
  }

  return { projects, todos, logs, warnings };
}

// ---------- 寫 ----------

function toExcelDate(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * 匯出成跟精簡版一樣欄位的 Excel（「待辦」「日誌」兩張表），給還沒用這個 App 的人看、或傳給主管。
 * 先寫暫存檔再 rename：Excel 開著這個檔案時會寫失敗，但不會把舊檔案寫壞一半。
 * 失敗時丟出的錯誤帶 code（EBUSY／EPERM），server.js 會轉成「請先關掉 Excel」。
 */
export async function writeSnapshotXlsx({ todos, logs }, outFilePath, today) {
  const wb = new ExcelJS.Workbook();

  const tws = wb.addWorksheet("待辦", { views: [{ state: "frozen", ySplit: 1 }] });
  tws.columns = [12, 10, 30, 8, 12, 12, 32].map((width) => ({ width }));
  tws.addRow(TODO_HEADERS).font = { bold: true };
  for (const t of sortTodos(todos, today)) {
    tws.addRow([toExcelDate(t.created), t.project, t.content, t.status, toExcelDate(t.due), toExcelDate(t.done), t.note || ""]);
  }
  for (const c of [1, 5, 6]) tws.getColumn(c).numFmt = "yyyy-mm-dd";
  const lastTodoRow = Math.max(tws.rowCount, 2);
  // 跟精簡版一樣的三條條件格式，打開 Excel 看也是逾期紅、等待中黃、完成／取消灰
  tws.addConditionalFormatting({
    ref: `A2:G${lastTodoRow}`,
    rules: [
      {
        type: "expression",
        priority: 1,
        formulae: ['AND($E2<>"",$E2<TODAY(),$D2<>"完成",$D2<>"取消")'],
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFC7CE" } }, font: { color: { argb: "FF9C0006" } } },
      },
      {
        type: "expression",
        priority: 2,
        formulae: ['$D2="等待中"'],
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFFFEB9C" } } },
      },
      {
        type: "expression",
        priority: 3,
        formulae: ['OR($D2="完成",$D2="取消")'],
        style: { font: { color: { argb: "FF9A9A9A" } } },
      },
    ],
  });

  const lws = wb.addWorksheet("日誌", { views: [{ state: "frozen", ySplit: 1 }] });
  lws.columns = [12, 10, 50, 40, 14].map((width) => ({ width }));
  lws.addRow(LOG_HEADERS).font = { bold: true };
  // 匯出成「舊到新」，跟原本 Excel 往下新增的閱讀順序一致
  const oldestFirst = sortLogs(logs).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const l of oldestFirst) {
    const time = l.start || l.end ? `${l.start || ""}-${l.end || ""}` : "";
    lws.addRow([toExcelDate(l.date), l.project, l.content, l.note || "", time]);
  }
  lws.getColumn(1).numFmt = "yyyy-mm-dd";

  const tmp = `${outFilePath}.tmp-${process.pid}-${Date.now()}.xlsx`;
  try {
    await wb.xlsx.writeFile(tmp);
    await rename(tmp, outFilePath);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
