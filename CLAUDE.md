# 個人工作日誌

## 專案概述

記錄待辦與每日工作的小工具。**單人使用、單機本地執行**，取代原本手填的精簡版 Excel
（「待辦」「日誌」「選項」三張表），但保留匯出成同樣格式 Excel 的能力。
資料格式見 [`backend/data/schema.md`](backend/data/schema.md)，改任何欄位前先讀那份。

架構刻意跟姊妹專案 [production-line-diary](https://github.com/CCYu025/production-line-diary)（產線日誌）
一致，兩個專案用同一套維護方式。

## 快速啟動

```bash
npm install
cp .env.example .env   # 改成實際的 DATA_DIR / LEGACY_XLSX_PATH
npm run migrate        # 只有第一次搬遷舊 Excel 時需要
npm start              # 或雙擊 start.bat，開在 http://localhost:3001
```

## 架構

| 層 | 技術 |
|---|---|
| 前端 | 純 HTML/CSS/JS，無框架：`frontend/index.html`（畫面）＋ `frontend/app.js`（邏輯） |
| 後端 | Node.js（ESM）+ Express，只聽 `127.0.0.1:3001` |
| 資料 | `DATA_DIR/data.json`，**不在這個 repo 裡** |
| 測試 | Node 內建 `node:test` |
| CI/CD | GitHub Actions：`ci.yml`（PR 檢查）、`release.yml`（tag → Release） |

## 關鍵檔案

| 檔案 | 職責 |
|---|---|
| `backend/lib/rules.js` | 欄位驗證、完成日規則、逾期判斷、排序、專案清單。**前後端共用**（前端 import `/lib/rules.js`） |
| `backend/lib/store.js` | `data.json` 讀寫；`createStoreQueue()` 把「讀→改→寫」排隊 |
| `backend/lib/xlsx.js` | 讀精簡版 Excel（搬遷）、寫匯出快照 |
| `backend/server.js` | REST API：`GET /api/data`、`/api/todos`、`/api/logs` 的 POST/PUT/DELETE、`POST /api/export-xlsx` |
| `frontend/app.js` | 三個畫面（今天／待辦／日誌）與編輯側欄 |
| `scripts/migrate.js` | 一次性搬遷；已有 `data.json` 時要 `--force` 才覆蓋，而且會先備份 |

## 核心不變量

這些是跟使用者討論後確認的決策，**改之前先重新評估，不要憑直覺改回「看起來更完整」的做法**：

- **這個 App 刻意很小**。使用者自己從 16 欄、有公式、有週摘要的「完整版」Excel 砍成
  7 欄的「精簡版」，因為完整版填起來太累。所以**不要加回**：任務 ID、進度%、工時、
  優先級、類型、需求來源、週摘要。也不做產線日誌那些東西：照片、圖表儀表板、日曆、
  列印報表、回收桶、帳號登入。要加任何一項，先問使用者、講清楚它省掉哪一個實際的手工步驟。
- **`data.json` 是唯一事實來源**，Excel 只是匯出快照，**不要做雙向同步**
  （Excel 開著時會鎖檔，產線日誌已經踩過這個坑）。匯出檔名是 `個人工作日誌_匯出.xlsx`，
  **故意跟搬遷來源 `個人工作日誌_精簡版.xlsx` 不同名**，絕對不能覆蓋使用者原本的 Excel。
- **匯出時 Excel 開著**會得到 `EBUSY`/`EPERM`，API 回 409 並提示「關掉之後再匯出」。
  寫入走「暫存檔 → rename」，失敗時舊檔案不會被寫壞一半。
- **`status` 是固定的 5 個值**（未開始／進行中／等待中／完成／取消）；
  **`project` 是開放清單**（`knownProjects()`：`data.json` 的 `projects` 預設順序 ＋ 實際用過的），
  不要改成寫死的 enum。
- **完成日規則**（`normalizeTodo`）：改成「完成」且沒填完成日 → 自動填今天；改成其他狀態 → 清空。
  搬遷時用 `fillDoneDate:false`，舊資料沒填就留 `null`，**不拿搬遷當天冒充完成日**。
- **逾期規則跟原本 Excel 的條件格式一模一樣**：有期限、期限早於今天、不是完成也不是取消。
  今天到期不算逾期。
- **日誌可以修改、刪除**。原本 Excel 的規則是「只新增不修改」，使用者 2026-09-30 決定
  在 App 裡開放修改（方便改錯字）。刪除要按兩次確認（不用 `confirm()`），沒有回收桶；
  資料夾在 OneDrive，有版本紀錄可以救。
- **時段（`start`/`end`）不拿來加總工時**。「機械手臂 08:00–17:00」這種整天待命的紀錄
  會跟其他工作重疊，加總沒有意義。
- **`rules.js` 不能 import 任何 `node:` 模組**，瀏覽器直接載入它。`test/frontend.test.js` 有鎖。
  前端需要的規則一律從這裡 import，**不要在 `app.js` 另寫一份**，不然畫面跟匯出的排序／逾期會對不起來。
  server 只開放 `/lib/rules.js` 這一支，其他後端程式不對外。
- **「今天」用本地時間**（`todayString()`），不要用 `toISOString().slice(0,10)`——
  那是 UTC，台灣早上 8 點前會變成昨天。
- **exceljs 的日期是 UTC 錨定的**：讀用 `getUTC*()`，寫用 `Date.UTC()`。`test/xlsx.test.js`
  開頭把 `TZ` 設成 `America/Los_Angeles` 才測得出來（UTC 的 CI runner 測不出），**不要拿掉那行**。
- **寫入要排隊**（`createStoreQueue`）。連按兩次 Enter 會同時送出兩個請求，不排隊的話
  兩個都讀到舊資料，後寫的會蓋掉先寫的。前端也有 `state.busy` 擋連按，兩層都要留。
- **`[hidden]{ display:none !important; }` 不能拿掉**，畫面切換全靠它。
- **只聽 `127.0.0.1`、沒有帳號**。除非使用者明確要求，不要加雲端部署、登入、多人協作。
- **repo 是公開的**：`backend/data/example/` 只能放虛構資料，測試資料也一樣。
  真實的 `data.json`、`.env` 絕不進版控。

## 測試

```bash
npm run check   # node --check
npm test        # node --test
```

手動驗證（改了畫面或 API 之後）：用一份**複製出來的** `data.json` 跑（`DATA_DIR` 指到暫存資料夾），
不要拿真實資料點來點去。確認：今天畫面新增一筆、勾完成再按復原、待辦新增一筆逾期的
（側邊選單出現紅色數字）、日誌搜尋、修改、刪除、匯出 Excel、瀏覽器 console 沒有錯誤。

## Git 工作流程

repo 公開在 GitHub（`CCYu025/personal-work-diary`）。`main` 有 branch protection：
只能透過 PR 合併、CI（Ubuntu + Windows 兩個 `test` job）綠燈才能合併、管理者也一樣
（`enforce_admins`），不需要 approve（單人維護）。

```bash
git checkout -b <類型>/<簡短描述>   # 例如 fix/export-locked-file
git push -u origin <分支名>
gh pr create --title "..." --body "..."
gh pr checks --watch
gh pr merge --squash --delete-branch
```

發行：PR 改 `package.json` 的 `version` → 合併 → 在 `main` 打 `v<版本>` tag 並 push →
`release.yml` 驗證版本一致、跑測試、打包 zip、建立 GitHub Release。

## Claude Code 執行原則

使用者確認方向後直接做，不用每一步都問。只在這些情況先停下來確認：

- 會覆蓋或刪除 `DATA_DIR` 裡的真實資料（`data.json`、使用者的 Excel）
- `git push` 到遠端、建立或修改 GitHub repo 設定、打 release tag
- 修改範圍明顯超出討論內容，或要改上面任何一條核心不變量
