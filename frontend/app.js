// 個人工作日誌的前端。排序、逾期判斷這些規則直接 import 後端同一支 rules.js，
// 不要在這裡另外寫一份——兩邊規則不一致時，畫面跟匯出的 Excel 會對不起來。
import { STATUSES, isClosed, isOverdue, daysBetween, sortTodos, sortLogs, todayString } from "/lib/rules.js";

const $ = (s) => document.querySelector(s);
const STATUS_CLASS = { "未開始": "todo", "進行中": "doing", "等待中": "wait", "完成": "done", "取消": "cancel" };

let data = { projects: [], todos: [], logs: [], dataDir: "", exportFile: "" };
const state = {
  view: "today",
  quickProject: "",
  addingProject: false,
  todoFilter: "open",
  todoProject: "",
  logQuery: "",
  logProject: "",
  editing: null, // { type: "todo" | "log", id: number | null }
  armedDelete: false,
  busy: false,
};

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json.errors || [`伺服器回應 ${res.status}`]).join("、"));
  return json;
}

async function loadData() {
  try {
    data = await api("GET", "/api/data");
    $("#load-error").hidden = true;
  } catch (err) {
    $("#load-error-msg").textContent = `讀不到資料：${err.message}。確認 start.bat 的黑色視窗還開著，再重新整理這一頁。`;
    $("#load-error").hidden = false;
  }
  if (!state.quickProject || !data.projects.includes(state.quickProject)) {
    // 預設選最近一筆日誌用的專案，每天通常都在同一個專案上
    const latest = sortLogs(data.logs)[0];
    state.quickProject = latest?.project || data.projects[0] || "其他";
  }
  renderAll();
}

// 寫入後一律重新抓一次完整資料，畫面永遠等於 data.json 的內容
async function mutate(method, url, body) {
  const json = await api(method, url, body);
  await loadData();
  return json;
}

// ---------- helpers ----------
const today = () => todayString();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const md = (d) => { const [, m, dd] = d.split("-"); return `${+m}/${+dd}`; };
const wd = (d) => "日一二三四五六"[new Date(d + "T00:00:00").getDay()];
const icon = (id) => `<svg class="icon"><use href="#${id}"/></svg>`;
const orNull = (v) => (v === "" ? null : v);

function statusPill(s) {
  return `<span class="pill ${STATUS_CLASS[s]}"><span class="dot"></span>${esc(s)}</span>`;
}
function duePill(t) {
  const now = today();
  if (!t.due) return `<span class="muted">—</span>`;
  if (isOverdue(t, now)) return `<span class="pill overdue">逾期 ${daysBetween(t.due, now)} 天 · <span class="mono">${md(t.due)}</span></span>`;
  if (isClosed(t.status)) return `<span class="mono">${md(t.due)}</span>`;
  const n = daysBetween(now, t.due);
  return `<span class="pill due">${md(t.due)} · ${n === 0 ? "今天到期" : "剩 " + n + " 天"}</span>`;
}
function timeHtml(l) {
  if (!l.start && !l.end) return `<span class="log-time none mono">—</span>`;
  return `<span class="log-time mono">${esc(l.start || "?")}${l.end ? `<span class="to">–${esc(l.end)}</span>` : ""}</span>`;
}
function logRow(l) {
  return `<li class="log-row" data-action="edit-log" data-id="${l.id}">
    ${timeHtml(l)}
    <div class="log-body"><div class="log-content">${esc(l.content)}</div>${l.note ? `<div class="log-note">${esc(l.note)}</div>` : ""}</div>
    <span class="proj-tag">${esc(l.project)}</span>
  </li>`;
}
function checkButton(t) {
  return `<button type="button" class="check" data-action="complete" data-id="${t.id}" aria-label="把「${esc(t.content)}」標成完成">${icon("i-check")}</button>`;
}

// ---------- render ----------
function renderAll() {
  renderNav();
  renderToday();
  renderTodos();
  renderLogs();
  $("#proj-list").innerHTML = data.projects.map((p) => `<option value="${esc(p)}">`).join("");
  $("#data-path").innerHTML = data.dataDir
    ? `${esc(data.dataDir.split(/[\\/]/).pop())}<br>data.json`
    : "—";
}

function renderNav() {
  const n = data.todos.filter((t) => isOverdue(t, today())).length;
  const b = $("#nav-badge");
  b.hidden = n === 0;
  b.textContent = n;
  b.title = `${n} 件逾期`;
}

function renderQuickProjects() {
  const list = data.projects.includes(state.quickProject) ? data.projects : [...data.projects, state.quickProject];
  const chips = list.map((p) =>
    `<button type="button" class="proj-chip" data-action="quick-project" data-p="${esc(p)}" aria-pressed="${p === state.quickProject}">${esc(p)}</button>`
  );
  // 清單裡沒有的專案：點「＋ 新專案」直接打名字。記下第一筆之後，knownProjects() 就會把它列進清單
  chips.push(state.addingProject
    ? `<input class="proj-input" id="q-new-project" placeholder="新專案名稱，Enter 確定" aria-label="新專案名稱" maxlength="30">`
    : `<button type="button" class="proj-chip proj-add" data-action="add-project">＋ 新專案</button>`);
  $("#quick-projects").innerHTML = chips.join("");
  const input = $("#q-new-project");
  if (input) {
    input.addEventListener("keydown", onNewProjectKey);
    input.addEventListener("blur", () => commitNewProject(input.value));
    input.focus();
  }
}

function onNewProjectKey(e) {
  // 這個輸入框在「記一筆」表單裡，Enter 不能讓整張表單送出
  if (e.key === "Enter") {
    e.preventDefault();
    commitNewProject(e.target.value);
    $("#q-content").focus();
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    commitNewProject("");
  }
}

function commitNewProject(raw) {
  if (!state.addingProject) return; // blur 和 Enter 可能先後觸發，只處理一次
  state.addingProject = false;
  const name = raw.trim();
  if (name) state.quickProject = name;
  renderQuickProjects();
}

function renderToday() {
  const now = today();
  $("#today-title").innerHTML = `${md(now)} <span class="dow">（${wd(now)}）</span>`;
  const todays = sortLogs(data.logs.filter((l) => l.date === now));
  const open = sortTodos(data.todos.filter((t) => !isClosed(t.status)), now);
  $("#today-desc").textContent = `今天記了 ${todays.length} 筆 · ${open.length} 件待辦還沒完成`;
  $("#today-logs").innerHTML = todays.length
    ? todays.map(logRow).join("")
    : `<li class="empty">今天還沒有紀錄，從上面記第一筆。</li>`;

  const count = (fn) => open.filter(fn).length;
  const c = {
    overdue: count((t) => isOverdue(t, now)),
    doing: count((t) => t.status === "進行中"),
    wait: count((t) => t.status === "等待中"),
    todo: count((t) => t.status === "未開始"),
  };
  $("#todo-summary").innerHTML = [
    c.overdue ? `<span class="pill overdue">逾期 ${c.overdue}</span>` : "",
    c.doing ? `<span class="pill doing">進行中 ${c.doing}</span>` : "",
    c.wait ? `<span class="pill wait">等待中 ${c.wait}</span>` : "",
    c.todo ? `<span class="pill">未開始 ${c.todo}</span>` : "",
  ].join("");

  $("#today-todos").innerHTML = open.length ? open.map((t) => `
    <li class="todo-item">
      ${checkButton(t)}
      <div class="todo-main" data-action="edit-todo" data-id="${t.id}">
        <div class="todo-content">${esc(t.content)}</div>
        <div class="todo-meta">
          <span class="proj-tag">${esc(t.project)}</span>
          ${t.status !== "未開始" ? statusPill(t.status) : ""}
          ${t.due ? duePill(t) : ""}
        </div>
        ${t.note ? `<div class="todo-note">${esc(t.note)}</div>` : ""}
      </div>
      <button type="button" class="btn btn-sm" data-action="log-from" data-id="${t.id}" title="用這件待辦的內容記一筆">記一筆</button>
    </li>`).join("")
    : `<li class="empty">沒有未完成的待辦。</li>`;

  renderQuickProjects();
}

function renderTodos() {
  const now = today();
  const open = data.todos.filter((t) => !isClosed(t.status)).length;
  const segs = [["open", "未完成", open], ["closed", "已結束", data.todos.length - open], ["all", "全部", data.todos.length]];
  $("#todo-seg").innerHTML = segs.map(([v, label, n]) =>
    `<button type="button" data-action="todo-filter" data-v="${v}" aria-pressed="${state.todoFilter === v}">${label}<span class="n">${n}</span></button>`
  ).join("");

  const used = [...new Set(data.todos.map((t) => t.project))];
  $("#todo-projects").innerHTML = [["", "全部專案"], ...used.map((p) => [p, p])].map(([v, label]) =>
    `<button type="button" class="select-chip" data-action="todo-project" data-p="${esc(v)}" aria-pressed="${state.todoProject === v}">${esc(label)}</button>`
  ).join("");

  let list = data.todos.filter((t) =>
    state.todoFilter === "all" ? true : state.todoFilter === "open" ? !isClosed(t.status) : isClosed(t.status));
  if (state.todoProject) list = list.filter((t) => t.project === state.todoProject);
  list = sortTodos(list, now);

  $("#todo-rows").innerHTML = list.length ? list.map((t) => {
    const cls = [isClosed(t.status) ? "closed" : "", t.status === "取消" ? "cancel" : ""].join(" ");
    const check = t.status === "完成"
      ? `<span class="check is-done" aria-label="已完成">${icon("i-check")}</span>`
      : t.status === "取消" ? `<span class="check is-cancel" aria-label="已取消"></span>` : checkButton(t);
    return `<tr class="${cls}" data-action="edit-todo" data-id="${t.id}">
      <td class="c-check">${check}</td>
      <td><div class="t-content">${esc(t.content)}</div>${t.note ? `<div class="t-note">${esc(t.note)}</div>` : ""}</td>
      <td><span class="proj-tag">${esc(t.project)}</span></td>
      <td>${statusPill(t.status)}</td>
      <td>${duePill(t)}</td>
      <td class="date">${md(t.created)}</td>
      <td class="date">${t.done ? md(t.done) : `<span class="muted">—</span>`}</td>
    </tr>`;
  }).join("") : `<tr><td colspan="7" class="empty">這個篩選條件下沒有待辦。</td></tr>`;
}

function renderLogs() {
  const now = today();
  const used = [...new Set(data.logs.map((l) => l.project))];
  $("#log-projects").innerHTML = [["", "全部專案"], ...used.map((p) => [p, p])].map(([v, label]) =>
    `<button type="button" class="select-chip" data-action="log-project" data-p="${esc(v)}" aria-pressed="${state.logProject === v}">${esc(label)}</button>`
  ).join("");

  const q = state.logQuery.trim().toLowerCase();
  const list = sortLogs(data.logs.filter((l) =>
    (!state.logProject || l.project === state.logProject) &&
    (!q || `${l.content} ${l.note} ${l.project}`.toLowerCase().includes(q))));
  const byDate = new Map();
  for (const l of list) {
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push(l);
  }
  $("#log-desc").textContent = q || state.logProject
    ? `找到 ${list.length} 筆，分布在 ${byDate.size} 天`
    : `共 ${data.logs.length} 筆，${new Set(data.logs.map((l) => l.date)).size} 個工作天。每天做了什麼就記一筆。`;

  $("#log-days").innerHTML = byDate.size ? [...byDate].map(([d, items]) => `
    <div class="day-group${d === now ? " is-today" : ""}">
      <div class="day-head">
        <span class="day-date">${md(d)}</span><span class="day-dow">（${wd(d)}）${d === now ? "今天" : ""}</span>
        <span class="day-count">${items.length} 筆</span>
      </div>
      <ol class="timeline">${items.map(logRow).join("")}</ol>
    </div>`).join("")
    : `<p class="empty">${q ? `沒有符合「${esc(state.logQuery)}」的紀錄。` : "還沒有任何日誌。"}</p>`;
}

// ---------- navigation ----------
function go(view) {
  state.view = view;
  ["today", "todos", "logs"].forEach((v) => { $("#view-" + v).hidden = v !== view; });
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.goto === view));
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto)));

// ---------- toast ----------
let toastTimer;
function toast(msg, action) {
  const btn = $("#toast-action");
  $("#toast-msg").textContent = msg;
  btn.hidden = !action;
  btn.onclick = action ? () => { hideToast(); action.fn(); } : null;
  if (action) btn.textContent = action.label;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2600);
}
function hideToast() { $("#toast").classList.remove("show"); }
const fail = (err) => toast(err.message);

// ---------- actions ----------
async function completeTodo(id) {
  const t = data.todos.find((x) => x.id === id);
  if (!t) return;
  const prev = { status: t.status, done: t.done };
  try {
    await mutate("PUT", `/api/todos/${id}`, { status: "完成", done: null });
    toast(`已完成：${t.content}`, {
      label: "復原",
      fn: () => mutate("PUT", `/api/todos/${id}`, prev).catch(fail),
    });
  } catch (err) { fail(err); }
}

function logFromTodo(id) {
  const t = data.todos.find((x) => x.id === id);
  if (!t) return;
  state.quickProject = t.project;
  renderQuickProjects();
  const input = $("#q-content");
  input.value = t.content + "－";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function resetQuickDate() { $("#q-date").value = today(); }

$("#quick-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return; // 防止連按 Enter 送出兩筆一樣的
  const content = $("#q-content").value.trim();
  if (!content) { $("#q-content").focus(); toast("先填「做了什麼」再送出"); return; }
  const date = $("#q-date").value || today();
  state.busy = true;
  $("#q-submit").disabled = true;
  try {
    await mutate("POST", "/api/logs", {
      date,
      project: state.quickProject,
      content,
      start: orNull($("#q-start").value),
      end: orNull($("#q-end").value),
      note: $("#q-note").value,
    });
    ["#q-content", "#q-start", "#q-end", "#q-note"].forEach((s) => { $(s).value = ""; });
    toast(date === today() ? `已記下：${content}` : `已記到 ${md(date)}：${content}`);
    $("#q-content").focus();
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    $("#q-submit").disabled = false;
  }
});

$("#log-search").addEventListener("input", (e) => { state.logQuery = e.target.value; renderLogs(); });

// ---------- slide-over ----------
function openSO(type, title) {
  $("#so-title").textContent = title;
  $("#todo-form").hidden = type !== "todo";
  $("#log-form").hidden = type !== "log";
  $("#so-save").setAttribute("form", type + "-form");
  $("#so-delete").hidden = !state.editing.id;
  disarmDelete();
  $("#scrim").classList.add("open");
  $("#so").classList.add("open");
}
function closeSO() {
  $("#scrim").classList.remove("open");
  $("#so").classList.remove("open");
  state.editing = null;
}
function disarmDelete() {
  state.armedDelete = false;
  $("#so-delete").textContent = "刪除";
  $("#so-delete").classList.remove("armed");
}

$("#t-status").innerHTML = STATUSES.map((s) => `<option>${s}</option>`).join("");
$("#t-status").addEventListener("change", (e) => {
  if (e.target.value === "完成" && !$("#t-done").value) $("#t-done").value = today();
  if (e.target.value !== "完成") $("#t-done").value = "";
});

function openTodo(id) {
  const t = id ? data.todos.find((x) => x.id === id)
    : { created: today(), project: state.quickProject, content: "", status: "未開始", due: null, done: null, note: "" };
  if (!t) return;
  state.editing = { type: "todo", id };
  $("#t-content").value = t.content;
  $("#t-project").value = t.project;
  $("#t-status").value = t.status;
  $("#t-due").value = t.due || "";
  $("#t-created").value = t.created;
  $("#t-done").value = t.done || "";
  $("#t-note").value = t.note || "";
  openSO("todo", id ? "編輯待辦" : "新增待辦");
  if (!id) setTimeout(() => $("#t-content").focus(), 60);
}

function openLog(id) {
  const l = data.logs.find((x) => x.id === id);
  if (!l) return;
  state.editing = { type: "log", id };
  $("#l-date").value = l.date;
  $("#l-project").value = l.project;
  $("#l-content").value = l.content;
  $("#l-start").value = l.start || "";
  $("#l-end").value = l.end || "";
  $("#l-note").value = l.note || "";
  openSO("log", `${md(l.date)}（${wd(l.date)}）的紀錄`);
}

async function saveEditing(url, method, body, okMsg) {
  if (state.busy) return;
  state.busy = true;
  $("#so-save").disabled = true;
  try {
    await mutate(method, url, body);
    closeSO();
    toast(okMsg);
  } catch (err) {
    fail(err);
  } finally {
    state.busy = false;
    $("#so-save").disabled = false;
  }
}

$("#todo-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const body = {
    content: $("#t-content").value,
    project: $("#t-project").value.trim() || "其他",
    status: $("#t-status").value,
    due: orNull($("#t-due").value),
    created: orNull($("#t-created").value),
    done: orNull($("#t-done").value),
    note: $("#t-note").value,
  };
  const { id } = state.editing;
  saveEditing(id ? `/api/todos/${id}` : "/api/todos", id ? "PUT" : "POST", body, id ? "已更新待辦" : `已新增待辦：${body.content.trim()}`);
});

$("#log-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const body = {
    date: $("#l-date").value,
    project: $("#l-project").value.trim() || "其他",
    content: $("#l-content").value,
    start: orNull($("#l-start").value),
    end: orNull($("#l-end").value),
    note: $("#l-note").value,
  };
  saveEditing(`/api/logs/${state.editing.id}`, "PUT", body, "已更新紀錄");
});

$("#so-delete").addEventListener("click", async () => {
  // 瀏覽器的 confirm() 很容易手滑按掉，改成按鈕本身按兩次
  if (!state.armedDelete) {
    state.armedDelete = true;
    $("#so-delete").textContent = "再按一次確定刪除";
    $("#so-delete").classList.add("armed");
    return;
  }
  const { type, id } = state.editing;
  try {
    await mutate("DELETE", `/api/${type === "todo" ? "todos" : "logs"}/${id}`);
    closeSO();
    toast("已刪除");
  } catch (err) { fail(err); }
});

async function exportXlsx() {
  try {
    const { path } = await api("POST", "/api/export-xlsx");
    toast(`已匯出：${path}`);
  } catch (err) { fail(err); }
}

document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.editing) closeSO(); });

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const id = Number(el.dataset.id);
  switch (el.dataset.action) {
    case "complete": completeTodo(id); break;
    case "log-from": logFromTodo(id); break;
    case "edit-todo": openTodo(id); break;
    case "new-todo": openTodo(null); break;
    case "edit-log": openLog(id); break;
    case "close-so": closeSO(); break;
    case "quick-project": state.quickProject = el.dataset.p; renderQuickProjects(); break;
    case "add-project": state.addingProject = true; renderQuickProjects(); break;
    case "todo-filter": state.todoFilter = el.dataset.v; renderTodos(); break;
    case "todo-project": state.todoProject = el.dataset.p; renderTodos(); break;
    case "log-project": state.logProject = el.dataset.p; renderLogs(); break;
    case "export": exportXlsx(); break;
  }
});

// 視窗開著過夜的話，回到這個分頁時把「今天」和日期欄位換成新的一天
let lastToday = today();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (today() !== lastToday) {
    lastToday = today();
    resetQuickDate();
  }
  loadData();
});

resetQuickDate();
loadData();
