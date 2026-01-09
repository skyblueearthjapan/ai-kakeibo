/**
 * logging.gs
 * Phase6: 09_Logs へのログ書き込み・メトリクス
 */

/**
 * ログエントリを09_Logsに追記
 * @param {Object} entry ログエントリ
 */
function writeLog_(entry) {
  try {
    const sheet = getOrCreateLogSheet_();

    const row = [
      entry.timestamp || new Date().toISOString(),
      entry.trace_id || "",
      entry.operation || "",
      entry.status || "ok",
      entry.error_code || "",
      entry.message || "",
      entry.duration_ms || 0,
      entry.user_agent || "",
      entry.input_size || 0,
      entry.openai_model || "",
      entry.openai_tokens_in || 0,
      entry.openai_tokens_out || 0,
      entry.openai_cost_est || 0,
      entry.app_version || getAppVersion_(),
      entry.txn_id || "",
      entry.receipt_file_id || ""
    ];

    sheet.appendRow(row);
  } catch (e) {
    // ログ書き込み失敗は握りつぶす（本体処理を止めない）
    console.error("Log write failed:", e);
  }
}

/**
 * 成功ログを記録
 */
function logSuccess_(traceId, operation, durationMs, extra) {
  extra = extra || {};
  writeLog_({
    trace_id: traceId,
    operation: operation,
    status: "ok",
    duration_ms: durationMs,
    openai_model: extra.model || "",
    openai_tokens_in: extra.tokens_in || 0,
    openai_tokens_out: extra.tokens_out || 0,
    openai_cost_est: extra.cost_est || 0,
    input_size: extra.input_size || 0,
    txn_id: extra.txn_id || "",
    receipt_file_id: extra.receipt_file_id || ""
  });
}

/**
 * エラーログを記録
 */
function logError_(traceId, operation, durationMs, errorCode, message, extra) {
  extra = extra || {};
  writeLog_({
    trace_id: traceId,
    operation: operation,
    status: "error",
    error_code: errorCode,
    message: truncateMessage_(message, 500),
    duration_ms: durationMs,
    openai_model: extra.model || "",
    input_size: extra.input_size || 0
  });
}

/**
 * OpenAI呼び出しログ（成功/失敗問わず）
 */
function logOpenAICall_(traceId, operation, model, tokensIn, tokensOut, durationMs, success, errorMsg) {
  writeLog_({
    trace_id: traceId,
    operation: operation + "_openai",
    status: success ? "ok" : "error",
    error_code: success ? "" : "E_OPENAI_CALL",
    message: success ? "" : truncateMessage_(errorMsg, 500),
    duration_ms: durationMs,
    openai_model: model,
    openai_tokens_in: tokensIn,
    openai_tokens_out: tokensOut,
    openai_cost_est: estimateCost_(model, tokensIn, tokensOut)
  });
}

/**
 * 09_Logsシートを取得（なければ作成）
 */
function getOrCreateLogSheet_() {
  // getSs_ を使用（openById経由・WebApp安全）
  const ss = getSs_();
  let sheet = ss.getSheetByName("09_Logs");

  if (!sheet) {
    sheet = ss.insertSheet("09_Logs");
    // ヘッダー追加
    const headers = [
      "timestamp", "trace_id", "operation", "status", "error_code", "message",
      "duration_ms", "user_agent", "input_size", "openai_model",
      "openai_tokens_in", "openai_tokens_out", "openai_cost_est",
      "app_version", "txn_id", "receipt_file_id"
    ];
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * メッセージを指定文字数で切り詰め
 */
function truncateMessage_(msg, maxLen) {
  if (!msg) return "";
  const s = String(msg);
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen) + "...";
}

/**
 * OpenAIコスト概算（USD）
 * gpt-4o-mini: input $0.15/1M, output $0.60/1M
 * gpt-4o: input $2.50/1M, output $10.00/1M
 */
function estimateCost_(model, tokensIn, tokensOut) {
  if (!model || (!tokensIn && !tokensOut)) return 0;

  let inRate = 0.00015;  // per 1K tokens
  let outRate = 0.0006;

  if (model.includes("gpt-4o") && !model.includes("mini")) {
    inRate = 0.0025;
    outRate = 0.01;
  }

  const cost = (tokensIn / 1000) * inRate + (tokensOut / 1000) * outRate;
  return Math.round(cost * 1000000) / 1000000; // 6桁精度
}

/**
 * アプリバージョン取得
 */
function getAppVersion_() {
  return "0.6"; // Phase6
}

/**
 * シンプルなログ追記（スプレッドシートに書かず console.log のみ）
 * @param {string} level ログレベル（INFO, ERROR, WARN）
 * @param {string} message メッセージ
 * @param {string} traceId トレースID
 */
function appendLog_(level, message, traceId) {
  // スプレッドシートへの書き込みは権限エラーの原因になるため、console.logのみ使用
  console.log(`[${level}] trace=${traceId} ${message}`);
}

/**
 * 運用サマリー取得（直近N日）
 * @param {number} days 日数（デフォルト7）
 * @return {Object} サマリー
 */
function getOpsSummary(days) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    days = days || 7;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    // getSheetOrNull_ を使用（openById経由・WebApp安全）
    const sheet = getSheetOrNull_("09_Logs");
    if (!sheet) {
      return {
        ok: true,
        result: {
          days: days,
          total_calls: 0,
          errors: 0,
          error_rate_pct: 0,
          openai_calls: 0,
          openai_errors: 0,
          openai_error_rate_pct: 0,
          avg_duration_ms: 0,
          total_cost_est: 0,
          meta: { duration_ms: Date.now() - started }
        }
      };
    }

    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) {
      return {
        ok: true,
        result: {
          days: days,
          total_calls: 0,
          errors: 0,
          error_rate_pct: 0,
          openai_calls: 0,
          openai_errors: 0,
          openai_error_rate_pct: 0,
          avg_duration_ms: 0,
          total_cost_est: 0,
          meta: { duration_ms: Date.now() - started }
        }
      };
    }

    let totalCalls = 0;
    let errors = 0;
    let openaiCalls = 0;
    let openaiErrors = 0;
    let totalDuration = 0;
    let totalCost = 0;

    for (let r = 1; r < values.length; r++) {
      const timestamp = new Date(values[r][0]);
      if (timestamp < cutoff) continue;

      totalCalls++;
      const status = values[r][3];
      const operation = values[r][2];
      const duration = Number(values[r][6]) || 0;
      const cost = Number(values[r][12]) || 0;

      if (status === "error") errors++;
      if (String(operation).includes("_openai")) {
        openaiCalls++;
        if (status === "error") openaiErrors++;
      }

      totalDuration += duration;
      totalCost += cost;
    }

    return {
      ok: true,
      result: {
        days: days,
        total_calls: totalCalls,
        errors: errors,
        error_rate_pct: totalCalls > 0 ? Math.round((errors / totalCalls) * 1000) / 10 : 0,
        openai_calls: openaiCalls,
        openai_errors: openaiErrors,
        openai_error_rate_pct: openaiCalls > 0 ? Math.round((openaiErrors / openaiCalls) * 1000) / 10 : 0,
        avg_duration_ms: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
        total_cost_est: Math.round(totalCost * 1000000) / 1000000,
        meta: { duration_ms: Date.now() - started }
      }
    };

  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}
