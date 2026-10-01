import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

import { createStoreQueue, loadStore } from "./lib/store.js";
import { knownProjects, nextId, normalizeLog, normalizeTodo, todayString } from "./lib/rules.js";
import { writeSnapshotXlsx } from "./lib/xlsx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// DATA_DIR 沒設定時用內建範例資料開機，clone 下來不用準備任何東西就能看畫面。
// 自己電腦上的正式資料夾路徑放在 .env，不進版控。
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data", "example");
const PORT = Number(process.env.PORT) || 3001;
export const EXPORT_FILENAME = "個人工作日誌_匯出.xlsx";

const withStore = createStoreQueue(DATA_DIR);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));
// 前端直接 import 這支規則檔，前後端用同一套排序／逾期判斷（見 CLAUDE.md）
app.get("/lib/rules.js", (req, res) => {
  res.type("application/javascript").sendFile(path.join(__dirname, "lib", "rules.js"));
});

const parseId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const now = () => new Date().toISOString();
// Express 4 不會自己接 async handler 丟出的錯誤，包一層交給最後的錯誤處理
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get("/api/data", wrap(async (req, res) => {
  const store = await loadStore(DATA_DIR);
  res.json({
    today: todayString(),
    projects: knownProjects(store),
    todos: store.todos,
    logs: store.logs,
    dataDir: DATA_DIR,
    exportFile: EXPORT_FILENAME,
  });
}));

// 待辦／日誌的新增、修改、刪除長得幾乎一樣，用同一組產生器掛上去
function mountCollection(name, normalize) {
  app.post(`/api/${name}`, wrap(async (req, res) => {
    const { value, errors } = normalize(req.body || {});
    if (errors.length) return res.status(400).json({ errors });
    const item = await withStore((store) => {
      const created = { id: nextId(store[name]), ...value, updatedAt: null };
      store[name].push(created);
      return created;
    });
    res.status(201).json({ item });
  }));

  app.put(`/api/${name}/:id`, wrap(async (req, res) => {
    const id = parseId(req);
    let errors = [];
    const item = await withStore((store) => {
      const existing = store[name].find((x) => x.id === id);
      if (!existing) return false;
      const result = normalize({ ...existing, ...(req.body || {}) });
      if (result.errors.length) {
        errors = result.errors;
        return false;
      }
      Object.assign(existing, result.value, { updatedAt: now() });
      return existing;
    });
    if (errors.length) return res.status(400).json({ errors });
    if (!item) return res.status(404).json({ errors: ["找不到這一筆"] });
    res.json({ item });
  }));

  app.delete(`/api/${name}/:id`, wrap(async (req, res) => {
    const id = parseId(req);
    const removed = await withStore((store) => {
      const idx = store[name].findIndex((x) => x.id === id);
      if (idx === -1) return false;
      store[name].splice(idx, 1);
      return true;
    });
    if (!removed) return res.status(404).json({ errors: ["找不到這一筆"] });
    res.json({ deleted: true });
  }));
}

mountCollection("todos", (input) => normalizeTodo(input, todayString()));
mountCollection("logs", (input) => normalizeLog(input));

app.post("/api/export-xlsx", wrap(async (req, res) => {
  const store = await loadStore(DATA_DIR);
  const outPath = path.join(DATA_DIR, EXPORT_FILENAME);
  try {
    await writeSnapshotXlsx(store, outPath, todayString());
    res.json({ path: outPath });
  } catch (err) {
    if (err.code === "EBUSY" || err.code === "EPERM") {
      return res.status(409).json({ errors: [`${EXPORT_FILENAME} 正在被 Excel 開著，關掉之後再匯出一次`] });
    }
    throw err;
  }
}));

// 壞掉的 JSON、或任何沒接到的錯誤：回傳 JSON 讓前端顯示，不要吐 HTML 錯誤頁
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ errors: ["請求內容不是合法的 JSON"] });
  console.error(err);
  res.status(500).json({ errors: [err.message || "伺服器錯誤"] });
});

// 只有直接執行這支檔案時才啟動；被測試 import 時不要自動開伺服器／瀏覽器
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, "127.0.0.1", () => {
    console.log(`個人工作日誌已啟動： http://localhost:${PORT}`);
    console.log(`資料夾： ${DATA_DIR}`);
    if (process.platform === "win32" && !process.env.NO_OPEN_BROWSER) {
      exec(`start "" "http://localhost:${PORT}"`);
    }
  });
}

export default app;
export { DATA_DIR };
