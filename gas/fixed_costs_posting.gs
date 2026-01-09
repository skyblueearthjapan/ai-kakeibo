/**
 * 固定費自動起票モジュール
 * 毎月1日 6:00 に active=TRUE の固定費を 04_Transactions へ自動起票
 * 方針B: 固定費を取引として実体化し、編集時はupsertで同期
 * 識別: fixed_cost_id, fixed_month カラム + memo(FIXED:<id>:YYYY-MM)
 */

// ════════════════════════════════════════════════════════════════════════════
// ヘルパー関数
// ════════════════════════════════════════════════════════════════════════════

/**
 * 重複チェック用キーを生成
 * @param {string} fixedId - 固定費ID
 * @param {string} ym - YYYY-MM形式の年月
 * @returns {string} FIXED:<fixedId>:YYYY-MM
 */
function makeFixedDedupKey_(fixedId, ym) {
  return "FIXED:" + fixedId + ":" + ym;
}

/**
 * DateオブジェクトからYYYY-MM形式を取得
 * @param {Date} dateObj
 * @returns {string} YYYY-MM
 */
function getYearMonth_(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  return y + "-" + m;
}

/**
 * 起票日を取得（当月1日）
 * @param {Date} now
 * @returns {string} YYYY-MM-DD形式
 */
function getPostingDateForMonth_(now) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return y + "-" + m + "-01";
}

// ════════════════════════════════════════════════════════════════════════════
// Upsert関数（固定費編集時の同期用）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 固定費取引をUpsert（既存があれば更新、なければ作成）
 * @param {Object} fc - 固定費オブジェクト {id, name, amount, category, payment}
 * @param {string} ym - YYYY-MM形式
 * @param {string} traceId
 * @returns {Object} {action: "created"|"updated"|"skipped", txnId: string}
 */
function upsertFixedCostTransaction_(fc, ym, traceId) {
  const sheet = getSs_().getSheetByName("04_Transactions");
  if (!sheet) {
    Logger.log("[" + traceId + "] 04_Transactions シートが存在しません");
    return { action: "skipped", txnId: null };
  }

  const dedupKey = makeFixedDedupKey_(fc.id, ym);
  const postingDate = ym + "-01";
  const timestamp = new Date().toISOString();

  // 既存の固定費取引を検索
  const existing = findFixedCostTransactionRow_(sheet, fc.id, ym, traceId);

  if (existing) {
    // 既存行を更新
    Logger.log("[" + traceId + "] 既存固定費取引を更新: " + fc.name + " row=" + existing.rowNum);
    updateFixedCostTransactionRow_(sheet, existing, fc, dedupKey, timestamp, traceId);
    return { action: "updated", txnId: existing.id };
  } else {
    // 新規作成
    Logger.log("[" + traceId + "] 固定費取引を新規作成: " + fc.name);
    const rowObj = {
      id: generateTransactionId_(),
      date: postingDate,
      type: "expense",
      amount: fc.amount,
      merchant: fc.name,
      item: fc.name,
      category: fc.category || "",
      payment_method: fc.payment || "",
      memo: dedupKey,
      source: "fixed_cost",
      fixed_cost_id: fc.id,
      fixed_month: ym,
      status: "confirmed",
      created_at: timestamp,
      updated_at: timestamp
    };
    appendTransactionRow_(rowObj, traceId);
    return { action: "created", txnId: rowObj.id };
  }
}

/**
 * 固定費取引の既存行を検索
 * @param {Sheet} sheet - 04_Transactionsシート
 * @param {string} fixedCostId - 固定費ID
 * @param {string} ym - YYYY-MM形式
 * @param {string} traceId
 * @returns {Object|null} {rowNum, id, colIndexes} or null
 */
function findFixedCostTransactionRow_(sheet, fixedCostId, ym, traceId) {
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return null;

  const headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  const idxId = headers.indexOf("id");
  const idxMemo = headers.indexOf("memo");
  const idxFixedCostId = headers.indexOf("fixed_cost_id");
  const idxFixedMonth = headers.indexOf("fixed_month");
  const idxAmount = headers.indexOf("amount");
  const idxMerchant = headers.indexOf("merchant");
  const idxItem = headers.indexOf("item");
  const idxCategory = headers.indexOf("category");
  const idxPaymentMethod = headers.indexOf("payment_method");
  const idxUpdatedAt = headers.indexOf("updated_at");

  const dedupKey = makeFixedDedupKey_(fixedCostId, ym);

  // 検索: fixed_cost_id + fixed_month カラム、または memo パターン
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var matched = false;

    // 優先1: fixed_cost_id と fixed_month カラムで検索
    if (idxFixedCostId >= 0 && idxFixedMonth >= 0) {
      var fcId = String(row[idxFixedCostId] || "").trim();
      var fcMonth = String(row[idxFixedMonth] || "").trim();
      if (fcId === fixedCostId && fcMonth === ym) {
        matched = true;
      }
    }

    // 優先2: memo パターンで検索（後方互換）
    if (!matched && idxMemo >= 0) {
      var memo = String(row[idxMemo] || "");
      if (memo === dedupKey) {
        matched = true;
      }
    }

    if (matched) {
      return {
        rowNum: i + 1, // 1-indexed
        id: idxId >= 0 ? String(row[idxId] || "") : "",
        colIndexes: {
          amount: idxAmount,
          merchant: idxMerchant,
          item: idxItem,
          category: idxCategory,
          paymentMethod: idxPaymentMethod,
          updatedAt: idxUpdatedAt,
          fixedCostId: idxFixedCostId,
          fixedMonth: idxFixedMonth,
          memo: idxMemo
        }
      };
    }
  }

  return null;
}

/**
 * 固定費取引行を更新
 * @param {Sheet} sheet
 * @param {Object} existing - findFixedCostTransactionRow_の戻り値
 * @param {Object} fc - 固定費オブジェクト
 * @param {string} dedupKey
 * @param {string} timestamp
 * @param {string} traceId
 */
function updateFixedCostTransactionRow_(sheet, existing, fc, dedupKey, timestamp, traceId) {
  const rowNum = existing.rowNum;
  const cols = existing.colIndexes;

  // 更新対象のセルを個別に更新（列が存在する場合のみ）
  if (cols.amount >= 0) {
    sheet.getRange(rowNum, cols.amount + 1).setValue(fc.amount);
  }
  if (cols.merchant >= 0) {
    sheet.getRange(rowNum, cols.merchant + 1).setValue(fc.name);
  }
  if (cols.item >= 0) {
    sheet.getRange(rowNum, cols.item + 1).setValue(fc.name);
  }
  if (cols.category >= 0) {
    sheet.getRange(rowNum, cols.category + 1).setValue(fc.category || "");
  }
  if (cols.paymentMethod >= 0) {
    sheet.getRange(rowNum, cols.paymentMethod + 1).setValue(fc.payment || "");
  }
  if (cols.updatedAt >= 0) {
    sheet.getRange(rowNum, cols.updatedAt + 1).setValue(timestamp);
  }
  // fixed_cost_id, fixed_month, memo も確実にセット（後方互換のため）
  if (cols.fixedCostId >= 0) {
    sheet.getRange(rowNum, cols.fixedCostId + 1).setValue(fc.id);
  }
  if (cols.fixedMonth >= 0) {
    const ym = dedupKey.split(":")[2]; // FIXED:xxx:YYYY-MM からYYYY-MM抽出
    sheet.getRange(rowNum, cols.fixedMonth + 1).setValue(ym);
  }
  if (cols.memo >= 0) {
    sheet.getRange(rowNum, cols.memo + 1).setValue(dedupKey);
  }

  Logger.log("[" + traceId + "] 更新完了: row=" + rowNum + " amount=" + fc.amount);
}

/**
 * 固定費削除時に当月の取引も削除
 * @param {string} fixedCostId - 削除する固定費ID
 * @param {string} ym - YYYY-MM形式
 * @param {string} traceId
 * @returns {boolean} 削除成功
 */
function deleteFixedCostTransaction_(fixedCostId, ym, traceId) {
  const sheet = getSs_().getSheetByName("04_Transactions");
  if (!sheet) return false;

  const existing = findFixedCostTransactionRow_(sheet, fixedCostId, ym, traceId);
  if (existing) {
    sheet.deleteRow(existing.rowNum);
    Logger.log("[" + traceId + "] 固定費取引を削除: row=" + existing.rowNum);
    return true;
  }
  return false;
}

// ════════════════════════════════════════════════════════════════════════════
// トリガー設定
// ════════════════════════════════════════════════════════════════════════════

/**
 * 毎月1日 6:00 に固定費自動起票を実行するトリガーを設定
 * スプレッドシートのメニューから一度だけ実行してください
 */
function setupMonthlyFixedCostTrigger() {
  // 既存トリガーを削除（重複防止）
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "runMonthlyFixedCostPosting_") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // 新規トリガーを作成: 毎月1日 6:00-7:00
  ScriptApp.newTrigger("runMonthlyFixedCostPosting_")
    .timeBased()
    .onMonthDay(1)
    .atHour(6)
    .create();

  Logger.log("✅ 固定費自動起票トリガーを設定しました（毎月1日 6:00）");
  SpreadsheetApp.getUi().alert("固定費自動起票トリガーを設定しました。\n毎月1日 6:00 に自動実行されます。");
}

/**
 * トリガーを削除
 */
function removeMonthlyFixedCostTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "runMonthlyFixedCostPosting_") {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  Logger.log("🗑️ " + removed + "件のトリガーを削除しました");
  SpreadsheetApp.getUi().alert(removed + "件の固定費自動起票トリガーを削除しました。");
}

// ════════════════════════════════════════════════════════════════════════════
// メイン処理
// ════════════════════════════════════════════════════════════════════════════

/**
 * 毎月の固定費自動起票（トリガーから呼ばれる）
 */
function runMonthlyFixedCostPosting_() {
  const traceId = "FIXED-" + Date.now();
  const now = new Date();
  const ym = getYearMonth_(now);
  const postingDate = getPostingDateForMonth_(now);

  Logger.log("[" + traceId + "] 固定費自動起票開始: " + ym);

  try {
    // 1. active=TRUE の固定費を取得
    const fixedCosts = listActiveFixedCosts_(traceId);
    if (fixedCosts.length === 0) {
      Logger.log("[" + traceId + "] アクティブな固定費がありません");
      return;
    }
    Logger.log("[" + traceId + "] アクティブな固定費: " + fixedCosts.length + "件");

    // 2. 今月すでに起票済みの固定費キーを収集
    const postedKeys = collectPostedFixedKeysForMonth_(ym, traceId);
    Logger.log("[" + traceId + "] 今月起票済み: " + postedKeys.size + "件");

    // 3. 未起票の固定費を起票
    let postedCount = 0;
    let skippedCount = 0;

    fixedCosts.forEach(function(fc) {
      const dedupKey = makeFixedDedupKey_(fc.id, ym);

      if (postedKeys.has(dedupKey)) {
        Logger.log("[" + traceId + "] スキップ（起票済み）: " + fc.name + " [" + dedupKey + "]");
        skippedCount++;
        return;
      }

      // 新規トランザクションを追加（ヘッダー駆動）
      const timestamp = new Date().toISOString();

      const rowObj = {
        id: Utilities.getUuid(),
        date: postingDate,
        type: "expense",
        amount: fc.amount,
        merchant: fc.name,
        category: fc.category || "",
        payment_method: fc.payment || "",
        memo: dedupKey,
        source: "fixed_cost",
        status: "confirmed",
        created_at: timestamp,
        updated_at: timestamp
      };

      appendTransactionRow_(rowObj, traceId);
      Logger.log("[" + traceId + "] 起票: " + fc.name + " ¥" + fc.amount + " [" + dedupKey + "]");
      postedCount++;
    });

    Logger.log("[" + traceId + "] 完了: 起票=" + postedCount + "件, スキップ=" + skippedCount + "件");

  } catch (e) {
    Logger.log("[" + traceId + "] エラー: " + e.message);
    throw e;
  }
}

/**
 * active=TRUE の固定費一覧を取得
 * @param {string} traceId
 * @returns {Array<Object>} 固定費オブジェクトの配列
 */
function listActiveFixedCosts_(traceId) {
  const sheet = getSs_().getSheetByName("07_FixedCosts");
  if (!sheet) {
    Logger.log("[" + traceId + "] 07_FixedCosts シートが存在しません");
    return [];
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    Logger.log("[" + traceId + "] 07_FixedCosts データなし（ヘッダのみ）");
    return [];
  }

  const headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  Logger.log("[" + traceId + "] 07_FixedCosts ヘッダ: " + headers.join(", "));

  const idxId = headers.indexOf("id");
  const idxName = headers.indexOf("name");
  const idxAmount = headers.indexOf("amount");
  const idxCategory = headers.indexOf("category");
  const idxPayment = headers.indexOf("payment");
  const idxActive = headers.indexOf("active");
  const idxMemo = headers.indexOf("memo");

  Logger.log("[" + traceId + "] カラムインデックス: id=" + idxId + ", name=" + idxName + ", amount=" + idxAmount + ", active=" + idxActive);

  const results = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var activeRaw = row[idxActive];
    var activeStr = String(activeRaw).toUpperCase().trim();

    // active判定: TRUE, true, 1, チェックボックスON(boolean true) を有効とみなす
    // FALSE, false, 0, 空, チェックボックスOFF(boolean false) は無効
    var isActive = (activeRaw === true) ||
                   (activeStr === "TRUE") ||
                   (activeStr === "1") ||
                   (activeStr === "YES") ||
                   (activeStr === "ON");

    Logger.log("[" + traceId + "] 行" + (i+1) + ": " + row[idxName] + " active=" + activeRaw + " (" + typeof activeRaw + ") -> isActive=" + isActive);

    if (isActive) {
      var id = String(row[idxId] || "").trim();
      var name = String(row[idxName] || "").trim();

      // amount: 数値 or カンマ入り文字列 "80,000" 両対応
      var amtRaw = row[idxAmount];
      var amount = 0;
      if (typeof amtRaw === "number") {
        amount = amtRaw;
      } else {
        amount = Number(String(amtRaw).replace(/,/g, "").trim());
      }
      if (!isFinite(amount)) amount = 0;

      if (!id || !name || amount <= 0) {
        Logger.log("[" + traceId + "] スキップ（無効データ）: id=" + id + ", name=" + name + ", amount=" + amount);
        continue;
      }

      results.push({
        id: id,
        name: name,
        amount: amount,
        category: String(row[idxCategory] || "").trim(),
        payment: String(row[idxPayment] || "").trim(),
        memo: String(row[idxMemo] || "").trim()
      });
    }
  }

  Logger.log("[" + traceId + "] 有効な固定費: " + results.length + "件");
  return results;
}

/**
 * 指定月に起票済みの固定費キーを収集
 * @param {string} ym - YYYY-MM形式
 * @param {string} traceId
 * @returns {Set<string>} 起票済みキーのセット
 */
function collectPostedFixedKeysForMonth_(ym, traceId) {
  const sheet = getSs_().getSheetByName("04_Transactions");
  if (!sheet) {
    return new Set();
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    return new Set();
  }

  const headers = data[0];
  const idxMemo = headers.indexOf("memo");

  if (idxMemo === -1) {
    Logger.log("[" + traceId + "] memo カラムが見つかりません");
    return new Set();
  }

  const pattern = "FIXED:";
  const suffix = ":" + ym;
  const keys = new Set();

  for (var i = 1; i < data.length; i++) {
    var memo = String(data[i][idxMemo] || "");
    // FIXED:xxx:YYYY-MM パターンにマッチするかチェック
    if (memo.indexOf(pattern) === 0 && memo.indexOf(suffix) !== -1) {
      keys.add(memo);
    }
  }

  return keys;
}

// ════════════════════════════════════════════════════════════════════════════
// 手動実行用（テスト・リカバリ）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 手動で今月分の固定費を起票（テスト用）
 * スプレッドシートのメニューから実行可能
 */
function manualRunFixedCostPosting() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "固定費手動起票",
    "今月分の固定費を手動起票しますか？\n（すでに起票済みのものはスキップされます）",
    ui.ButtonSet.YES_NO
  );

  if (response === ui.Button.YES) {
    runMonthlyFixedCostPosting_();
    ui.alert("完了しました。ログを確認してください。");
  }
}

/**
 * 特定月の固定費を起票（過去月のリカバリ用）
 * @param {number} year - 年
 * @param {number} month - 月 (1-12)
 */
function runFixedCostPostingForMonth(year, month) {
  const traceId = "FIXED-MANUAL-" + Date.now();
  const targetDate = new Date(year, month - 1, 1);
  const ym = getYearMonth_(targetDate);
  const postingDate = year + "-" + String(month).padStart(2, "0") + "-01";

  Logger.log("[" + traceId + "] 固定費手動起票: " + ym);

  // 1. active=TRUE の固定費を取得
  const fixedCosts = listActiveFixedCosts_(traceId);
  if (fixedCosts.length === 0) {
    Logger.log("[" + traceId + "] アクティブな固定費がありません");
    return;
  }

  // 2. 指定月の起票済みキーを収集
  const postedKeys = collectPostedFixedKeysForMonth_(ym, traceId);

  // 3. 未起票の固定費を起票
  let postedCount = 0;

  fixedCosts.forEach(function(fc) {
    const dedupKey = makeFixedDedupKey_(fc.id, ym);

    if (postedKeys.has(dedupKey)) {
      Logger.log("[" + traceId + "] スキップ: " + fc.name);
      return;
    }

    const timestamp = new Date().toISOString();

    const rowObj = {
      id: Utilities.getUuid(),
      date: postingDate,
      type: "expense",
      amount: fc.amount,
      merchant: fc.name,
      category: fc.category || "",
      payment_method: fc.payment || "",
      memo: dedupKey,
      source: "fixed_cost",
      status: "confirmed",
      created_at: timestamp,
      updated_at: timestamp
    };

    appendTransactionRow_(rowObj, traceId);
    postedCount++;
  });

  Logger.log("[" + traceId + "] 完了: " + postedCount + "件起票");
}

// ════════════════════════════════════════════════════════════════════════════
// 遅延起票（ダッシュボード表示時に呼び出す）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 指定月の固定費が起票済みかを確認し、未起票なら起票する（遅延起票）
 * 方針B: Upsert方式（既存があれば更新、なければ作成）
 * ダッシュボード/インサイト取得時に呼び出す
 * @param {string} monthStartISO - YYYY-MM-01形式
 * @returns {Object} { created: number, updated: number, skipped: number }
 */
function ensureFixedCostsPostedForMonth_(monthStartISO) {
  const traceId = "FIXED-ENSURE-" + Date.now();

  // 月を解析
  const match = String(monthStartISO).match(/^(\d{4})-(\d{2})/);
  if (!match) {
    Logger.log("[" + traceId + "] 月解析失敗: " + monthStartISO);
    return { created: 0, updated: 0, skipped: 0, reason: "invalid_month" };
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const ym = year + "-" + String(month).padStart(2, "0");

  Logger.log("[" + traceId + "] 固定費同期開始: ym=" + ym);

  // 当月または過去月のみ処理（未来月は処理しない）
  const now = new Date();
  const targetDate = new Date(year, month - 1, 1);
  if (targetDate > now) {
    Logger.log("[" + traceId + "] 未来月のためスキップ");
    return { created: 0, updated: 0, skipped: 0, reason: "future_month" };
  }

  // 固定費を取得
  const fixedCosts = listActiveFixedCosts_(traceId);
  Logger.log("[" + traceId + "] アクティブ固定費: " + fixedCosts.length + "件");

  if (fixedCosts.length === 0) {
    return { created: 0, updated: 0, skipped: 0, reason: "no_fixed_costs" };
  }

  // 各固定費をUpsert（既存があれば更新、なければ作成）
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  fixedCosts.forEach(function(fc) {
    try {
      const result = upsertFixedCostTransaction_(fc, ym, traceId);
      if (result.action === "created") {
        createdCount++;
      } else if (result.action === "updated") {
        updatedCount++;
      } else {
        skippedCount++;
      }
    } catch (e) {
      Logger.log("[" + traceId + "] Upsertエラー: " + fc.name + " - " + e.message);
      skippedCount++;
    }
  });

  Logger.log("[" + traceId + "] 固定費同期完了: 作成=" + createdCount + "件, 更新=" + updatedCount + "件, スキップ=" + skippedCount + "件");

  return { created: createdCount, updated: updatedCount, skipped: skippedCount };
}

/**
 * 取引が固定費起票かどうかを判定
 * @param {Object} txn - 取引オブジェクト（memoフィールドを持つ）
 * @returns {boolean} 固定費起票ならtrue
 */
function isFixedCostTransaction_(txn) {
  const memo = String(txn.memo || "");
  return memo.indexOf("FIXED:") === 0;
}

/**
 * 固定費の処理済みフラグをリセット（デバッグ/手動再実行用）
 * スクリプトエディタから手動実行
 * @param {string=} ym YYYY-MM形式（省略時は当月）
 */
function resetFixedCostFlag(ym) {
  const props = PropertiesService.getScriptProperties();

  if (!ym) {
    const now = new Date();
    ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  }

  const propKey = "FIXED_POSTED_" + ym;
  props.deleteProperty(propKey);
  Logger.log("✅ 固定費フラグをリセット: " + propKey);

  // UIがあれば通知
  try {
    SpreadsheetApp.getUi().alert("固定費フラグをリセットしました: " + ym + "\n次回分析画面を開くと再起票されます。");
  } catch (e) {
    // WebAppからは呼べないので無視
  }
}

/**
 * 固定費の状態をデバッグ出力
 */
function debugFixedCosts() {
  const now = new Date();
  const ym = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const traceId = "DEBUG-" + Date.now();

  Logger.log("=== 固定費デバッグ ===");
  Logger.log("対象月: " + ym);

  // ScriptProperties確認
  const props = PropertiesService.getScriptProperties();
  const propKey = "FIXED_POSTED_" + ym;
  Logger.log("処理済みフラグ: " + (props.getProperty(propKey) || "未設定"));

  // アクティブ固定費
  const fixedCosts = listActiveFixedCosts_(traceId);
  Logger.log("アクティブ固定費: " + fixedCosts.length + "件");
  fixedCosts.forEach(function(fc) {
    Logger.log("  - " + fc.name + " ¥" + fc.amount + " [" + fc.id + "] active=" + fc.active);
  });

  // 起票済みキー
  const postedKeys = collectPostedFixedKeysForMonth_(ym, traceId);
  Logger.log("起票済みキー: " + postedKeys.size + "件");
  postedKeys.forEach(function(key) {
    Logger.log("  - " + key);
  });

  Logger.log("======================");
}
