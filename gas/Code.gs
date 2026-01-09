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
