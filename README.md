# 個人工作日誌

[![CI](https://github.com/CCYu025/personal-work-diary/actions/workflows/ci.yml/badge.svg)](https://github.com/CCYu025/personal-work-diary/actions/workflows/ci.yml)

記錄「要做什麼」（待辦）和「今天做了什麼」（日誌）的小工具。單人使用、單機本地執行，
不需要雲端、不需要帳號。

**接手這個專案（人或 AI）先讀 [`CLAUDE.md`](CLAUDE.md)**（[`AGENTS.md`](AGENTS.md) 內容相同）。
資料格式見 [`backend/data/schema.md`](backend/data/schema.md)，那份是資料契約：
就算 App 停用或重寫，只要那份文件和 `data.json` 還在，資料就讀得懂。

## 這是什麼

原本用一份精簡版 Excel（「待辦」「日誌」「選項」三張表）記錄，這個 App 把同樣的欄位做成三個畫面：

| 畫面 | 做什麼 |
|---|---|
| **今天** | 快速記一筆（點專案 → 打內容 → Enter），旁邊列出還沒完成的待辦，可以直接勾完成（能復原），或按「記一筆」用待辦內容開頭 |
| **待辦** | 依「未完成／已結束／全部」和專案篩選；逾期標紅、等待中標黃、完成／取消變灰（跟原本 Excel 的條件格式同一套規則）；改成完成會自動填完成日 |
| **日誌** | 依日期分組，可以搜尋，點一下可以修改或刪除 |

另外可以「匯出 Excel」，欄位跟原本的精簡版一樣，方便給還沒用這個 App 的人看。

刻意**沒有**的東西（以及理由）列在 `CLAUDE.md`：任務 ID、進度%、工時、優先級、圖表、照片、帳號……

## 快速開始

需要 Node.js 22.9 以上。

```bash
npm install
cp .env.example .env   # 改成你自己的 DATA_DIR / LEGACY_XLSX_PATH
npm run migrate        # 只有第一次從舊 Excel 搬資料時需要
npm start              # 或雙擊 start.bat
```

啟動後自動開瀏覽器到 `http://localhost:3001`。沒有 `.env` 時會用
`backend/data/example/` 的虛構範例資料開機，可以先看看畫面。

也可以到 [Releases](https://github.com/CCYu025/personal-work-diary/releases) 下載打包好的 zip，
解壓縮後照上面的步驟設定 `.env`，雙擊 `start.bat`。

## 專案結構

```
backend/
  server.js         Express：靜態檔案 + REST API，只聽 127.0.0.1
  lib/
    rules.js         欄位規則（純函式）：驗證、逾期判斷、排序。前後端共用
    store.js         data.json 讀寫（原子寫入、寫入排隊）
    xlsx.js          讀舊 Excel（搬遷用）、寫匯出快照
  data/
    schema.md        資料契約
    example/         虛構的範例資料
frontend/
  index.html         畫面與樣式
  app.js             前端邏輯，import /lib/rules.js
scripts/
  migrate.js         一次性搬遷：精簡版 Excel → data.json
test/                node:test
.github/workflows/
  ci.yml             PR / push main：語法檢查 + 測試（Ubuntu + Windows）
  release.yml        推 v* tag：測試 → 打包 zip → GitHub Release
```

## 測試

```bash
npm run check   # node --check 語法檢查
npm test        # node --test
```

測試涵蓋欄位規則、data.json 讀寫與寫入排隊、Excel 搬遷與匯出（刻意在非 UTC 時區跑）、
完整的 API 流程，以及前端跟 `rules.js`／`index.html` 對不對得上。

## 開發流程

`main` 有 branch protection：只能透過 PR 合併，CI 綠燈才能合併。

```bash
git checkout -b feat/簡短描述
# ...改動、commit...
git push -u origin feat/簡短描述
gh pr create --fill
gh pr checks --watch
gh pr merge --squash --delete-branch
```

發行新版本：用 PR 把 `package.json` 的 `version` 改掉，合併後在 `main` 上打 tag：

```bash
git checkout main && git pull
git tag v0.1.1 && git push origin v0.1.1
```

`release.yml` 會檢查 tag 跟 `package.json` 版本一致，跑完測試後自動建立 Release。

## 資料在哪裡

真實資料**不在**這個 repo 裡：`data.json` 和匯出的 Excel 都在 `.env` 的 `DATA_DIR`
（自己電腦上的 OneDrive 資料夾），只有程式碼進版控。
