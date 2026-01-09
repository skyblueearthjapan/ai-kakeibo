/**
 * 家計簿チャットボット - メインエントリーポイント
 * Phase 1-6: テキスト入力 + レシート撮影 + 履歴 + ダッシュボード + インサイト + 運用強化
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
 * @param {Object=} clientContext { client_request_id }
 * @return {Object} TransactionResult
 */
function processText(text, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();
  const clientRequestId = clientContext?.client_request_id || null;

  try {
    // Phase6: 二重送信チェック
    if (clientRequestId) {
      const dup = checkDuplicate_(clientRequestId);
      if (dup) {
        logSuccess_(traceId, "processText", Date.now() - started, { txn_id: dup.result?.appended_id, input_size: 0 });
        return dup; // 前回の結果を返す
      }

      // 処理中ロック取得
      if (!tryAcquireProcessingLock_(clientRequestId)) {
        throw makeAppError_("E_DUPLICATE_REQUEST", "Request already in progress", traceId, false, "処理中です。しばらくお待ちください。");
      }
    }

    if (!text || String(text).trim() === "") {
      throw makeAppError_("E_BAD_REQUEST", "Text is empty", traceId, false, "入力が空です。金額や店名を入力してください。");
    }

    const rawText = String(text).trim();
    let ai = null;
    let appendedId = null;
    let mapped = null;

    try {
      // OpenAI呼び出し（retry内蔵）
      ai = callOpenAI_TextToTransaction_(rawText, clientContext, traceId);

      mapped = mapAiToRow_(ai, {
        source: "text",
        rawText: rawText,
        receiptFileId: ""
      });

      appendedId = appendTransactionRow_(mapped, traceId);

    } catch (aiErr) {
      // Phase6: OpenAI失敗時は暫定行を保存
      const fallback = saveFallbackTransaction_(rawText, "", "text", aiErr, traceId);
      appendedId = fallback.id;
      mapped = fallback.row;

      // エラーログ
      logError_(traceId, "processText", Date.now() - started, normalizeError_(aiErr, traceId).code, String(aiErr), { input_size: rawText.length });

      // 暫定保存成功時は成功扱いで返す（ユーザーは履歴から編集可能）
      const result = makeFallbackOkResult_(mapped, appendedId, started, aiErr);

      if (clientRequestId) {
        markAsProcessed_(clientRequestId, appendedId, result);
        releaseProcessingLock_(clientRequestId);
      }

      return result;
    }

    const result = makeOkResult_(mapped, appendedId, started);

    // Phase6: 成功ログ + デデュープ登録
    logSuccess_(traceId, "processText", Date.now() - started, {
      txn_id: appendedId,
      input_size: rawText.length,
      model: ai?.__openai_model,
      tokens_in: ai?.__openai_usage?.input || 0,
      tokens_out: ai?.__openai_usage?.output || 0
    });

    if (clientRequestId) {
      markAsProcessed_(clientRequestId, appendedId, result);
      releaseProcessingLock_(clientRequestId);
    }

    return result;

  } catch (err) {
    const durationMs = Date.now() - started;
    logError_(traceId, "processText", durationMs, normalizeError_(err, traceId).code, String(err), {});

    if (clientRequestId) {
      releaseProcessingLock_(clientRequestId);
    }

    return makeErrResult_(err, traceId, started);
  }
}

/**
 * UI -> GAS: レシート画像を処理
 * @param {string} dataUrl e.g. data:image/jpeg;base64,....
 * @param {Object=} clientContext { client_request_id }
 * @return {Object} TransactionResult
 */
function processReceipt(dataUrl, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();
  const clientRequestId = clientContext?.client_request_id || null;

  try {
    // Phase6: 二重送信チェック
    if (clientRequestId) {
      const dup = checkDuplicate_(clientRequestId);
      if (dup) {
        logSuccess_(traceId, "processReceipt", Date.now() - started, { txn_id: dup.result?.appended_id, input_size: 0 });
        return dup;
      }

      if (!tryAcquireProcessingLock_(clientRequestId)) {
        throw makeAppError_("E_DUPLICATE_REQUEST", "Request already in progress", traceId, false, "処理中です。しばらくお待ちください。");
      }
    }

    if (!dataUrl || String(dataUrl).trim() === "") {
      throw makeAppError_("E_BAD_REQUEST", "dataUrl is empty", traceId, false, "画像が見つかりません。もう一度撮影してください。");
    }

    const parsed = parseDataUrl_(String(dataUrl), traceId);
    const imageSize = Math.round(parsed.base64.length * 0.75);

    // Drive保存（任意：失敗しても続行）
    let receiptFileId = "";
    try {
      receiptFileId = saveReceiptToDrive_(parsed.base64, parsed.mimeType);
    } catch (e) {
      receiptFileId = "";
      console.warn(`[${traceId}] Drive save failed: ${e}`);
    }

    let ai = null;
    let appendedId = null;
    let mapped = null;

    try {
      ai = callOpenAI_ImageToTransaction_(parsed.mimeType, parsed.base64, clientContext, traceId);

      mapped = mapAiToRow_(ai, {
        source: "receipt",
        rawText: "(receipt)",
        receiptFileId: receiptFileId
      });

      appendedId = appendTransactionRow_(mapped, traceId);

    } catch (aiErr) {
      // Phase6: OpenAI失敗時は暫定行を保存
      const fallback = saveFallbackTransaction_("(receipt)", receiptFileId, "receipt", aiErr, traceId);
      appendedId = fallback.id;
      mapped = fallback.row;

      logError_(traceId, "processReceipt", Date.now() - started, normalizeError_(aiErr, traceId).code, String(aiErr), { input_size: imageSize });

      const result = makeFallbackOkResult_(mapped, appendedId, started, aiErr);

      if (clientRequestId) {
        markAsProcessed_(clientRequestId, appendedId, result);
        releaseProcessingLock_(clientRequestId);
      }

      return result;
    }

    const result = makeOkResult_(mapped, appendedId, started);

    logSuccess_(traceId, "processReceipt", Date.now() - started, {
      txn_id: appendedId,
      receipt_file_id: receiptFileId,
      input_size: imageSize,
      model: ai?.__openai_model,
      tokens_in: ai?.__openai_usage?.input || 0,
      tokens_out: ai?.__openai_usage?.output || 0
    });

    if (clientRequestId) {
      markAsProcessed_(clientRequestId, appendedId, result);
      releaseProcessingLock_(clientRequestId);
    }

    return result;

  } catch (err) {
    const durationMs = Date.now() - started;
    logError_(traceId, "processReceipt", durationMs, normalizeError_(err, traceId).code, String(err), {});

    if (clientRequestId) {
      releaseProcessingLock_(clientRequestId);
    }

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

/**
 * Phase6: AI失敗時の暫定保存成功結果
 */
function makeFallbackOkResult_(mappedRow, appendedId, startedMs, originalError) {
  const durationMs = Date.now() - startedMs;
  const errInfo = normalizeError_(originalError, "");

  return {
    ok: true,
    result: {
      transaction: mappedRow,
      appended_id: appendedId,
      clarification: {
        needs_clarification: true,
        questions: ["AI解析に失敗したため、手動で入力内容を確認・修正してください。"]
      },
      fallback: true,
      original_error: errInfo.userMessage || "AI解析に失敗しました",
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
      logSuccess_(traceId, "listTransactions", Date.now() - started, {});
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

    logSuccess_(traceId, "listTransactions", Date.now() - started, {});

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
    logError_(traceId, "listTransactions", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
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

    const result = withSheetLock_(() => {
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

    logSuccess_(traceId, "updateTransaction", Date.now() - started, { txn_id: id });
    return result;

  } catch (err) {
    logError_(traceId, "updateTransaction", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
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

    logSuccess_(traceId, "getDashboard", Date.now() - started, {});

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
    logError_(traceId, "getDashboard", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
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

    logSuccess_(traceId, "getInsights", Date.now() - started, {});

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
    logError_(traceId, "getInsights", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
    return makeErrResult_(err, traceId, started);
  }
}
