# 分鏡九宮格裁切工具

把「九宮格式分鏡截圖」自動裁切成獨立圖檔 + OCR 文字檔。

## 網頁版（給一般使用者，推薦）

純前端網頁，開啟後在瀏覽器內完成所有處理（偵測、裁切、OCR），不會把圖片上傳到任何伺服器。

**開啟方式：**
1. 在此 repo 的 GitHub 設定中啟用 GitHub Pages（Settings → Pages → Source 選擇要部署的分支與根目錄 `/`）
2. 啟用後即可用瀏覽器打開對應的 `https://<你的帳號>.github.io/<repo>/` 網址使用
3. 或者直接把 `index.html`、`app.js`、`style.css` 下載到本機，用瀏覽器打開 `index.html` 也可以離線測試（OCR 語言包仍需連網下載一次）

**使用流程：**
1. 上傳多張 PNG 分鏡截圖（可拖曳調整處理順序）
2. 按「執行偵測 / 預覽」，檢查每張圖被標註的紅框（畫面截圖）、藍框（說明文字）是否準確、編號是否正確
3. 若有偏差，展開「偵測參數」微調後重新偵測
4. 確認無誤後按「裁切 + OCR + 打包下載 ZIP」，稍待處理完成即會自動下載一個 zip 檔，內含各來源圖片各自的資料夾，每格一組 `.png` + `.txt`

## 命令列版（給需要批次/自動化處理的使用者）

`storyboard_cutter.py`：Python 腳本，邏輯與網頁版相同，適合大量圖片或想寫進自動化流程的情境。

```bash
pip install numpy pillow pytesseract
# 另需安裝 Tesseract OCR 執行檔本體（含繁體中文語言包）

python3 storyboard_cutter.py --preview --input input --preview-dir preview
# 檢查 preview/ 內的標註圖沒問題後：
python3 storyboard_cutter.py --export --input input --output-dir output --lang chi_tra+eng
```
