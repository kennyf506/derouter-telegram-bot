# DeRouter Telegram Bot

用 Telegram 監控 [DeRouter](https://derouter.network) 收益、查詢額度，並自動／手動調整各帳號的派工速度與啟停狀態。

一個人跑多個帳號時，最麻煩的是：不知道今天賺多少、額度快用完沒感覺、想調速度得開後台。這支 bot 把這三件事都搬進 Telegram，並且能依時間相位與當日收益自動調速。

## 功能

**收益推播（`derouter.js`）**
- 每 5 分鐘輪詢一次收益，當日收益每跨過一個門檻（預設每 $1）就推播
- 每天早上（預設台北 08:00，即 UTC 換日時刻）送出前一日損益報告：昨日收益、昨日損益、本期回本進度條、月底推估
- 當日收益跨過設定的達標門檻（例如 $7 / $14）時提醒，並附「平均達標時間」與「比平均早／晚多久」
- `/derouter`（或 `/earn`、`/收益`）即時查詢今日／本週／累計收益
- 同時顯示預期月收益、月淨利及收益率：（預期月收益－月成本）÷月成本。以近 7 個 UTC 日期內已記錄的完整收益日日均推估本期天數；無完整日紀錄時，UTC 當日已過至少 1 小時則按當日收益速度推估。缺少日期不當成零收益，跨多日回補資料不納入日均；月成本不完整時不計算收益率

**帳號控制（`dispatch.js`）**
- `/speed` 開互動選單：列出所有帳號的狀態與目前速度，點選即可改速度或啟動／暫停
- `/speed <email開頭或代號> <mode>` 快速直接套用
- `/quota` 分別列出 Codex、Claude 各帳號的 5 小時／週剩餘額度與重置時間，Team 顯示 Standard／Premium 席位等級
- 每組依週額度重置時間由近到遠排序，無重置資料放最後；⏰ 表示 24 小時內週重置、🔴 用罄、🟠 剩餘 ≤5%、🧊 剩餘 ≥80%（用得少）。週剩餘 ≤5% 時只顯示週額度與週重置，省略 5 小時資訊
- `/quota` 依目前帳號清單自動計算月成本，列出各方案的數量 × 美區月繳單價與總計；每日損益報告使用同一套成本計算
- 自動排程：日間相位切到 `dayMode`、夜間相位切到 `nightMode`；當日收益達門檻可再降速

所有指令只有 `DEROUTER_CHAT_ID` 指定的 Telegram user ID 能用，其他人一律忽略。

## 安裝

需要 Node.js 18 以上。

```bash
git clone https://github.com/kennyf506/derouter-telegram-bot.git
cd derouter-telegram-bot
npm install
cp .env.example .env
# 編輯 .env 填入 token、management key、chat id
npm start
```

用 [PM2](https://pm2.keymetrics.io/) 常駐：

```bash
pm2 start index.js --name derouter-bot
pm2 save
```

使用 RackNerd 等 Linux VPS 時，可依 [systemd 部署說明](deploy/README.md) 安裝常駐服務，並搬移現有收益日誌與鏈上快取。

## 設定

完整說明見 [`.env.example`](.env.example)，以下是必填三項：

| 變數 | 說明 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | 向 [@BotFather](https://t.me/BotFather) 申請的 bot token |
| `DEROUTER_MGMT_KEY` | DeRouter 後台取得的 management key，須具備 `usage` 及帳號管理權限 |
| `DEROUTER_CHAT_ID` | 你的 Telegram user ID（向 [@userinfobot](https://t.me/userinfobot) 查詢），也是唯一有權使用指令的人 |

### 收益查詢回傳 403

若 API 回覆 `Manager key lacks scope: usage`（`scope_denied`），代表目前金鑰缺少收益讀取權限。請在 DeRouter 後台為金鑰啟用 `usage`；若需建立新金鑰，保留現有帳號管理權限，更新 `.env` 的 `DEROUTER_MGMT_KEY` 後重啟 bot。帳號清單與 `/quota` 能讀取，不代表金鑰有收益讀取權限。

### 切換收益來源與鏈上備援

`/derouter auto`（預設）優先讀取收益 API，API 請求失敗時改查 Solana；`/derouter api` 固定使用 API；`/derouter chain` 固定使用鏈上統計。選擇會保存在狀態檔，之後直接 `/derouter` 沿用。`/earn`、`/收益` 也支援這些參數。來源切換只影響指令查詢，排程推播與自動調速仍使用 API。

鏈上統計使用 `finalized` 交易，只加總 DeRouter settlement 程式的 Settle 指令內，轉入指定錢包 USDC 帳戶的款項，排除充值與一般轉帳。首次由帳號清單探索接收錢包，之後快取於 `chain_state.json`；也可先填入 `DEROUTER_WALLET`，使 DeRouter API 全部不可達時仍可查鏈。RPC URL 可由 `DEROUTER_SOLANA_RPC_URL` 設定；無須錢包私鑰。

啟動時自動在背景同步，每 30 秒處理一輪；每輪預設 10 筆，可用 `DEROUTER_CHAIN_MAX_TRANSACTIONS` 調整（1–100）。RPC 請求至少間隔 500 毫秒，失敗時自動退避至最長 5 分鐘。新交易增量查詢與歷史分頁游標、待處理佇列、逐筆結算結果都持久化至 `chain_state.json`，重啟後繼續；交替處理新舊交易並輪流補齊各 USDC 帳戶。快取採暫存檔加原子更名，`chain_state.json` 與 `.tmp` 都列入 `.gitignore`。

指令直接回覆本機快取，顯示更新時間與同步進度；第一次尚無快取時顯示背景同步中。所有已掃描交易持續累積且依簽章去重。結果標示掃描範圍，未覆蓋完整 UTC 日／週時標示「部分」；週從 UTC 週一開始。不把未掃完的合計稱作累計收益，也不還原 task 數。鏈上只反映已結算 USDC，會與 API 未結算收益不同；不寫入 API 收益日誌、不用 API 歷史推估鏈上收益率。

### 月成本

不再使用 `DEROUTER_MONTHLY_COST`。每次查詢以目前掛載的帳號數量乘上美區月繳牌價（未稅、不含額外用量與優惠），暫停、封鎖、過期帳號仍列入；相同平台與 email 跨容器重複掛載只計一次。這是目前帳號組合的牌價估算，不是實際帳單，也不追溯本期內帳號異動的分攤費用。

價格核對日期：2026-10-21，集中維護於 `costs.js`，數量即時取得；牌價有變更時需更新價格表。

| 方案 | 每帳號／月（USD） |
| --- | ---: |
| Claude Team Standard | 25 |
| Claude Team Premium | 125 |
| Claude Pro | 20 |
| Claude Max 5x／20x | 100／200 |
| ChatGPT Plus（Codex） | 20 |
| ChatGPT Go | 8 |
| ChatGPT K12 | 0（免費至 2028/06） |

來源：[Claude](https://claude.com/pricing)、[OpenAI Docs](https://learn.chatgpt.com/docs/pricing)、[K12 免費方案](https://help.openai.com/en/articles/12844995)。無法辨識的方案／Team 席位，或只有 `pro` 而無法確認價位的 ChatGPT 帳號，顯示未計價與已知小計；有未計價項目時每日報告不計算損益與回本百分比，避免把小計當成完整成本。

### 自動調速

`DISPATCH_ACCOUNTS` 是一段 JSON 陣列，描述每個帳號在日／夜相位要切到哪個模式：

```json
[
  {
    "alias": "main",
    "email": "you@example.com",
    "dayMode": "speed_5x",
    "nightMode": "normal",
    "thresholdUsd": 14,
    "thresholdMode": "speed_2x"
  },
  {
    "alias": "sub",
    "email": "sub@example.com",
    "dayMode": "speed_2x",
    "nightMode": "normal"
  }
]
```

上面這組的行為是：台北 08:00 起 `main` 衝 5x、`sub` 跑 2x；`main` 當日收益達 $14 就降到 2x 保額度；台北 00:00 起兩個都回 `normal` 休息。留空 `DISPATCH_ACCOUNTS` 就完全不自動調速，只保留手動指令。

可用模式：`humanlike`、`normal`、`speed_2x`、`speed_3x`、`speed_5x`。

幾個設計上的取捨：

- **用 email 而不是 accountId 指定帳號**。帳號移除再加入時 accountId 會變，email 不會，所以每次動作都即時用 email 查出當下的 ID。
- **每個相位每天只執行一次**，用台北日期當旗標寫進狀態檔，重啟不會重複推播；啟動時會依當下時間自動補到正確相位。
- **門檻降速只在帳號仍停在 `dayMode` 時才動**，你手動調過就不會被蓋掉。
- **收益日以 UTC 換日**（台北早上 8 點歸零），與 DeRouter API 的 `today` 欄位一致，所以預設的相位切換點也定在台北 08:00。

## 時區

程式內固定以 `Asia/Taipei` 呈現時間。若要改成其他時區，修改 `derouter.js` 與 `dispatch.js` 開頭的 `TZ` 常數即可，但請注意「收益日」本身是 UTC 換日，與顯示時區無關。

## 狀態檔

執行時會在專案目錄產生 `derouter_state.json` 與 `dispatch_state.json`，記錄已推播過的門檻、昨日收益基準、各相位最後執行日期等，避免重啟後重複發訊息。兩個檔案都已列入 `.gitignore`。

## 免責

這是個人自用工具整理後開源，與 DeRouter 官方無關。API 端點與欄位若有變動可能需要調整。使用前請自行確認符合平台的服務條款。

## License

MIT
