/**
 * Spreadsheet accessor (WebApp safe)
 * - スタンドアロンWebアプリでも確実に動くように openById を標準化
 * - getActiveSpreadsheet() はWebアプリ実行時に失敗するため禁止
 */

/**
 * スプレッドシートIDを取得
 * 優先順位: Script Properties > 01_Settings KV > コンテナバインド（フォールバック）
 */
function getSpreadsheetId_() {
  // 1) Script Properties（最優先・推奨）
  const props = PropertiesService.getScriptProperties();
  const id1 = props.getProperty("SPREADSHEET_ID");
  if (id1) return id1.trim();

  // 2) 01_Settings key-value（次点）
  // 注意: getConfigKV_ は config.gs で定義されている
  try {
    const cfg = typeof getConfigKV_ === "function" ? getConfigKV_() : {};
    if (cfg.SPREADSHEET_ID) return String(cfg.SPREADSHEET_ID).trim();
  } catch (_) {
    // getConfigKV_ が未定義またはエラーの場合は無視
  }

  // 3) フォールバック：コンテナバインドならOK（standaloneだと失敗し得る）
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) return ss.getId();
  } catch (_) {}

  throw new Error("SPREADSHEET_ID is missing. Set it in Script Properties or 01_Settings.");
}

/**
 * スプレッドシートを取得（openById使用・WebApp安全）
 */
function getSs_() {
  const id = getSpreadsheetId_();
  return SpreadsheetApp.openById(id);
}

/**
 * 指定シートを取得（WebApp安全）
 * @param {string} name - シート名
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet_(name) {
  const ss = getSs_();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Sheet not found: ${name}`);
  return sh;
}

/**
 * 指定シートを取得（存在しなくてもnullを返す・エラーにしない）
 * @param {string} name - シート名
 * @returns {GoogleAppsScript.Spreadsheet.Sheet|null}
 */
function getSheetOrNull_(name) {
  try {
    const ss = getSs_();
    return ss.getSheetByName(name);
  } catch (_) {
    return null;
  }
}

/**
 * 初回セットアップ用: SPREADSHEET_IDをScript Propertiesにセット
 * Apps Scriptエディタで1回だけ実行してください
 */
function setupSpreadsheetIdOnce_() {
  const SPREADSHEET_ID = "1a2rTbAwIBYfH0CstleN15VvUwk4AyisJJ3QFyok8uWY";

  PropertiesService.getScriptProperties().setProperty("SPREADSHEET_ID", SPREADSHEET_ID);
  console.log("SPREADSHEET_ID set successfully: " + SPREADSHEET_ID);
}

/**
 * 現在のSPREADSHEET_ID設定を確認（デバッグ用）
 */
function debugSpreadsheetId_() {
  try {
    const id = getSpreadsheetId_();
    console.log("SPREADSHEET_ID: " + id);
    const ss = getSs_();
    console.log("Spreadsheet name: " + ss.getName());
    return { ok: true, id: id, name: ss.getName() };
  } catch (e) {
    console.log("Error: " + e.message);
    return { ok: false, error: e.message };
  }
}
