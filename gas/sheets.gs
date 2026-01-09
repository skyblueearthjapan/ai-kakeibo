/**
 * スプレッドシート操作
 * 書き込み先は 04_Transactions のみ（設計仕様準拠）
 */

function appendTransactionRow_(mappedRow, traceId) {
  return withSheetLock_(() => {
    const sheet = getSheetByName_("04_Transactions");

    // 列順 A..Q（data-dictionary.md準拠）
    const row = [
      mappedRow.id,                   // A id
      mappedRow.date || "",           // B date
      mappedRow.type || "",           // C type
      mappedRow.account || "",        // D account
      mappedRow.merchant || "",       // E merchant
      mappedRow.item || "",           // F item
      mappedRow.category || "",       // G category
      mappedRow.subcategory || "",    // H subcategory
      mappedRow.payment_method || "", // I payment_method
      mappedRow.amount || 0,          // J amount
      mappedRow.memo || "",           // K memo
      mappedRow.tags || "",           // L tags
      mappedRow.source || "",         // M source
      mappedRow.confidence || "",     // N confidence
      mappedRow.receipt_file_id || "",// O receipt_file_id
      mappedRow.raw_text || "",       // P raw_text
      mappedRow.status || ""          // Q status
    ];

    try {
      sheet.appendRow(row);
    } catch (e) {
      throw makeAppError_(
        "E_SHEET_WRITE_FAILED",
        `appendRow failed: ${e}`,
        traceId,
        true,
        "保存に失敗しました。もう一度お試しください。"
      );
    }

    return mappedRow.id;
  });
}

function getSheetByName_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error(`Sheet not found: ${name}`);
  return sheet;
}

function withSheetLock_(fn) {
  const lock = LockService.getScriptLock();
  const ok = lock.tryLock(5000);
  if (!ok) {
    throw makeAppError_("E_SHEET_WRITE_FAILED", "Could not acquire lock", "NO_TRACE", true, "処理が混み合っています。もう一度お試しください。");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Drive保存（receipt_file_id用）
 */
function saveReceiptToDrive_(base64, mimeType) {
  const bytes = Utilities.base64Decode(base64);
  const ext = mimeType.indexOf("png") >= 0 ? "png" : "jpg";
  const blob = Utilities.newBlob(bytes, mimeType, `receipt_${Date.now()}.${ext}`);
  const file = DriveApp.createFile(blob);
  return file.getId();
}
