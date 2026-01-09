/**
 * 固定費自動起票モジュール
 * 毎月1日 6:00 に active=TRUE の固定費を 04_Transactions へ自動起票
 * 重複防止: memo フィールドに FIXED:<fixed_id>:YYYY-MM パターンを使用
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
      var amount = Number(row[idxAmount]) || 0;

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
 * ダッシュボード/インサイト取得時に呼び出す
 * @param {string} monthStartISO - YYYY-MM-01形式
 * @returns {Object} { posted: number, skipped: number }
 */
function ensureFixedCostsPostedForMonth_(monthStartISO) {
  const traceId = "FIXED-ENSURE-" + Date.now();

  // 月を解析
  const match = String(monthStartISO).match(/^(\d{4})-(\d{2})/);
  if (!match) {
    Logger.log("[" + traceId + "] 月解析失敗: " + monthStartISO);
    return { posted: 0, skipped: 0, reason: "invalid_month" };
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const ym = year + "-" + String(month).padStart(2, "0");
  const postingDate = ym + "-01";

  Logger.log("[" + traceId + "] 遅延起票開始: ym=" + ym);

  // 当月または過去月のみ起票（未来月は起票しない）
  const now = new Date();
  const targetDate = new Date(year, month - 1, 1);
  if (targetDate > now) {
    Logger.log("[" + traceId + "] 未来月のためスキップ");
    return { posted: 0, skipped: 0, reason: "future_month" };
  }

  // ScriptPropertiesで処理済みチェック（CacheServiceより永続的）
  const props = PropertiesService.getScriptProperties();
  const propKey = "FIXED_POSTED_" + ym;
  if (props.getProperty(propKey) === "1") {
    Logger.log("[" + traceId + "] 処理済み（ScriptProperties）: " + ym);
    return { posted: 0, skipped: 0, reason: "already_processed" };
  }

  // 固定費を取得
  const fixedCosts = listActiveFixedCosts_(traceId);
  Logger.log("[" + traceId + "] アクティブ固定費: " + fixedCosts.length + "件");

  if (fixedCosts.length === 0) {
    props.setProperty(propKey, "1");
    return { posted: 0, skipped: 0, reason: "no_fixed_costs" };
  }

  // 起票済みキーを収集（04_Transactionsのmemoから）
  const postedKeys = collectPostedFixedKeysForMonth_(ym, traceId);
  Logger.log("[" + traceId + "] 起票済みキー: " + postedKeys.size + "件");

  // 未起票の固定費を起票
  let postedCount = 0;
  let skippedCount = 0;

  fixedCosts.forEach(function(fc) {
    const dedupKey = makeFixedDedupKey_(fc.id, ym);

    if (postedKeys.has(dedupKey)) {
      Logger.log("[" + traceId + "] スキップ（起票済み）: " + fc.name);
      skippedCount++;
      return;
    }

    const timestamp = new Date().toISOString();

    // ヘッダー駆動 appendTransactionRow_ 用のオブジェクト形式
    // 04_Transactions のヘッダーと完全一致させる
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
      status: "confirmed",
      created_at: timestamp,
      updated_at: timestamp
    };

    Logger.log("[" + traceId + "] 起票: " + fc.name + " ¥" + fc.amount);

    try {
      appendTransactionRow_(rowObj, traceId);
      postedCount++;
    } catch (e) {
      Logger.log("[" + traceId + "] 起票エラー: " + e.message);
    }
  });

  // 処理済みフラグをセット
  props.setProperty(propKey, "1");

  Logger.log("[" + traceId + "] 遅延起票完了: 起票=" + postedCount + "件, スキップ=" + skippedCount + "件");

  return { posted: postedCount, skipped: skippedCount };
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
