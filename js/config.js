/* ============================================================================
   SEVENS × KURO 訂貨系統 — config.js   v2.0.0
   ----------------------------------------------------------------------------
   檔案結構 FILE MAP:
     index.html     畫面骨架 (markup only)
     css/style.css  全部樣式
     js/config.js   設定：版本、Google Sheet 連結、逾時  ← 唯一會改的檔案
     js/data.js     內置後備資料（由 Sheet 匯出生成，平常不用碰）
     js/app.js      全部程式邏輯
   部署 DEPLOY: 整個資料夾原樣上傳 Netlify / 任何靜態主機；本機用瀏覽器
   直接開 index.html 亦可（自動用內置資料，無法即時讀 Sheet 時有完整後備）。
   ============================================================================ */
const VERSION = '2.0.0';
const SHEET_ITEMS_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTtAv-KDbvjwvkzPDk8U-38gRmbuLtCWP-XOgo2Y-ZiinzvM2jqyFr-D_wMmXnLyixLBGMBtTdyb_Z3/pub?gid=590460620&single=true&output=csv';
const SHEET_SUPPLIERS_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTtAv-KDbvjwvkzPDk8U-38gRmbuLtCWP-XOgo2Y-ZiinzvM2jqyFr-D_wMmXnLyixLBGMBtTdyb_Z3/pub?gid=761155397&single=true&output=csv';
const SHEET_FETCH_TIMEOUT = 9000;   // ms; 逾時即轉用後備資料
