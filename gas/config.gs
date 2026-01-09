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
  OPENAI_MAX_RETRIES: 2
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
