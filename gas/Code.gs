/**
 * 家計簿チャットボット - メインエントリーポイント
 * Phase 1+2: テキスト入力 + レシート撮影
 */

function doGet() {
  return HtmlService.createTemplateFromFile("ui_index")
    .evaluate()
    .setTitle("家計簿受付")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** HTMLからCSS/JSを読み込むため */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * UI -> GAS: テキスト入力を処理
 * @param {string} text
 * @param {Object=} clientContext
 * @return {Object} TransactionResult
 */
function processText(text, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!text || String(text).trim() === "") {
      throw makeAppError_("E_BAD_REQUEST", "Text is empty", traceId, false, "入力が空です。金額や店名を入力してください。");
    }

    const ai = withOpenAIRetry_(() => callOpenAI_TextToTransaction_(String(text), clientContext, traceId), traceId);

    const mapped = mapAiToRow_(ai, {
      source: "text",
      rawText: String(text),
      receiptFileId: ""
    });

    const appendedId = appendTransactionRow_(mapped, traceId);

    return makeOkResult_(mapped, appendedId, started);
  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * UI -> GAS: レシート画像を処理
 * @param {string} dataUrl e.g. data:image/jpeg;base64,....
 * @param {Object=} clientContext
 * @return {Object} TransactionResult
 */
function processReceipt(dataUrl, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!dataUrl || String(dataUrl).trim() === "") {
      throw makeAppError_("E_BAD_REQUEST", "dataUrl is empty", traceId, false, "画像が見つかりません。もう一度撮影してください。");
    }

    const parsed = parseDataUrl_(String(dataUrl), traceId);

    // Drive保存（任意：失敗しても続行）
    let receiptFileId = "";
    try {
      receiptFileId = saveReceiptToDrive_(parsed.base64, parsed.mimeType);
    } catch (e) {
      receiptFileId = "";
      console.warn(`[${traceId}] Drive save failed: ${e}`);
    }

    const ai = withOpenAIRetry_(
      () => callOpenAI_ImageToTransaction_(parsed.mimeType, parsed.base64, clientContext, traceId),
      traceId
    );

    const mapped = mapAiToRow_(ai, {
      source: "receipt",
      rawText: "(receipt)",
      receiptFileId: receiptFileId
    });

    const appendedId = appendTransactionRow_(mapped, traceId);

    return makeOkResult_(mapped, appendedId, started);
  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/** ---------- internal helpers ---------- */

function makeTraceId_() {
  const d = new Date();
  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  const hh = ("0" + d.getHours()).slice(-2);
  const mm = ("0" + d.getMinutes()).slice(-2);
  const ss = ("0" + d.getSeconds()).slice(-2);
  const rand = Utilities.getUuid().slice(0, 8);
  return `TRACE_${y}${m}${day}_${hh}${mm}${ss}_${rand}`;
}

function makeOkResult_(mappedRow, appendedId, startedMs) {
  const durationMs = Date.now() - startedMs;
  const clarification = mappedRow.status === "pending"
    ? {
        needs_clarification: true,
        questions: mappedRow.__clarification_questions || ["不足情報があります。日付や支払方法などを追加入力してください。"]
      }
    : null;

  delete mappedRow.__clarification_questions;

  return {
    ok: true,
    result: {
      transaction: mappedRow,
      appended_id: appendedId,
      clarification: clarification,
      meta: { duration_ms: durationMs }
    }
  };
}

function makeErrResult_(err, traceId, startedMs) {
  const durationMs = Date.now() - startedMs;
  const appErr = normalizeError_(err, traceId);

  return {
    ok: false,
    error: {
      code: appErr.code || "E_UNKNOWN",
      message: appErr.message || String(err),
      trace_id: traceId,
      retryable: !!appErr.retryable,
      user_message: appErr.userMessage || "エラーが発生しました。時間をおいて再度お試しください。",
      meta: { duration_ms: durationMs }
    }
  };
}

/**
 * OpenAI一時失敗時の簡易リトライ（最大2回）
 */
function withOpenAIRetry_(fn, traceId) {
  const maxAttempts = 2;
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      const n = normalizeError_(e, traceId);
      if (!n.retryable || attempt === maxAttempts) throw e;
      Utilities.sleep(attempt === 1 ? 300 : 1000);
    }
  }
  throw lastErr;
}

/**
 * data:image/...;base64,xxxx を解析
 */
function parseDataUrl_(dataUrl, traceId) {
  const m = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!m) {
    throw makeAppError_("E_BAD_REQUEST", "Invalid dataUrl format", traceId, false, "画像形式が不正です。もう一度選び直してください。");
  }
  return { mimeType: m[1], base64: m[2] };
}

/** ========== Phase 3: 履歴取得・更新 ========== */

/**
 * UI -> GAS: 取引一覧を取得
 * @param {string} monthStart YYYY-MM-DD（月初）、未指定なら当月
 * @param {Object=} filters { status, category, limit, includeUndated }
 * @return {Object} TransactionListResult
 */
function listTransactions(monthStart, filters) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    // デフォルト値
    const ms = monthStart || getCurrentMonthStart_();
    const f = filters || {};
    const limit = f.limit || 200;
    const includeUndated = f.includeUndated !== false; // デフォルトtrue

    const values = getTransactionsAllValues_();
    if (values.length <= 1) {
      return {
        ok: true,
        result: {
          monthStart: ms,
          rows: [],
          undatedRows: [],
          meta: { duration_ms: Date.now() - started }
        }
      };
    }

    const idxMap = buildTransactionsHeaderIndex_(values[0]);

    const rows = [];
    const undatedRows = [];

    for (let r = 1; r < values.length; r++) {
      const obj = rowToObject_(values[r], idxMap);

      // フィルタ: status
      if (f.status && obj.status !== f.status) continue;

      // フィルタ: category
      if (f.category && obj.category !== f.category) continue;

      // 日付による分類
      if (!obj.date) {
        // 未確定（date空）
        if (includeUndated) {
          undatedRows.push(obj);
        }
      } else if (isInMonth_(obj.date, ms)) {
        rows.push(obj);
      }
    }

    // 日付降順でソート（新しい順）
    rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    // limit適用
    const limitedRows = rows.slice(0, limit);
    const limitedUndated = undatedRows.slice(0, limit);

    return {
      ok: true,
      result: {
        monthStart: ms,
        rows: limitedRows,
        undatedRows: limitedUndated,
        meta: { duration_ms: Date.now() - started }
      }
    };

  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * UI -> GAS: 取引を更新
 * @param {string} id 取引ID
 * @param {Object} patch 更新するフィールド
 * @return {Object} TransactionResult
 */
function updateTransaction(id, patch) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!id) {
      throw makeAppError_("E_BAD_REQUEST", "ID is required", traceId, false, "IDが指定されていません。");
    }

    if (!patch || typeof patch !== "object") {
      throw makeAppError_("E_BAD_REQUEST", "Patch is required", traceId, false, "更新データが指定されていません。");
    }

    // パッチ検証
    validatePatch_(patch, traceId);

    return withSheetLock_(() => {
      const sheet = getSheetByName_("04_Transactions");
      const values = sheet.getDataRange().getValues();
      const idxMap = buildTransactionsHeaderIndex_(values[0]);

      // 行を検索
      const rowNumber = findRowById_(id, values, idxMap);
      if (!rowNumber) {
        throw makeAppError_("E_NOT_FOUND", `Transaction not found: ${id}`, traceId, false, "該当する取引が見つかりません。");
      }

      // パッチ適用
      applyPatchToRow_(sheet, rowNumber, idxMap, patch);

      // 更新後のデータを取得して返す
      const updatedRow = sheet.getRange(rowNumber, 1, 1, values[0].length).getValues()[0];
      const updatedObj = rowToObject_(updatedRow, idxMap);

      return {
        ok: true,
        result: {
          transaction: updatedObj,
          meta: { duration_ms: Date.now() - started }
        }
      };
    });

  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/** ========== Phase 4: ダッシュボード ========== */

/**
 * UI -> GAS: ダッシュボードデータを取得
 * @param {string} monthStart YYYY-MM-DD（月初）、未指定なら当月
 * @param {Object=} opts { includeUnconfirmed }
 * @return {Object} DashboardResult
 */
function getDashboard(monthStart, opts) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    const ms = normalizeMonthStart_(monthStart);
    const o = opts || {};

    const txns = getAllTransactionsAsObjects_(traceId);
    const dashboard = buildDashboard_(txns, ms, { includeUnconfirmed: !!o.includeUnconfirmed });

    // 通貨設定を取得
    const currency = getSettingsCurrency_();

    return {
      ok: true,
      result: {
        monthStart: ms,
        currency: currency,
        kpi: dashboard.kpi,
        byCategory: dashboard.byCategory,
        trend12m: dashboard.trend12m,
        meta: { duration_ms: Date.now() - started }
      }
    };

  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * monthStartを正規化（未指定or不正の場合は当月）
 */
function normalizeMonthStart_(monthStart) {
  if (!monthStart) return getCurrentMonthStart_();

  const d = new Date(monthStart);
  if (isNaN(d.getTime())) return getCurrentMonthStart_();

  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  return `${y}-${m}-01`;
}

/** ========== Phase 5: インサイト ========== */

/**
 * UI -> GAS: インサイトデータを取得
 * @param {string} monthStart YYYY-MM-DD（月初）、未指定なら当月
 * @param {Object=} opts { includeUnconfirmed }
 * @return {Object} InsightsResult
 */
function getInsights(monthStart, opts) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    const ms = normalizeMonthStart_(monthStart);
    const txns = getAllTransactionsAsObjects_(traceId);

    const ins = buildInsights_(txns, ms, opts || {});
    const currency = getSettingsCurrency_() || "JPY";

    return {
      ok: true,
      result: {
        monthStart: ins.monthStart,
        prevMonthStart: ins.prevMonthStart,
        summary: ins.summary,
        overspendTop3: ins.overspendTop3,
        savingsTop3: ins.savingsTop3,
        fixedCost: ins.fixedCost,
        meta: {
          currency,
          generated_at: new Date().toISOString(),
          duration_ms: Date.now() - started
        }
      }
    };
  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}
