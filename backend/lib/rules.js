// 待辦／日誌的欄位規則（純函式）。
// 前後端共用：server.js 用它驗證寫入，frontend/index.html 透過 /lib/rules.js 直接 import 它排序、判斷逾期。
// 所以這支檔案**不能 import 任何 node: 模組**，要能直接在瀏覽器跑。

export const STATUSES = ["未開始", "進行中", "等待中", "完成", "取消"];
export const CLOSED_STATUSES = ["完成", "取消"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isClosed(status) {
  return CLOSED_STATUSES.includes(status);
}

// 本地時區的今天，格式 YYYY-MM-DD。刻意不用 toISOString()——那是 UTC，
// 台灣早上 8 點前會變成「昨天」。
export function todayString(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(s) {
  return typeof s === "string" && TIME_RE.test(s);
}

// b - a 的天數（兩個都是 YYYY-MM-DD）
export function daysBetween(a, b) {
  const toUtc = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

// 跟 Excel 條件格式同一條規則：有期限、期限已過、還沒完成也沒取消
export function isOverdue(todo, today) {
  return Boolean(todo.due) && todo.due < today && !isClosed(todo.status);
}

const blankToNull = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

/**
 * 驗證並整理一筆待辦。input 是「完整的」待辦（更新時由呼叫端先把舊資料和新欄位合併）。
 * 完成日規則：狀態是「完成」但沒填完成日 → 自動填 today；狀態不是「完成」→ 清掉完成日。
 * fillDoneDate:false 只給搬遷用——舊資料沒記完成日就留空，不拿搬遷當天冒充。
 * @returns {{ value: object|null, errors: string[] }}
 */
export function normalizeTodo(input, today, { fillDoneDate = true } = {}) {
  const errors = [];
  const value = {
    created: blankToNull(input.created) ?? today,
    project: text(input.project),
    content: text(input.content),
    status: text(input.status) || "未開始",
    due: blankToNull(input.due),
    done: blankToNull(input.done),
    note: text(input.note),
  };

  if (!value.content) errors.push("內容為必填");
  if (!value.project) errors.push("專案為必填");
  if (!STATUSES.includes(value.status)) errors.push(`狀態必須是：${STATUSES.join("／")}`);
  if (!isValidDate(value.created)) errors.push("建立日格式須為 YYYY-MM-DD");
  if (value.due !== null && !isValidDate(value.due)) errors.push("期限格式須為 YYYY-MM-DD");
  if (value.done !== null && !isValidDate(value.done)) errors.push("完成日格式須為 YYYY-MM-DD");

  if (fillDoneDate && value.status === "完成" && value.done === null) value.done = today;
  if (value.status !== "完成") value.done = null;

  return errors.length ? { value: null, errors } : { value, errors };
}

/**
 * 驗證並整理一筆日誌。時段（start/end）都是選填；兩個都有時結束不能早於開始。
 * @returns {{ value: object|null, errors: string[] }}
 */
export function normalizeLog(input) {
  const errors = [];
  const value = {
    date: blankToNull(input.date),
    project: text(input.project),
    content: text(input.content),
    start: blankToNull(input.start),
    end: blankToNull(input.end),
    note: text(input.note),
  };

  if (!isValidDate(value.date)) errors.push("日期格式須為 YYYY-MM-DD");
  if (!value.project) errors.push("專案為必填");
  if (!value.content) errors.push("工作內容為必填");
  if (value.start !== null && !isValidTime(value.start)) errors.push("開始時間格式須為 HH:MM");
  if (value.end !== null && !isValidTime(value.end)) errors.push("結束時間格式須為 HH:MM");
  if (value.start && value.end && isValidTime(value.start) && isValidTime(value.end) && value.end < value.start) {
    errors.push("結束時間不能早於開始時間");
  }

  return errors.length ? { value: null, errors } : { value, errors };
}

/**
 * 待辦排序：未結束的在前；未結束裡逾期的最前面，再依期限近到遠（沒期限的排後面），最後依建立日。
 * 已結束的依完成日新到舊。
 */
export function sortTodos(list, today) {
  const openKey = (t) => [isOverdue(t, today) ? 0 : 1, t.due || "9999-99-99", t.created || "", t.id || 0];
  const cmp = (ka, kb) => {
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] < kb[i]) return -1;
      if (ka[i] > kb[i]) return 1;
    }
    return 0;
  };
  return [...list].sort((a, b) => {
    const ca = isClosed(a.status), cb = isClosed(b.status);
    if (ca !== cb) return ca ? 1 : -1;
    if (ca) return cmp([b.done || "", b.id || 0], [a.done || "", a.id || 0]);
    return cmp(openKey(a), openKey(b));
  });
}

/** 日誌排序：日期新到舊；同一天依開始時間早到晚（沒填時段的排最後），再依建立順序。 */
export function sortLogs(list) {
  return [...list].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const sa = a.start || "99:99", sb = b.start || "99:99";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return (a.id || 0) - (b.id || 0);
  });
}

/**
 * 專案清單是開放式的：data.json 裡的 projects（從 Excel「選項」頁搬來的預設順序）
 * 加上待辦／日誌裡實際用過的專案。不要寫死成 enum——新專案隨時會冒出來。
 */
export function knownProjects({ projects = [], todos = [], logs = [] }) {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    const s = text(p);
    if (s && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  projects.forEach(add);
  // 預設清單以外的專案：最近用過的排前面
  [...logs.map((l) => [l.date, l.project]), ...todos.map((t) => [t.created, t.project])]
    .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
    .forEach(([, p]) => add(p));
  return out;
}

/**
 * 舊版 Excel「欄1」的時段字串 → { start, end }。
 * 接受 "0800-1700"、"08:00-17:00"、"8:00~17:00"；看不懂就回傳 null，由呼叫端決定怎麼保留原文。
 */
export function parseTimeRange(raw) {
  const s = text(raw).replace(/\s/g, "");
  if (!s) return { start: null, end: null };
  const m = s.match(/^(\d{1,2}):?(\d{2})[-~－～](\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const start = `${m[1].padStart(2, "0")}:${m[2]}`;
  const end = `${m[3].padStart(2, "0")}:${m[4]}`;
  if (!isValidTime(start) || !isValidTime(end)) return null;
  return { start, end };
}

export function nextId(list) {
  return list.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
}
