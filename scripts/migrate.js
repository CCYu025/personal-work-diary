// 一次性搬遷：精簡版 Excel（待辦／日誌／選項）→ DATA_DIR/data.json
//
//   npm run migrate            data.json 已經存在就停下來，不覆蓋
//   npm run migrate -- --force 覆蓋既有的 data.json（會先備份成 data.backup-<時間>.json）
//
// 需要 .env 裡的 DATA_DIR 和 LEGACY_XLSX_PATH。

import { copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLegacyWorkbook } from "../backend/lib/xlsx.js";
import { dataFilePath, emptyStore, saveStore } from "../backend/lib/store.js";

export async function migrate({ xlsxPath, dataDir, force = false, log = console.log }) {
  if (!xlsxPath || !existsSync(xlsxPath)) throw new Error(`找不到 Excel：${xlsxPath}（檢查 .env 的 LEGACY_XLSX_PATH）`);
  if (!dataDir) throw new Error("沒有設定 DATA_DIR（檢查 .env）");

  const target = dataFilePath(dataDir);
  if (existsSync(target)) {
    if (!force) throw new Error(`${target} 已經存在。確定要用 Excel 重新覆蓋的話，加上 --force`);
    const backup = path.join(dataDir, `data.backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await copyFile(target, backup);
    log(`已備份原本的 data.json → ${backup}`);
  }

  const { projects, todos, logs, warnings } = await readLegacyWorkbook(xlsxPath);
  const store = { ...emptyStore(), projects, todos, logs };
  store.meta.migratedFrom = path.basename(xlsxPath);
  await saveStore(dataDir, store);

  log(`搬遷完成 → ${target}`);
  log(`  專案 ${projects.length} 個、待辦 ${todos.length} 筆、日誌 ${logs.length} 筆`);
  for (const w of warnings) log(`  注意：${w}`);
  return { projects, todos, logs, warnings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  migrate({
    xlsxPath: process.env.LEGACY_XLSX_PATH,
    dataDir: process.env.DATA_DIR,
    force: process.argv.includes("--force"),
  }).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
