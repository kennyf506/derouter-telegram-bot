# RackNerd 1GB 部署

主機選 Ubuntu 24.04 LTS 或 Debian 12/13，安裝系統層級的 Node.js 24 LTS、npm、Git；Node 執行檔需在 `/usr/bin/node` 或 `/usr/local/bin/node`。這是向 Telegram 發出 polling 的背景程式，不需要網域、反向代理或對外 HTTP port。

## 1. 放置程式與資料

在 VPS 將程式放到固定目錄：

```bash
sudo git clone --branch codex/quota-cost-return-estimates https://github.com/allen91228/derouter-telegram-bot.git /opt/derouter-telegram-bot
```

上述分支包含尚在 PR 的部署修改；PR 合併後可改用上游 `main`。

切換前先停止本機 bot，避免同一 token 兩個 polling 程序互相搶訊息，並確保背景快取已停止寫入。由本機透過 SSH/SCP 複製以下現存檔案到 VPS 的同一專案目錄：

- `.env`
- `derouter_state.json`
- `dispatch_state.json`
- `derouter_daily.jsonl`
- `chain_state.json`

狀態與快取檔可不存在；已存在時應一併搬移，以保留通知紀錄及掃鏈進度。不要複製 `node_modules`、`.git` 或 `chain_state.json.tmp`，也不要把環境變數或快取提交進 Git。

## 2. 安裝常駐服務

確認本機 bot 已停止後，在 VPS 執行：

```bash
sudo bash /opt/derouter-telegram-bot/deploy/install-systemd.sh
```

安裝腳本會建立獨立的 `derouter` 系統帳號、安裝鎖定版依賴、執行測試、設定 `.env` 權限，並啟用開機自動啟動與錯誤重啟。Node 的 JavaScript heap 上限設為 384MB，保留系統與其他 Node 記憶體使用空間；此設定不是程序總記憶體上限。

程式、收益日誌、快取與工作佇列都位於 VPS 的持久磁碟 `/opt/derouter-telegram-bot`；服務重啟與系統重開不會清除。仍應定期備份這些資料。

## 3. 驗證與日常操作

```bash
sudo systemctl status derouter-bot --no-pager
sudo journalctl -u derouter-bot -n 50 --no-pager
sudo systemctl restart derouter-bot
```

在 Telegram 測試 `/quota` 與 `/derouter chain`，確認帳號資料、快取時間與背景同步進度。更新程式時，先停止服務，再更新程式及依賴，最後啟動；保留 `.env`、所有 `*_state.json` 與收益日誌。

若 VPS 驗證未通過，可先停止 VPS 服務，再啟動本機 bot；同一時間只讓一邊 polling。VPS 運行後產生的新狀態需在回切前一併搬回。
