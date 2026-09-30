import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { todayString } from "../backend/lib/rules.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "pwd-api-"));
process.env.DATA_DIR = dataDir;
process.env.NO_OPEN_BROWSER = "1";

const { default: app, EXPORT_FILENAME } = await import("../backend/server.js");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("全新資料夾：GET /api/data 回傳空資料和今天日期", async () => {
  const { status, body } = await call("GET", "/api/data");
  assert.equal(status, 200);
  assert.deepEqual(body.todos, []);
  assert.deepEqual(body.logs, []);
  assert.equal(body.today, todayString());
  assert.equal(body.exportFile, EXPORT_FILENAME);
});

test("首頁和前端共用的 rules.js 都拿得到", async () => {
  const html = await fetch(base + "/");
  assert.equal(html.status, 200);
  assert.match(await html.text(), /個人工作日誌/);
  const rules = await fetch(base + "/lib/rules.js");
  assert.equal(rules.status, 200);
  assert.match(rules.headers.get("content-type"), /javascript/);
  // 只開放 rules.js，其他後端程式不對外
  assert.equal((await fetch(base + "/lib/store.js")).status, 404);
});

test("待辦：新增 → 改成完成自動填完成日 → 改回進行中清掉 → 刪除", async () => {
  const bad = await call("POST", "/api/todos", { project: "MES" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.includes("內容為必填"));

  const created = await call("POST", "/api/todos", { project: "MES", content: "需求整理", due: "2026-10-03" });
  assert.equal(created.status, 201);
  const id = created.body.item.id;
  assert.equal(created.body.item.status, "未開始");
  assert.equal(created.body.item.created, todayString());

  const done = await call("PUT", `/api/todos/${id}`, { status: "完成" });
  assert.equal(done.status, 200);
  assert.equal(done.body.item.done, todayString());
  assert.equal(done.body.item.content, "需求整理", "只送部分欄位時其他欄位要保留");
  assert.ok(done.body.item.updatedAt);

  const reopened = await call("PUT", `/api/todos/${id}`, { status: "進行中" });
  assert.equal(reopened.body.item.done, null);

  const invalid = await call("PUT", `/api/todos/${id}`, { status: "OK" });
  assert.equal(invalid.status, 400);

  assert.equal((await call("DELETE", `/api/todos/${id}`)).status, 200);
  assert.equal((await call("DELETE", `/api/todos/${id}`)).status, 404);
  assert.equal((await call("PUT", `/api/todos/${id}`, { status: "完成" })).status, 404);
});

test("日誌：新增、修改、時段驗證、刪除", async () => {
  const created = await call("POST", "/api/logs", {
    date: "2026-09-30", project: "機械手臂", content: "裝/烘模-F3、F4", start: "11:00", end: "11:20",
  });
  assert.equal(created.status, 201);
  const id = created.body.item.id;

  const reversed = await call("PUT", `/api/logs/${id}`, { start: "12:00", end: "11:00" });
  assert.equal(reversed.status, 400);
  assert.deepEqual(reversed.body.errors, ["結束時間不能早於開始時間"]);

  const edited = await call("PUT", `/api/logs/${id}`, { content: "裝/烘模-F3、F4（修正）", note: "明天換 G5" });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.item.content, "裝/烘模-F3、F4（修正）");
  assert.equal(edited.body.item.start, "11:00");

  const { body } = await call("GET", "/api/data");
  assert.ok(body.projects.includes("機械手臂"), "用過的專案要出現在專案清單");

  assert.equal((await call("DELETE", `/api/logs/${id}`)).status, 200);
  assert.equal((await call("DELETE", "/api/logs/abc")).status, 404);
});

test("連點送出：同時多個新增請求，id 不重複、一筆都不會掉", async () => {
  const before = (await call("GET", "/api/data")).body.logs.length;
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call("POST", "/api/logs", { date: "2026-09-30", project: "A", content: `第 ${i} 筆` })),
  );
  assert.ok(results.every((r) => r.status === 201));
  const { body } = await call("GET", "/api/data");
  assert.equal(body.logs.length, before + 10);
  assert.equal(new Set(body.logs.map((l) => l.id)).size, body.logs.length);
});

test("壞掉的 JSON 回傳 400 JSON 錯誤，不是 HTML", async () => {
  const res = await call("POST", "/api/logs", "{not json");
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.errors, ["請求內容不是合法的 JSON"]);
});

test("匯出 Excel 會在資料夾裡產生檔案", async () => {
  const { status, body } = await call("POST", "/api/export-xlsx");
  assert.equal(status, 200);
  assert.equal(path.basename(body.path), EXPORT_FILENAME);
  assert.ok(existsSync(path.join(dataDir, EXPORT_FILENAME)));
});
