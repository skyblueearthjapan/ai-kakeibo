/**
 * idempotency.gs
 * Phase6: 二重送信防止（client_request_idによるデデュープ）
 */

// キャッシュ有効期間（秒）: 10分
const DEDUP_CACHE_TTL = 600;

/**
 * リクエストが処理済みかチェック
 * @param {string} clientRequestId クライアント生成のリクエストID
 * @return {Object|null} 処理済みなら前回結果、未処理ならnull
 */
function checkDuplicate_(clientRequestId) {
  if (!clientRequestId) return null;

  // CacheServiceで短期チェック（高速）
  const cache = CacheService.getScriptCache();
  const cached = cache.get(`dedup_${clientRequestId}`);

  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      return null;
    }
  }

  // 10_Dedupシートで長期チェック（フォールバック）
  const sheet = getDedupSheet_();
  if (!sheet) return null;

  const values = sheet.getDataRange().getValues();
  for (let r = 1; r < values.length; r++) {
    if (values[r][0] === clientRequestId) {
      // 結果を復元
      const resultJson = values[r][2];
      try {
        const result = JSON.parse(resultJson);
        // キャッシュに再設定
        cache.put(`dedup_${clientRequestId}`, resultJson, DEDUP_CACHE_TTL);
        return result;
      } catch (e) {
        return { ok: true, result: { txn_id: values[r][1] } };
      }
    }
  }

  return null;
}

/**
 * リクエストを処理済みとしてマーク
 * @param {string} clientRequestId クライアント生成のリクエストID
 * @param {string} txnId 生成された取引ID
 * @param {Object} result 返却する結果オブジェクト
 */
function markAsProcessed_(clientRequestId, txnId, result) {
  if (!clientRequestId) return;

  const resultJson = JSON.stringify(result);

  // CacheServiceに保存（高速アクセス用）
  const cache = CacheService.getScriptCache();
  cache.put(`dedup_${clientRequestId}`, resultJson, DEDUP_CACHE_TTL);

  // 10_Dedupシートにも保存（永続化）
  try {
    const sheet = getOrCreateDedupSheet_();
    sheet.appendRow([
      clientRequestId,
      txnId || "",
      resultJson,
      new Date().toISOString()
    ]);

    // 古いエントリを削除（1000件超えたら古い順に削除）
    cleanupDedupSheet_(sheet);
  } catch (e) {
    console.warn("Dedup sheet write failed:", e);
  }
}

/**
 * 10_Dedupシートを取得
 */
function getDedupSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName("10_Dedup");
}

/**
 * 10_Dedupシートを取得（なければ作成）
 */
function getOrCreateDedupSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName("10_Dedup");

  if (!sheet) {
    sheet = ss.insertSheet("10_Dedup");
    // ヘッダー追加
    const headers = ["client_request_id", "txn_id", "result_json", "created_at"];
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * 古いデデュープエントリを削除（1000件以上なら古い順に削除）
 */
function cleanupDedupSheet_(sheet) {
  const maxRows = 1000;
  const lastRow = sheet.getLastRow();

  if (lastRow > maxRows + 100) { // 100件バッファ
    const deleteCount = lastRow - maxRows;
    sheet.deleteRows(2, deleteCount); // ヘッダーは残す
  }
}

/**
 * 処理中フラグを立てる（楽観的ロック）
 * @param {string} clientRequestId
 * @return {boolean} フラグ設定成功ならtrue、すでに処理中ならfalse
 */
function tryAcquireProcessingLock_(clientRequestId) {
  if (!clientRequestId) return true; // IDなしは常に許可

  const cache = CacheService.getScriptCache();
  const lockKey = `processing_${clientRequestId}`;

  // すでに処理中かチェック
  if (cache.get(lockKey)) {
    return false;
  }

  // 処理中フラグを立てる（30秒TTL）
  cache.put(lockKey, "1", 30);
  return true;
}

/**
 * 処理中フラグを解除
 */
function releaseProcessingLock_(clientRequestId) {
  if (!clientRequestId) return;

  const cache = CacheService.getScriptCache();
  cache.remove(`processing_${clientRequestId}`);
}
