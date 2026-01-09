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

/** ========== Phase 3: 取得・更新系ユーティリティ ========== */

/**
 * 04_Transactions の全データを取得（ヘッダー含む）
 */
function getTransactionsAllValues_() {
  const sheet = getSheetByName_("04_Transactions");
  return sheet.getDataRange().getValues();
}

/**
 * ヘッダー行から列名→インデックスのマップを作成
 */
function buildTransactionsHeaderIndex_(headerRow) {
  const idx = {};
  for (let i = 0; i < headerRow.length; i++) {
    const name = String(headerRow[i]).trim().toLowerCase();
    if (name) idx[name] = i;
  }
  return idx;
}

/**
 * 行データをオブジェクトに変換
 */
function rowToObject_(row, idxMap) {
  return {
    id: safeStr_(row[idxMap["id"]]),
    date: formatDate_(row[idxMap["date"]]),
    type: safeStr_(row[idxMap["type"]]),
    account: safeStr_(row[idxMap["account"]]),
    merchant: safeStr_(row[idxMap["merchant"]]),
    item: safeStr_(row[idxMap["item"]]),
    category: safeStr_(row[idxMap["category"]]),
    subcategory: safeStr_(row[idxMap["subcategory"]]),
    payment_method: safeStr_(row[idxMap["payment_method"]]),
    amount: Number(row[idxMap["amount"]]) || 0,
    memo: safeStr_(row[idxMap["memo"]]),
    tags: safeStr_(row[idxMap["tags"]]),
    source: safeStr_(row[idxMap["source"]]),
    confidence: Number(row[idxMap["confidence"]]) || 0,
    receipt_file_id: safeStr_(row[idxMap["receipt_file_id"]]),
    raw_text: safeStr_(row[idxMap["raw_text"]]),
    status: safeStr_(row[idxMap["status"]])
  };
}

/**
 * 日付を YYYY-MM-DD 形式に変換
 */
function formatDate_(value) {
  if (!value) return "";
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = ("0" + (value.getMonth() + 1)).slice(-2);
    const d = ("0" + value.getDate()).slice(-2);
    return `${y}-${m}-${d}`;
  }
  return safeStr_(value);
}

/**
 * 日付が指定月内かどうか判定
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} monthStart YYYY-MM-DD（月初）
 * @returns {boolean}
 */
function isInMonth_(dateStr, monthStart) {
  if (!dateStr || !monthStart) return false;

  const date = new Date(dateStr);
  const start = new Date(monthStart);

  if (isNaN(date.getTime()) || isNaN(start.getTime())) return false;

  // 月末を計算（翌月1日の前日）
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);

  return date >= start && date < end;
}

/**
 * IDで該当行番号を検索（1-indexed、ヘッダー=1）
 * @returns {number|null} 見つかった行番号、見つからなければnull
 */
function findRowById_(id, values, idxMap) {
  const idCol = idxMap["id"];
  for (let r = 1; r < values.length; r++) {
    if (safeStr_(values[r][idCol]) === id) {
      return r + 1; // シートは1-indexed
    }
  }
  return null;
}

/**
 * パッチを検証
 */
function validatePatch_(patch, traceId) {
  if (patch.amount !== undefined) {
    const amt = Number(patch.amount);
    if (isNaN(amt) || amt < 0) {
      throw makeAppError_("E_BAD_REQUEST", "Invalid amount", traceId, false, "金額が不正です。");
    }
  }

  if (patch.date !== undefined && patch.date !== "") {
    const d = new Date(patch.date);
    if (isNaN(d.getTime())) {
      throw makeAppError_("E_BAD_REQUEST", "Invalid date format", traceId, false, "日付形式が不正です。YYYY-MM-DD で入力してください。");
    }
  }

  if (patch.status !== undefined) {
    const valid = ["confirmed", "pending", "needs_review"];
    if (!valid.includes(patch.status)) {
      throw makeAppError_("E_BAD_REQUEST", "Invalid status", traceId, false, "ステータスが不正です。");
    }
  }

  return true;
}

/**
 * パッチを行に適用
 * @param {Sheet} sheet
 * @param {number} rowNumber 1-indexed
 * @param {Object} idxMap
 * @param {Object} patch
 */
function applyPatchToRow_(sheet, rowNumber, idxMap, patch) {
  // 許可するフィールド（ホワイトリスト）
  const allowedFields = [
    "date", "type", "account", "merchant", "item",
    "category", "subcategory", "payment_method",
    "amount", "memo", "tags", "status"
  ];

  for (const field of allowedFields) {
    if (patch[field] !== undefined) {
      const colIndex = idxMap[field];
      if (colIndex !== undefined) {
        let value = patch[field];
        // amountは数値に変換
        if (field === "amount") {
          value = Number(value) || 0;
        }
        sheet.getRange(rowNumber, colIndex + 1).setValue(value);
      }
    }
  }
}

/**
 * 当月の月初を取得（Asia/Tokyo）
 */
function getCurrentMonthStart_() {
  const now = new Date();
  const y = now.getFullYear();
  const m = ("0" + (now.getMonth() + 1)).slice(-2);
  return `${y}-${m}-01`;
}

/** ========== Phase 4: ダッシュボード用ユーティリティ ========== */

/**
 * 04_Transactions の全行をObject配列で取得
 * @param {string} traceId
 * @return {Object[]} 全取引オブジェクト配列
 */
function getAllTransactionsAsObjects_(traceId) {
  const values = getTransactionsAllValues_();
  if (values.length <= 1) return [];

  const idxMap = buildTransactionsHeaderIndex_(values[0]);
  const rows = [];

  for (let r = 1; r < values.length; r++) {
    rows.push(rowToObject_(values[r], idxMap));
  }

  return rows;
}

/**
 * 01_Settings から通貨設定を取得
 * @return {string} 通貨コード（例: "JPY"）
 */
function getSettingsCurrency_() {
  try {
    const sheet = getSheetByName_("01_Settings");
    const values = sheet.getDataRange().getValues();

    // key=currency の行を探す
    for (let r = 0; r < values.length; r++) {
      const key = String(values[r][0]).toLowerCase().trim();
      if (key === "currency") {
        return String(values[r][1]).trim() || "JPY";
      }
    }
    return "JPY";
  } catch (e) {
    return "JPY";
  }
}
