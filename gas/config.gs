/**
 * config.gs
 * Phase6: 01_Settings から設定読み込み（モデル/閾値/固定費カテゴリ等）
 */

// デフォルト設定値
const DEFAULT_CONFIG = {
  MODEL_TEXT: "gpt-4o-mini",
  MODEL_IMAGE: "gpt-4o-mini",
  CONFIDENCE_THRESHOLD: 0.6,
  ABNORMAL_AMOUNT_THRESHOLD: 1000000,
  FIXED_COST_CATEGORIES: "住居,光熱費,通信,保険,サブスク",
  INCLUDE_UNCONFIRMED_IN_DASHBOARD: false,
  CURRENCY: "JPY",
  OPENAI_TIMEOUT_MS: 30000,
  OPENAI_MAX_RETRIES: 2,
  // Phase7: AI/OCRモード設定
  AI_ENABLED: false,      // OpenAI自動解析OFF（デフォルト）
  OCR_ENABLED: true,      // OCR処理ON（デフォルト）
  OCR_PROVIDER: "vision", // vision or drive
  VISION_API_KEY: ""      // Vision OCR用APIキー
};

// 設定キャッシュ（リクエスト内で再利用）
let configCache_ = null;

/**
 * 全設定を読み込み
 * @return {Object} 設定オブジェクト
 */
function loadConfig_() {
  if (configCache_) return configCache_;

  const config = Object.assign({}, DEFAULT_CONFIG);

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("01_Settings");
    if (!sheet) {
      configCache_ = config;
      return config;
    }

    const values = sheet.getDataRange().getValues();

    for (let r = 0; r < values.length; r++) {
      const key = String(values[r][0]).trim().toUpperCase();
      const val = values[r][1];

      if (!key || key === "KEY") continue; // ヘッダー行スキップ

      switch (key) {
        case "MODEL_TEXT":
        case "MODEL_IMAGE":
        case "CURRENCY":
          config[key] = String(val).trim() || DEFAULT_CONFIG[key];
          break;

        case "CONFIDENCE_THRESHOLD":
        case "ABNORMAL_AMOUNT_THRESHOLD":
        case "OPENAI_TIMEOUT_MS":
        case "OPENAI_MAX_RETRIES":
          const num = parseFloat(val);
          if (!isNaN(num)) config[key] = num;
          break;

        case "FIXED_COST_CATEGORIES":
          config[key] = String(val).trim() || DEFAULT_CONFIG[key];
          break;

        case "INCLUDE_UNCONFIRMED_IN_DASHBOARD":
          config[key] = String(val).toLowerCase() === "true";
          break;
      }
    }
  } catch (e) {
    console.warn("Config load failed, using defaults:", e);
  }

  configCache_ = config;
  return config;
}

/**
 * 設定値を取得（個別）
 */
function getConfig_(key) {
  const config = loadConfig_();
  return config[key] !== undefined ? config[key] : DEFAULT_CONFIG[key];
}

/**
 * テキスト用モデル取得
 */
function getModelText_() {
  return getConfig_("MODEL_TEXT");
}

/**
 * 画像用モデル取得
 */
function getModelImage_() {
  return getConfig_("MODEL_IMAGE");
}

/**
 * 信頼度閾値取得
 */
function getConfidenceThreshold_() {
  return getConfig_("CONFIDENCE_THRESHOLD");
}

/**
 * 異常金額閾値取得
 */
function getAbnormalAmountThreshold_() {
  return getConfig_("ABNORMAL_AMOUNT_THRESHOLD");
}

/**
 * 固定費カテゴリリスト取得
 * @return {string[]}
 */
function getFixedCostCategories_() {
  const val = getConfig_("FIXED_COST_CATEGORIES");
  if (!val) return ["住居", "光熱費", "通信", "保険", "サブスク"];
  return String(val).split(",").map(s => s.trim()).filter(s => s);
}

/**
 * ダッシュボードに未確定を含めるか
 */
function getIncludeUnconfirmedInDashboard_() {
  return getConfig_("INCLUDE_UNCONFIRMED_IN_DASHBOARD");
}

/**
 * OpenAIタイムアウト取得
 */
function getOpenAITimeout_() {
  return getConfig_("OPENAI_TIMEOUT_MS");
}

/**
 * OpenAI最大リトライ回数取得
 */
function getOpenAIMaxRetries_() {
  return getConfig_("OPENAI_MAX_RETRIES");
}

/**
 * 設定キャッシュをクリア（テスト用）
 */
function clearConfigCache_() {
  configCache_ = null;
}

/** ========== AI / Config helpers（統合パッチ） ========== */

/**
 * 01_Settings を Key-Value（A列=key, B列=value）として読む
 */
function getConfigKV_() {
  const out = {};
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("01_Settings");
  if (!sh) return out;

  const last = sh.getLastRow();
  if (last < 1) return out;

  const values = sh.getRange(1, 1, last, 2).getValues();
  values.forEach(([k, v]) => {
    const key = String(k || "").trim();
    if (!key) return;
    out[key] = v;
  });
  return out;
}

/**
 * OpenAI APIキーを取得（優先順位: Props > Settings KV > B26互換）
 * @return {string}
 */
function getOpenAiApiKey_() {
  // 1. Script Properties
  const props = PropertiesService.getScriptProperties();
  const pv = props.getProperty("OPENAI_API_KEY");
  if (pv) return pv;

  // 2. 01_Settings Key-Value
  const cfg = getConfigKV_();
  if (cfg.OPENAI_API_KEY) return String(cfg.OPENAI_API_KEY).trim();

  // 3. 互換：B26 を読む（暫定）
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName("01_Settings");
  if (sh) {
    const v26 = String(sh.getRange("B26").getValue() || "").trim();
    if (v26) return v26;
  }
  return "";
}

/**
 * OpenAIモデル名を取得
 * @return {string}
 */
function getOpenAiModel_() {
  const cfg = getConfigKV_();
  return cfg.OPENAI_MODEL || PropertiesService.getScriptProperties().getProperty("OPENAI_MODEL") || "gpt-4o-mini";
}

/** ========== Phase 7: AI/OCRモード設定 ========== */

/**
 * AIが有効かどうか（Props優先）
 * @return {boolean}
 */
function isAiEnabled_() {
  // 1. Script Properties
  const props = PropertiesService.getScriptProperties();
  const pv = props.getProperty("AI_ENABLED");
  if (pv !== null && pv !== undefined && pv !== "") {
    return String(pv).toLowerCase() === "true";
  }

  // 2. 01_Settings Key-Value
  const cfg = getConfigKV_();
  if (cfg.AI_ENABLED !== undefined) {
    return String(cfg.AI_ENABLED).toLowerCase() === "true";
  }

  // 3. loadConfig_ フォールバック
  const cfgLegacy = loadConfig_();
  return !!cfgLegacy.AI_ENABLED;
}

/**
 * OCRが有効かどうか
 * @return {boolean}
 */
function isOcrEnabled_() {
  const cfg = loadConfig_();
  return cfg.OCR_ENABLED !== false; // デフォルトtrue
}

/**
 * OCRプロバイダー取得
 * @return {string} "vision" or "drive"
 */
function getOcrProvider_() {
  const cfg = loadConfig_();
  return cfg.OCR_PROVIDER || "vision";
}

/**
 * Vision API Key取得
 * @return {string}
 */
function getVisionApiKey_() {
  const cfg = loadConfig_();
  if (cfg.VISION_API_KEY) return cfg.VISION_API_KEY;
  // Script Propertiesからも取得を試みる
  try {
    return PropertiesService.getScriptProperties().getProperty("VISION_API_KEY") || "";
  } catch (e) {
    return "";
  }
}

/**
 * OpenAI APIキーが設定されているか（エラーを投げずにチェック）
 * @return {boolean}
 */
function hasOpenAiApiKey_() {
  try {
    const key = PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY");
    return !!key && key.trim().length > 0;
  } catch (e) {
    return false;
  }
}

/**
 * 現在の処理モードを判定
 * @return {string} "ai" | "ocr" | "manual"
 */
function getProcessingMode_() {
  if (isAiEnabled_() && hasOpenAiApiKey_()) {
    return "ai";
  }
  if (isOcrEnabled_()) {
    return "ocr";
  }
  return "manual";
}

