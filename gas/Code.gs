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

  try {
    // 二重送信チェック
    if (clientRequestId) {
      const dup = checkDuplicate_(clientRequestId);
      if (dup) {
        logSuccess_(traceId, "saveTransactionDraft", Date.now() - started, { txn_id: dup.result?.transaction_id });
        return dup;
      }

      if (!tryAcquireProcessingLock_(clientRequestId)) {
        throw makeAppError_("E_DUPLICATE_REQUEST", "Request already in progress", traceId, false, "処理中です。しばらくお待ちください。");
      }
    }

    // バリデーション
    if (!draft) {
      throw makeAppError_("E_BAD_REQUEST", "Draft is required", traceId, false, "入力データがありません。");
    }

    if (!draft.amount || Number(draft.amount) <= 0) {
      throw makeAppError_("E_BAD_REQUEST", "Invalid amount", traceId, false, "金額が正しく入力されていません。");
    }

    // 行データ作成
    const row = {
      id: generateTransactionId_(),
      date: draft.date || "",
      type: draft.type || "expense",
      account: draft.account || "",
      merchant: draft.merchant || "",
      item: draft.item || "",
      category: draft.category || "",
      subcategory: draft.subcategory || "",
      payment_method: draft.payment_method || "",
      amount: Number(draft.amount),
      memo: draft.memo || "",
      tags: draft.tags || "",
      source: draft.source || "manual",
      confidence: 0,
      receipt_file_id: draft.receipt_file_id || "",
      raw_text: draft.raw_text || "",
      status: "confirmed", // Phase7: ユーザー確定なので即confirmed
      trace_id: traceId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    // シートに保存
    const txnId = appendTransactionRow_(row, traceId);

    const result = {
      ok: true,
      result: {
        transaction_id: txnId,
        transaction: row
      }
    };

    logSuccess_(traceId, "saveTransactionDraft", Date.now() - started, { txn_id: txnId });

    if (clientRequestId) {
      markAsProcessed_(clientRequestId, txnId, result);
      releaseProcessingLock_(clientRequestId);
    }

    return result;

  } catch (err) {
    logError_(traceId, "saveTransactionDraft", Date.now() - started, normalizeError_(err, traceId).code, String(err), {});

    if (clientRequestId) {
      releaseProcessingLock_(clientRequestId);
    }

    return makeErrResult_(err, traceId, started);
  }
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
 * UIマスタデータを取得（01_Settingsシートから）
 * Phase8: カテゴリ・支払方法をシートから読み込む
 * @return {Object} { ok, result: { categories, paymentMethods, subcategoriesByCategory } }
 */
function getUiMasterData() {
  const traceId = makeTraceId_();
  const started = Date.now();

  try {
    // getSs_ を使用（openById経由・WebApp安全）
    const ss = getSs_();

    // 01_Settings シートから読み込み
    const settingsSheet = ss.getSheetByName("01_Settings");
    let categories = [];
    let paymentMethods = [];

    if (settingsSheet) {
      const lastRow = settingsSheet.getLastRow();

      // カテゴリ: A9:A（A列の9行目以降）
      if (lastRow >= 9) {
        const catValues = settingsSheet.getRange(9, 1, lastRow - 8, 1).getValues();
        categories = catValues.flat().filter(v => v && String(v).trim()).map(String);
      }

      // 支払方法: C9:C（C列の9行目以降）
      if (lastRow >= 9) {
        const payValues = settingsSheet.getRange(9, 3, lastRow - 8, 1).getValues();
        paymentMethods = payValues.flat().filter(v => v && String(v).trim()).map(String);
      }
    }

    // デフォルト値（シートが空の場合）
    if (categories.length === 0) {
      categories = ["食費", "日用品", "住居", "光熱費", "通信", "交通", "医療", "教育", "娯楽", "交際", "その他"];
    }

    if (paymentMethods.length === 0) {
      paymentMethods = ["現金", "クレジットカード", "デビット", "QR/電子マネー", "口座振替", "振込", "ポイント"];
    }

    // 02_Categories からサブカテゴリマップを構築（あれば）
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
  const key = getOpenAiApiKey_();
  const enabled = isAiEnabled_();

  let source = "none";
  const propsKey = PropertiesService.getScriptProperties().getProperty("OPENAI_API_KEY");
  if (propsKey) {
    source = "props";
  } else {
    const cfg = getConfigKV_();
    if (cfg.OPENAI_API_KEY) {
      source = "settings_kv";
    } else {
      source = "settings_cell_or_none";
    }
  }

  return {
    ok: true,
    result: {
      aiEnabled: enabled,
      hasKey: !!key,
      keySource: source,
      modelText: getOpenAiModel_(),
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

    // AI usable?
    const canAi = isAiEnabled_() && !!getOpenAiApiKey_();

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
 */
function aiDraftFromText_(text, ui, traceId) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

  const schemaHint = {
    date: "YYYY-MM-DD",
    amount: 0,
    merchant: "",
    category: "",
    payment_method: "",
    memo: "",
    confidence: 0.0,
    needs_confirmation: true,
    explanation: ""
  };

  const sys = [
    "You are an assistant that extracts a household expense transaction from Japanese user text.",
    "Return ONLY valid JSON (no markdown).",
    "Choose category/payment_method ONLY from provided lists if possible; otherwise empty string.",
    "If amount is unclear, set amount=0 and needs_confirmation=true.",
  ].join(" ");

  const user = {
    instruction: "Extract transaction fields.",
    input_text: text,
    today,
    allowed_categories: ui.categories || [],
    allowed_payment_methods: ui.paymentMethods || [],
    output_schema: schemaHint
  };

  const messages = [
    { role: "system", content: sys },
    { role: "user", content: JSON.stringify(user) }
  ];

  const parsed = callOpenAiJson_(messages, schemaHint, traceId);

  // normalize
  return {
    date: String(parsed.date || today).slice(0, 10),
    amount: Number(parsed.amount || 0),
    merchant: String(parsed.merchant || ""),
    category: String(parsed.category || ""),
    payment_method: String(parsed.payment_method || ""),
    memo: String(parsed.memo || text || ""),
    raw_text: text,
    confidence: Number(parsed.confidence || 0.4),
    needs_confirmation: parsed.needs_confirmation !== false,
    explanation: String(parsed.explanation || "")
  };
}

/**
 * Rule-based draft (fallback)
 */
function ruleDraftFromText_(text, ui) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const t = String(text || "").trim();

  // amount: "2000円" "二千円" はまず数字だけを拾う簡易版（漢数字は後で拡張）
  let amount = 0;
  const m = t.match(/(\d{1,7})\s*(円|えん)/);
  if (m) amount = Number(m[1]);

  // merchant: amount前まで
  let merchant = t;
  if (m && m.index !== undefined) merchant = t.slice(0, m.index).trim();

  return {
    date: today,
    amount,
    merchant,
    category: "",
    payment_method: "",
    memo: t,
    raw_text: t,
    confidence: 0.2,
    needs_confirmation: true,
    explanation: "簡易推定（AI無効/未設定）"
  };
}
