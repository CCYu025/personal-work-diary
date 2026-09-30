import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStoreQueue, emptyStore, loadStore, saveStore } from "../backend/lib/store.js";

const tmpDir = () => mkdtempSync(path.join(os.tmpdir(), "pwd-store-"));

test("沒有 data.json 時回傳空資料，不丟例外", async () => {
  const dir = tmpDir();
  const store = await loadStore(dir);
  assert.deepEqual(store.todos, []);
  assert.deepEqual(store.logs, []);
  assert.deepEqual(store.projects, []);
  rmSync(dir, { recursive: true, force: true });
});

test("存了再讀回來內容一樣，而且不留暫存檔", async () => {
  const dir = tmpDir();
  const store = emptyStore();
  store.projects = ["MES"];
  store.todos.push({ id: 1, content: "x" });
  store.logs.push({ id: 1, content: "y" });
  await saveStore(dir, store);

  const loaded = await loadStore(dir);
  assert.deepEqual(loaded.projects, ["MES"]);
  assert.deepEqual(loaded.todos, [{ id: 1, content: "x" }]);
  assert.deepEqual(loaded.logs, [{ id: 1, content: "y" }]);
  assert.deepEqual(readdirSync(dir), ["data.json"]);
  rmSync(dir, { recursive: true, force: true });
});

test("舊檔案缺欄位時補成空陣列", async () => {
  const dir = tmpDir();
  writeFileSync(path.join(dir, "data.json"), JSON.stringify({ _meta: { schemaVersion: "0.9" }, todos: [{ id: 1 }] }));
  const store = await loadStore(dir);
  assert.deepEqual(store.todos, [{ id: 1 }]);
  assert.deepEqual(store.logs, []);
  assert.deepEqual(store.projects, []);
  rmSync(dir, { recursive: true, force: true });
});

test("createStoreQueue：同時送出的寫入一個一個來，不會互相蓋掉", async () => {
  const dir = tmpDir();
  const withStore = createStoreQueue(dir);
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      withStore((store) => {
        store.logs.push({ id: store.logs.length + 1, content: `第 ${i} 筆` });
      }),
    ),
  );
  const store = await loadStore(dir);
  assert.equal(store.logs.length, 20);
  assert.equal(new Set(store.logs.map((l) => l.id)).size, 20);
  rmSync(dir, { recursive: true, force: true });
});

test("createStoreQueue：fn 回傳 false 不存檔；丟錯不會卡住後面的寫入", async () => {
  const dir = tmpDir();
  const withStore = createStoreQueue(dir);
  const r = await withStore((store) => {
    store.logs.push({ id: 1 });
    return false;
  });
  assert.equal(r, false);
  assert.deepEqual((await loadStore(dir)).logs, []);

  await assert.rejects(withStore(() => { throw new Error("boom"); }), /boom/);
  await withStore((store) => { store.logs.push({ id: 2 }); });
  assert.deepEqual((await loadStore(dir)).logs, [{ id: 2 }]);
  rmSync(dir, { recursive: true, force: true });
});
