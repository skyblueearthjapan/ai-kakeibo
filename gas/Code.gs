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

/**
 * UI -> GAS: 取引を削除
 * @param {string} id 取引ID
 * @return {Object} { ok, result: { deleted_id } }
 */
function deleteTransaction(id) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!id) {
      throw makeAppError_("E_BAD_REQUEST", "ID is required", traceId, false, "IDが指定されていません。");
    }

    const result = withSheetLock_(() => {
      const sheet = getSheetByName_("04_Transactions");
      const values = sheet.getDataRange().getValues();
      const idxMap = buildTransactionsHeaderIndex_(values[0]);

      // 行を検索
      const rowNumber = findRowById_(id, values, idxMap);
      if (!rowNumber) {
        throw makeAppError_("E_NOT_FOUND", `Transaction not found: ${id}`, traceId, false, "該当する取引が見つかりません。");
      }

      // 行を削除
      sheet.deleteRow(rowNumber);

      return {
        ok: true,
        result: {
          deleted_id: id,
          meta: { duration_ms: Date.now() - started }
        }
      };
    });

    logSuccess_(traceId, "deleteTransaction", Date.now() - started, { txn_id: id });
    return result;

  } catch (err) {
    logError_(traceId, "deleteTransaction", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
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

    // 方針B: 固定費を取引として実体化（Upsert方式で同期）
    ensureFixedCostsPostedForMonth_(ms);

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

    // 方針B: 固定費を取引として実体化（Upsert方式で同期）
    ensureFixedCostsPostedForMonth_(ms);

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

/** ========== Phase 7: AI非依存 OCR + 選択式入力 ========== */

/**
 * UI -> GAS: レシート画像をOCR解析（保存しない、draftのみ返す）
 * @param {string} dataUrl data:image/...;base64,...
 * @param {Object=} clientContext { client_request_id }
 * @return {Object} { ok, result: { draft } }
 */
function processReceiptV2(dataUrl, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!dataUrl || String(dataUrl).trim() === "") {
      throw makeAppError_("E_BAD_REQUEST", "dataUrl is empty", traceId, false, "画像が見つかりません。もう一度撮影してください。");
    }

    const parsed = parseDataUrl_(String(dataUrl), traceId);
    const imageSize = Math.round(parsed.base64.length * 0.75);

    // Drive保存
    let receiptFileId = "";
    try {
      receiptFileId = saveReceiptToDrive_(parsed.base64, parsed.mimeType);
    } catch (e) {
      console.warn(`[${traceId}] Drive save failed: ${e}`);
    }

    // 処理モード判定
    const mode = getProcessingMode_();
    let draft = createEmptyDraft_();

    if (mode === "ocr") {
      // OCRモード
      const ocr = runOcr_(parsed.base64, parsed.mimeType, traceId);
      draft = buildDraftFromOcrText_(ocr.fullText);
      draft.source = "ocr";
    } else if (mode === "manual") {
      // 手入力モード（OCRなし）
      draft.source = "manual";
    }
    // mode === "ai" の場合は将来拡張（現時点ではOCRにフォールバック）

    draft.receipt_file_id = receiptFileId;

    logSuccess_(traceId, "processReceiptV2", Date.now() - started, {
      input_size: imageSize,
      mode: mode
    });

    return {
      ok: true,
      result: { draft }
    };

  } catch (err) {
    logError_(traceId, "processReceiptV2", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * UI -> GAS: 手入力用の空Draftを取得
 * @return {Object} { ok, result: { draft } }
 */
function getEmptyDraft() {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    const draft = createEmptyDraft_();
    draft.source = "manual";

    logSuccess_(traceId, "getEmptyDraft", Date.now() - started, {});

    return {
      ok: true,
      result: { draft }
    };
  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * UI -> GAS: Draft確定保存
 * @param {Object} draft TransactionDraft
 * @param {Object=} clientContext { client_request_id }
 * @return {Object} { ok, result: { transaction_id } }
 */
function saveTransactionDraft(draft, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();
  const clientRequestId = clientContext?.client_request_id || null;
  let lock = null;
  let acquiredClientLock = false;  // clientRequestIdロックを取得したか

  try {
    // DocumentLock取得（WebApp安全）
    lock = acquireProcessingLock_(traceId);

    // 二重送信チェック（Cache版）
    if (clientRequestId) {
      const dup = checkDuplicate_(clientRequestId);
      if (dup) {
        appendLog_("INFO", `Duplicate request: ${clientRequestId}`, traceId);
        return dup;
      }

      if (!tryAcquireProcessingLock_(clientRequestId)) {
        throw makeAppError_("E_DUPLICATE_REQUEST", "Request already in progress", traceId, false, "処理中です。しばらくお待ちください。");
      }
      acquiredClientLock = true;  // ロック取得成功
    }

    // バリデーション
    if (!draft) {
      throw makeAppError_("E_BAD_REQUEST", "Draft is required", traceId, false, "入力データがありません。");
    }

    if (!draft.amount || Number(draft.amount) <= 0) {
      throw makeAppError_("E_BAD_REQUEST", "Invalid amount", traceId, false, "金額が正しく入力されていません。");
    }

    // 行データ作成（ヘッダ駆動と相性の良い形式）
    const row = normalizeDraftToRowObj_(draft, traceId);

    // シートに保存（openById経由・WebApp安全）
    const txnId = appendTransactionRow_(row, traceId);

    appendLog_("INFO", `Saved txnId=${txnId}, txn_type=${row.__txn_type || "expense"}`, traceId);

    // 固定費の場合：FixedCostsマスタにも同期（名前ベースでupsert）
    if (row.__txn_type === "fixed_cost") {
      try {
        syncFixedCostFromTransaction_(row, traceId);
        appendLog_("INFO", `Fixed cost synced: ${row.merchant}`, traceId);
      } catch (syncErr) {
        // 同期エラーは警告のみ、取引保存は成功扱い
        appendLog_("WARN", `Fixed cost sync failed: ${syncErr.message}`, traceId);
      }
    }

    // 内部プロパティを削除（レスポンスには含めない）
    delete row.__txn_type;

    const result = {
      ok: true,
      result: {
        transaction_id: txnId,
        transaction: row
      }
    };

    if (clientRequestId) {
      markAsProcessed_(clientRequestId, txnId, result);
    }

    return result;

  } catch (err) {
    appendLog_("ERROR", `saveTransactionDraft failed: ${err}`, traceId);

    return {
      ok: false,
      error: {
        code: "E_SHEET_WRITE_FAILED",
        message: "保存に失敗しました。もう一度お試しください。",
        traceId: traceId,
        detail: String(err)
      }
    };
  } finally {
    // DocumentLock確実解放
    releaseProcessingLockSafe_(lock, traceId);

    // clientRequestIdロックも必ず解除（tryAcquireした場合のみ）
    if (acquiredClientLock && clientRequestId) {
      try {
        releaseProcessingLock_(clientRequestId);
      } catch (e) {
        console.log(`[LOCK] client lock release failed: ${e}`);
      }
    }
  }
}

/**
 * DraftオブジェクトをRowオブジェクトに正規化
 * ヘッダ駆動appendTransactionRow_と相性の良い形式に変換
 * txn_type: expense/income/fixed_cost を処理
 */
function normalizeDraftToRowObj_(draft, traceId) {
  const d = draft || {};
  const now = new Date();
  const nowIso = now.toISOString();
  const today = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");

  // txn_type処理: fixed_costはexpenseとして保存し、sourceで識別
  const txnType = d.txn_type || "expense";
  let sheetType = d.type || "expense";
  let source = d.source || "manual";
  let tags = String(d.tags || "");

  if (txnType === "income") {
    sheetType = "income";
  } else if (txnType === "fixed_cost") {
    sheetType = "expense";  // 固定費は支出として集計
    source = "fixed_cost";  // sourceで固定費を識別
    // tagsに追加（重複防止）
    if (!tags.includes("fixed_cost")) {
      tags = tags ? tags + ",fixed_cost" : "fixed_cost";
    }
  }

  return {
    id: generateTransactionId_(),
    created_at: nowIso,
    updated_at: nowIso,
    date: d.date || today,
    type: sheetType,
    account: d.account || "",
    merchant: String(d.merchant || ""),
    item: String(d.item || ""),
    category: String(d.category || d.category_name || ""),
    subcategory: String(d.subcategory || ""),
    payment_method: String(d.payment_method || d.payment || ""),
    amount: Number(d.amount || 0),
    memo: String(d.memo || ""),
    tags: tags,
    source: source,
    confidence: 0,
    receipt_file_id: d.receipt_file_id || "",
    raw_text: String(d.raw_text || ""),
    status: "confirmed",  // ユーザー確定なので即confirmed
    trace_id: traceId,
    // 内部処理用（シートには保存しない）
    __txn_type: txnType
  };
}

/**
 * カテゴリ一覧を取得（UIのselect用）
 * @return {Object} { ok, result: { categories } }
 */
function getCategories() {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    // getSheetOrNull_ を使用（openById経由・WebApp安全）
    const sheet = getSheetOrNull_("02_Categories");
    let categories = [];

    if (sheet) {
      const values = sheet.getDataRange().getValues();
      for (let r = 1; r < values.length; r++) {
        const cat = String(values[r][0] || "").trim();
        const subcat = String(values[r][1] || "").trim();
        if (cat) {
          categories.push({ category: cat, subcategory: subcat });
        }
      }
    }

    // デフォルトカテゴリ（シートが空の場合）
    if (categories.length === 0) {
      categories = [
        { category: "食費", subcategory: "" },
        { category: "日用品", subcategory: "" },
        { category: "交通", subcategory: "" },
        { category: "住居", subcategory: "" },
        { category: "光熱費", subcategory: "" },
        { category: "通信", subcategory: "" },
        { category: "医療", subcategory: "" },
        { category: "娯楽", subcategory: "" },
        { category: "交際", subcategory: "" },
        { category: "その他", subcategory: "" }
      ];
    }

    logSuccess_(traceId, "getCategories", Date.now() - started, {});

    return {
      ok: true,
      result: { categories }
    };

  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * 支払方法一覧を取得（UIのselect用）
 * @return {Object} { ok, result: { accounts } }
 */
function getAccounts() {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    // getSheetOrNull_ を使用（openById経由・WebApp安全）
    const sheet = getSheetOrNull_("03_Accounts");
    let accounts = [];

    if (sheet) {
      const values = sheet.getDataRange().getValues();
      for (let r = 1; r < values.length; r++) {
        const name = String(values[r][0] || "").trim();
        const type = String(values[r][1] || "").trim();
        if (name) {
          accounts.push({ name: name, type: type });
        }
      }
    }

    // デフォルト支払方法
    if (accounts.length === 0) {
      accounts = [
        { name: "現金", type: "cash" },
        { name: "クレジットカード", type: "credit" },
        { name: "電子マネー", type: "emoney" },
        { name: "銀行振込", type: "bank" }
      ];
    }

    logSuccess_(traceId, "getAccounts", Date.now() - started, {});

    return {
      ok: true,
      result: { accounts }
    };

  } catch (err) {
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * UIマスタデータを取得（02_Masterシートから）
 * Phase9: カテゴリ・支払方法をマスタシートから読み込む（設定値との分離）
 * @return {Object} { ok, result: { categories, paymentMethods, subcategoriesByCategory } }
 */
function getUiMasterData() {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    // マスタシートを確保（なければ作成）
    ensureMasterSheets_();

    // 02_Master からカテゴリ・支払方法を取得
    let categories = listMasters_("CATEGORY");
    let paymentMethods = listMasters_("PAYMENT");

    // デフォルト値（マスタが空の場合）
    if (categories.length === 0) {
      ensureDefaultMasters_();
      categories = listMasters_("CATEGORY");
    }

    if (paymentMethods.length === 0) {
      ensureDefaultMasters_();
      paymentMethods = listMasters_("PAYMENT");
    }

    // 02_Categories からサブカテゴリマップを構築（あれば）
    const ss = getSs_();
    const subcategoriesByCategory = {};
    const catSheet = ss.getSheetByName("02_Categories");
    if (catSheet) {
      const catLastRow = catSheet.getLastRow();
      if (catLastRow >= 2) {
        const rows = catSheet.getRange(2, 1, catLastRow - 1, 2).getValues();
        rows.forEach(r => {
          const cat = r[0] ? String(r[0]).trim() : "";
          const sub = r[1] ? String(r[1]).trim() : "";
          if (!cat || !sub) return;
          if (!subcategoriesByCategory[cat]) subcategoriesByCategory[cat] = [];
          if (!subcategoriesByCategory[cat].includes(sub)) {
            subcategoriesByCategory[cat].push(sub);
          }
        });
      }
    }

    logSuccess_(traceId, "getUiMasterData", Date.now() - started, {});

    return {
      ok: true,
      result: {
        categories,
        paymentMethods,
        subcategoriesByCategory
      }
    };

  } catch (err) {
    logError_(traceId, "getUiMasterData", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
    return makeErrResult_(err, traceId, started);
  }
}

/** ========== AI有効化パッチ ========== */

/**
 * UI -> GAS: AI状態をデバッグ表示
 * @return {Object}
 */
function debugAiStatus() {
  const traceId = makeTraceId_();
  const enabled = isAiEnabled_();
  const providerInfo = getAiProviderInfo_();

  return {
    ok: true,
    result: {
      aiEnabled: enabled,
      provider: providerInfo.provider,
      model: providerInfo.model,
      hasKey: providerInfo.hasKey,
      traceId
    }
  };
}

/**
 * UI -> GAS: Home smart input（テキスト -> draft）
 * @param {string} text ユーザー入力（例：「すき家 2000円」）
 * @param {Object=} clientContext
 * @return {Object} { ok, result: { draft, aiUsed } }
 */
function processSmartInput(text, clientContext) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    const ui = getUiMasterData().result;

    // AI usable? (OpenAIまたはGeminiのAPIキーがあればOK)
    const canAi = isAiEnabled_() && hasAnyAiApiKey_();

    let draft;
    if (canAi) {
      draft = aiDraftFromText_(String(text || ""), ui, traceId);
      draft.source = "ai";
    } else {
      draft = ruleDraftFromText_(String(text || ""), ui);
      draft.source = "manual_rule";
      draft.explanation = "AIが無効のため、簡易ルールで推定しました。必要に応じて修正してください。";
      draft.confidence = 0.2;
    }

    logSuccess_(traceId, "processSmartInput", Date.now() - started, { aiUsed: canAi });

    return { ok: true, result: { draft, traceId, aiUsed: canAi } };

  } catch (e) {
    logError_(traceId, "processSmartInput", Date.now() - started, normalizeError_(e, traceId).code, String(e), {});

    // エラーでも手入力に落とせるよう、UIに説明を返す
    const msg = (e && e.userMessage) ? e.userMessage : "AI処理でエラーが発生しました。手入力で登録してください。";
    return { ok: false, error: { message: msg, detail: String(e), traceId } };
  }
}

/**
 * AI draft builder（OpenAI呼び出し）
 * 取引タイプ自動判定: expense（変動費）/ income（収入）/ fixed_cost（固定費）
 * 発生日（occurred_at）とタイトル（title）を必須で抽出
 */
function aiDraftFromText_(text, ui, traceId) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const thisYear = new Date().getFullYear();
  const thisMonth = new Date().getMonth() + 1;

  const schemaHint = {
    occurred_at: "YYYY-MM-DD (発生日。月のみなら月初1日)",
    txn_type: "expense | income | fixed_cost",
    title: "取引タイトル（必須。店名/内容の短い説明）",
    amount: 0,
    merchant: "",
    category: "",
    payment_method: "",
    memo: "短く整形したメモ",
    confidence: 0.0,
    needs_confirmation: true,
    explanation: ""
  };

  const sys = [
    "You are an assistant that extracts a household transaction from Japanese user text.",
    "Return ONLY valid JSON (no markdown).",
    "",
    "## CRITICAL: Date Extraction (occurred_at)",
    "Extract the OCCURRENCE DATE (発生日), NOT today's date.",
    "- '12月のボーナス' → occurred_at: '" + thisYear + "-12-01' (December 1st)",
    "- '先月の家賃' → occurred_at: previous month's 1st day",
    "- '今月の電気代' → occurred_at: this month's 1st day",
    "- '1/15に買った' → occurred_at: '" + thisYear + "-01-15'",
    "- No date mentioned → occurred_at: '" + today + "' (today)",
    "If only month is mentioned, use the 1st day of that month.",
    "Today is: " + today,
    "",
    "## CRITICAL: Title (必須)",
    "You MUST provide a title. This is the main display text.",
    "- Use merchant name if available (e.g., 'スタバ', 'イオン')",
    "- Otherwise, use a short description from memo (e.g., 'ボーナス', '家賃', '電気代')",
    "- NEVER leave title empty",
    "",
    "## Transaction Type Detection:",
    "Classify txn_type as one of: expense, income, fixed_cost",
    "",
    "### ★ HIGHEST PRIORITY: User Explicit Instructions ★",
    "If user explicitly specifies the type, ALWAYS use that type regardless of keywords:",
    "- '変動費で', '変動費として', '変動費でお願い' → txn_type: expense",
    "- '固定費で', '固定費として', '固定費でお願い' → txn_type: fixed_cost",
    "- '収入として', '収入で' → txn_type: income",
    "Example: '携帯代 3000円 変動費で' → txn_type: expense (user override)",
    "Example: '生活費 5万円 固定費でお願い' → txn_type: fixed_cost (user override)",
    "",
    "### income (収入) - if no explicit instruction:",
    "- Keywords: 給料, 給与, ボーナス, 振込, 収入, 売上, 報酬, 配当",
    "- Category: 収入",
    "",
    "### fixed_cost (固定費) - if no explicit instruction:",
    "- Keywords: 家賃, 住宅ローン, 光熱費, 電気代, ガス代, 水道代, 通信費, スマホ代, 携帯, インターネット, WiFi, 保険, サブスク, Netflix, Spotify, 定額, 毎月, 奨学金, ローン",
    "- Categories: 住居費, 光熱費, 通信費, 保険, サブスク",
    "",
    "### expense (変動費) - default:",
    "- Everything else (食費, 交通, 娯楽, etc.)",
    "",
    "Choose category/payment_method ONLY from provided lists if possible; otherwise empty string.",
    "If amount is unclear, set amount=0 and needs_confirmation=true.",
    "Set memo to a SHORT, clean description (not raw input)."
  ].join("\n");

  const user = {
    instruction: "Extract transaction fields. IMPORTANT: occurred_at is the date the transaction happened, title is required.",
    input_text: text,
    today,
    this_year: thisYear,
    this_month: thisMonth,
    allowed_categories: ui.categories || [],
    allowed_payment_methods: ui.paymentMethods || [],
    output_schema: schemaHint
  };

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: JSON.stringify(user) }
  ];

  const parsed = callAiJson_(messages, schemaHint, traceId);

  // txn_type正規化
  let txnType = String(parsed.txn_type || "expense").toLowerCase();
  if (!["expense", "income", "fixed_cost"].includes(txnType)) {
    txnType = "expense";
  }

  // type: Transactionsシートのtype列用（expense or income）
  const sheetType = (txnType === "income") ? "income" : "expense";

  // 発生日の処理（occurred_at優先、なければ今日）
  let occurredAt = String(parsed.occurred_at || parsed.date || today).slice(0, 10);
  // 不正な日付の場合は今日にフォールバック
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredAt)) {
    occurredAt = today;
  }

  // タイトルの必須化（「詳細なし」根絶）
  let title = String(parsed.title || "").trim();
  if (!title) {
    // フォールバック: merchant → memo先頭 → 種別名
    title = String(parsed.merchant || "").trim();
    if (!title) {
      const memoClean = String(parsed.memo || "").trim();
      title = memoClean.slice(0, 20) || getTxnTypeFallbackTitle_(txnType);
    }
  }

  return {
    date: occurredAt,           // 発生日を使用
    txn_type: txnType,          // AI判定結果（expense/income/fixed_cost）
    type: sheetType,            // シート保存用（expense/income）
    title: title,               // タイトル（必須）
    amount: Number(parsed.amount || 0),
    merchant: String(parsed.merchant || title),  // merchantが空ならtitleを使用
    category: String(parsed.category || ""),
    payment_method: String(parsed.payment_method || ""),
    memo: String(parsed.memo || ""),
    raw_text: text,
    confidence: Number(parsed.confidence || 0.4),
    needs_confirmation: parsed.needs_confirmation !== false,
    explanation: String(parsed.explanation || "")
  };
}

/**
 * 取引タイプに応じたフォールバックタイトル
 */
function getTxnTypeFallbackTitle_(txnType) {
  const titles = {
    "expense": "支出",
    "income": "収入",
    "fixed_cost": "固定費"
  };
  return titles[txnType] || "取引";
}

/**
 * Rule-based draft (fallback)
 * 取引タイプの簡易判定も含む
 */
function ruleDraftFromText_(text, ui) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const t = String(text || "").trim();
  const tLower = t.toLowerCase();

  // amount: "2000円" "二千円" はまず数字だけを拾う簡易版（漢数字は後で拡張）
  let amount = 0;
  const m = t.match(/(\d{1,7})\s*(円|えん)/);
  if (m) amount = Number(m[1]);

  // merchant: amount前まで
  let merchant = t;
  if (m && m.index !== undefined) merchant = t.slice(0, m.index).trim();

  // 取引タイプ判定
  let txnType = "expense";
  let category = "";
  let userOverride = false;

  // ★ 最優先: ユーザー明示指定（「変動費で」「固定費で」「収入として」など）
  const expenseExplicit = ["変動費で", "変動費として", "変動費でお願い", "変動費に"];
  const fixedExplicit = ["固定費で", "固定費として", "固定費でお願い", "固定費に"];
  const incomeExplicit = ["収入として", "収入で", "収入でお願い", "収入に"];

  if (expenseExplicit.some(k => t.includes(k))) {
    txnType = "expense";
    userOverride = true;
  } else if (fixedExplicit.some(k => t.includes(k))) {
    txnType = "fixed_cost";
    userOverride = true;
  } else if (incomeExplicit.some(k => t.includes(k))) {
    txnType = "income";
    category = "収入";
    userOverride = true;
  }

  // ユーザー明示指定がない場合のみ、キーワードベースで判定
  if (!userOverride) {
    // 収入キーワード
    const incomeKeywords = ["給料", "給与", "ボーナス", "収入", "振込", "売上", "報酬"];
    if (incomeKeywords.some(k => t.includes(k))) {
      txnType = "income";
      category = "収入";
    }

    // 固定費キーワード
    const fixedCostKeywords = ["家賃", "住宅ローン", "光熱費", "電気代", "ガス代", "水道代", "通信費", "携帯", "スマホ", "インターネット", "wifi", "保険", "サブスク", "netflix", "spotify", "定額", "毎月"];
    if (fixedCostKeywords.some(k => tLower.includes(k))) {
      txnType = "fixed_cost";
    }
  }

  // カテゴリ推定（txnTypeに基づく）
  if (txnType === "fixed_cost" && !category) {
    if (t.includes("家賃") || t.includes("住宅ローン")) category = "住居費";
    else if (t.includes("電気") || t.includes("ガス") || t.includes("水道") || t.includes("光熱")) category = "光熱費";
    else if (t.includes("通信") || t.includes("携帯") || t.includes("スマホ") || tLower.includes("wifi") || t.includes("インターネット")) category = "通信費";
    else if (t.includes("保険")) category = "保険";
    else if (t.includes("サブスク") || tLower.includes("netflix") || tLower.includes("spotify")) category = "サブスク";
  }

  const sheetType = (txnType === "income") ? "income" : "expense";

  // title: merchantがあればそれを使用、なければフォールバック
  let title = merchant || "";
  if (!title) {
    title = getTxnTypeFallbackTitle_(txnType);
  }

  return {
    date: today,
    txn_type: txnType,
    type: sheetType,
    title: title,                   // タイトル（必須）
    amount,
    merchant: merchant || title,    // merchantが空ならtitleを使用
    category,
    payment_method: "",
    memo: t,
    raw_text: t,
    confidence: 0.2,
    needs_confirmation: true,
    explanation: "簡易推定（AI無効/未設定）"
  };
}

/** ========== 固定費管理 ========== */

/**
 * 固定費一覧を取得
 * @return {Object} { ok, result: { fixedCosts } }
 */
function listFixedCosts() {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    const sheet = getOrCreateFixedCostsSheet_();
    const values = sheet.getDataRange().getValues();

    if (values.length <= 1) {
      return {
        ok: true,
        result: { fixedCosts: [], meta: { duration_ms: Date.now() - started } }
      };
    }

    const headers = values[0];
    const idxMap = {};
    headers.forEach((h, i) => { idxMap[String(h).toLowerCase()] = i; });

    const fixedCosts = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const active = row[idxMap["active"]];
      if (active === false || active === "FALSE") continue;

      fixedCosts.push({
        id: String(row[idxMap["id"]] || ""),
        name: String(row[idxMap["name"]] || ""),
        amount: Number(row[idxMap["amount"]] || 0),
        category: String(row[idxMap["category"]] || ""),
        payment: String(row[idxMap["payment"]] || ""),
        active: active !== false && active !== "FALSE",
        memo: String(row[idxMap["memo"]] || "")
      });
    }

    logSuccess_(traceId, "listFixedCosts", Date.now() - started, {});

    return {
      ok: true,
      result: { fixedCosts, meta: { duration_ms: Date.now() - started } }
    };

  } catch (err) {
    logError_(traceId, "listFixedCosts", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * 固定費を保存（新規or更新）
 * @param {Object} data { id, name, amount, category, payment, active }
 * @return {Object} { ok, result: { id } }
 */
function saveFixedCost(data) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!data || !data.name) {
      throw makeAppError_("E_BAD_REQUEST", "Name is required", traceId, false, "名前が入力されていません。");
    }

    const sheet = getOrCreateFixedCostsSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const idxMap = {};
    headers.forEach((h, i) => { idxMap[String(h).toLowerCase()] = i; });

    const now = new Date().toISOString();
    let targetId = data.id;

    if (targetId) {
      // 更新
      let found = false;
      for (let r = 1; r < values.length; r++) {
        if (String(values[r][idxMap["id"]]) === targetId) {
          sheet.getRange(r + 1, idxMap["name"] + 1).setValue(data.name);
          sheet.getRange(r + 1, idxMap["amount"] + 1).setValue(data.amount || 0);
          sheet.getRange(r + 1, idxMap["category"] + 1).setValue(data.category || "");
          sheet.getRange(r + 1, idxMap["payment"] + 1).setValue(data.payment || "");
          sheet.getRange(r + 1, idxMap["active"] + 1).setValue(data.active !== false);
          sheet.getRange(r + 1, idxMap["updated_at"] + 1).setValue(now);
          found = true;
          break;
        }
      }
      if (!found) {
        throw makeAppError_("E_NOT_FOUND", `Fixed cost not found: ${targetId}`, traceId, false, "該当する固定費が見つかりません。");
      }
    } else {
      // 新規
      targetId = "FIX_" + Utilities.getUuid().slice(0, 8);
      const newRow = [];
      headers.forEach((h, i) => {
        const key = String(h).toLowerCase();
        if (key === "id") newRow[i] = targetId;
        else if (key === "name") newRow[i] = data.name;
        else if (key === "amount") newRow[i] = data.amount || 0;
        else if (key === "category") newRow[i] = data.category || "";
        else if (key === "payment") newRow[i] = data.payment || "";
        else if (key === "active") newRow[i] = true;
        else if (key === "memo") newRow[i] = data.memo || "";
        else if (key === "updated_at") newRow[i] = now;
        else newRow[i] = "";
      });
      sheet.appendRow(newRow);
    }

    // 方針B: 当月の固定費取引も同期（Upsert）
    // active=TRUE の場合のみ、当月の取引を作成/更新
    if (data.active !== false) {
      const now2 = new Date();
      const currentYm = now2.getFullYear() + "-" + String(now2.getMonth() + 1).padStart(2, "0");

      const fcForSync = {
        id: targetId,
        name: data.name,
        amount: Number(String(data.amount || 0).replace(/,/g, "")) || 0,
        category: data.category || "",
        payment: data.payment || ""
      };

      try {
        const syncResult = upsertFixedCostTransaction_(fcForSync, currentYm, traceId);
        Logger.log("[" + traceId + "] 固定費取引同期: " + syncResult.action);
      } catch (syncErr) {
        Logger.log("[" + traceId + "] 固定費取引同期エラー（継続）: " + syncErr.message);
        // 同期エラーは警告のみ、保存自体は成功扱い
      }
    }

    logSuccess_(traceId, "saveFixedCost", Date.now() - started, { fixed_id: targetId });

    return {
      ok: true,
      result: { id: targetId, meta: { duration_ms: Date.now() - started } }
    };

  } catch (err) {
    logError_(traceId, "saveFixedCost", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * 固定費を削除
 * @param {string} id 固定費ID
 * @return {Object} { ok, result: { deleted_id } }
 */
function deleteFixedCost(id) {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    if (!id) {
      throw makeAppError_("E_BAD_REQUEST", "ID is required", traceId, false, "IDが指定されていません。");
    }

    const sheet = getOrCreateFixedCostsSheet_();
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const idIdx = headers.findIndex(h => String(h).toLowerCase() === "id");

    let deleted = false;
    for (let r = values.length - 1; r >= 1; r--) {
      if (String(values[r][idIdx]) === id) {
        sheet.deleteRow(r + 1);
        deleted = true;
        break;
      }
    }

    if (!deleted) {
      throw makeAppError_("E_NOT_FOUND", `Fixed cost not found: ${id}`, traceId, false, "該当する固定費が見つかりません。");
    }

    // 方針B: 当月の固定費取引も削除
    try {
      const now = new Date();
      const currentYm = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      const txnDeleted = deleteFixedCostTransaction_(id, currentYm, traceId);
      Logger.log("[" + traceId + "] 固定費取引削除: " + (txnDeleted ? "成功" : "該当なし"));
    } catch (syncErr) {
      Logger.log("[" + traceId + "] 固定費取引削除エラー（継続）: " + syncErr.message);
      // 同期エラーは警告のみ
    }

    logSuccess_(traceId, "deleteFixedCost", Date.now() - started, { fixed_id: id });

    return {
      ok: true,
      result: { deleted_id: id, meta: { duration_ms: Date.now() - started } }
    };

  } catch (err) {
    logError_(traceId, "deleteFixedCost", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});
    return makeErrResult_(err, traceId, started);
  }
}

/**
 * 07_FixedCosts シートを取得または作成
 */
function getOrCreateFixedCostsSheet_() {
  const ss = getSs_();
  let sheet = ss.getSheetByName("07_FixedCosts");

  if (!sheet) {
    sheet = ss.insertSheet("07_FixedCosts");
    // ヘッダ行を設定
    const headers = ["id", "name", "amount", "category", "payment", "active", "memo", "updated_at"];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
  }

  return sheet;
}

/**
 * 取引からFixedCostsマスタに同期（名前ベースでupsert）
 * AIが「fixed_cost」と判定した取引を、FixedCostsマスタにも反映
 * @param {Object} row 取引データ（normalizeDraftToRowObj_の出力）
 * @param {string} traceId
 */
function syncFixedCostFromTransaction_(row, traceId) {
  const sheet = getOrCreateFixedCostsSheet_();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idxMap = {};
  headers.forEach((h, i) => { idxMap[String(h).toLowerCase()] = i; });

  const name = String(row.merchant || "").trim();
  if (!name) {
    Logger.log("[" + traceId + "] syncFixedCost: name empty, skip");
    return;
  }

  const now = new Date().toISOString();
  const amount = Number(row.amount || 0);
  const category = String(row.category || "");
  const payment = String(row.payment_method || "");

  // 名前で既存エントリを検索
  let existingRow = -1;
  for (let r = 1; r < values.length; r++) {
    const rowName = String(values[r][idxMap["name"]] || "").trim();
    if (rowName === name) {
      existingRow = r + 1;  // シート行番号（1-indexed）
      break;
    }
  }

  if (existingRow > 0) {
    // 更新（金額・カテゴリ・支払方法）
    sheet.getRange(existingRow, idxMap["amount"] + 1).setValue(amount);
    if (category) sheet.getRange(existingRow, idxMap["category"] + 1).setValue(category);
    if (payment) sheet.getRange(existingRow, idxMap["payment"] + 1).setValue(payment);
    sheet.getRange(existingRow, idxMap["updated_at"] + 1).setValue(now);
    Logger.log("[" + traceId + "] syncFixedCost: updated '" + name + "'");
  } else {
    // 新規作成
    const newId = "FIX_" + Utilities.getUuid().slice(0, 8);
    const newRow = [];
    headers.forEach((h, i) => {
      const key = String(h).toLowerCase();
      if (key === "id") newRow[i] = newId;
      else if (key === "name") newRow[i] = name;
      else if (key === "amount") newRow[i] = amount;
      else if (key === "category") newRow[i] = category;
      else if (key === "payment") newRow[i] = payment;
      else if (key === "active") newRow[i] = true;
      else if (key === "memo") newRow[i] = "AI自動登録";
      else if (key === "updated_at") newRow[i] = now;
      else newRow[i] = "";
    });
    sheet.appendRow(newRow);
    Logger.log("[" + traceId + "] syncFixedCost: created '" + name + "' as " + newId);
  }
}
