/**
 * エラーハンドリング（error-handling.md準拠）
 */

function makeAppError_(code, message, traceId, retryable, userMessage) {
  const e = new Error(message);
  e.__app_error = true;
  e.code = code;
  e.traceId = traceId;
  e.retryable = retryable;
  e.userMessage = userMessage;
  return e;
}

function normalizeError_(err, traceId) {
  if (err && err.__app_error) {
    return {
      code: err.code || "E_UNKNOWN",
      message: err.message || String(err),
      retryable: !!err.retryable,
      userMessage: err.userMessage || "エラーが発生しました。"
    };
  }

  const msg = err && err.message ? err.message : String(err);

  // APIキー未設定
  if (msg.indexOf("Missing script property: OPENAI_API_KEY") >= 0) {
    return {
      code: "E_GAS_RUNTIME",
      message: msg,
      retryable: false,
      userMessage: "設定エラーです。管理者がAPIキー設定を確認してください。"
    };
  }

  return {
    code: "E_UNKNOWN",
    message: msg,
    retryable: false,
    userMessage: "エラーが発生しました。時間をおいて再度お試しください。"
  };
}
