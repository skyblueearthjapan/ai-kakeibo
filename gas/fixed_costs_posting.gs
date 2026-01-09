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
    return [];
  }

  const headers = data[0];
  const idxId = headers.indexOf("id");
  const idxName = headers.indexOf("name");
  const idxAmount = headers.indexOf("amount");
  const idxCategory = headers.indexOf("category");
  const idxPayment = headers.indexOf("payment");
  const idxActive = headers.indexOf("active");
  const idxMemo = headers.indexOf("memo");

  const results = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var active = row[idxActive];

    // active=TRUE のみ
    if (active === true || active === "TRUE" || active === "true" || active === 1) {
      results.push({
        id: row[idxId],
        name: row[idxName],
        amount: Number(row[idxAmount]) || 0,
        category: row[idxCategory] || "",
        payment: row[idxPayment] || "",
        memo: row[idxMemo] || ""
      });
    }
  }

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
    return { posted: 0, skipped: 0 };
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const ym = year + "-" + String(month).padStart(2, "0");
  const postingDate = ym + "-01";

  // 当月または過去月のみ起票（未来月は起票しない）
  const now = new Date();
  const targetDate = new Date(year, month - 1, 1);
  if (targetDate > now) {
    return { posted: 0, skipped: 0, reason: "future_month" };
  }

  // CacheServiceで重複実行を防止（同月の起票チェックは1時間に1回）
  const cache = CacheService.getScriptCache();
  const cacheKey = "fixed_costs_posted_" + ym;
  const cached = cache.get(cacheKey);
  if (cached === "done") {
    return { posted: 0, skipped: 0, reason: "already_checked" };
  }

  // 固定費を取得
  const fixedCosts = listActiveFixedCosts_(traceId);
  if (fixedCosts.length === 0) {
    cache.put(cacheKey, "done", 3600); // 1時間キャッシュ
    return { posted: 0, skipped: 0, reason: "no_fixed_costs" };
  }

  // 起票済みキーを収集
  const postedKeys = collectPostedFixedKeysForMonth_(ym, traceId);

  // 未起票の固定費を起票
  let postedCount = 0;
  let skippedCount = 0;

  fixedCosts.forEach(function(fc) {
    const dedupKey = makeFixedDedupKey_(fc.id, ym);

    if (postedKeys.has(dedupKey)) {
      skippedCount++;
      return;
    }

    const timestamp = new Date().toISOString();

    // ヘッダー駆動 appendTransactionRow_ 用のオブジェクト形式
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

  // キャッシュに記録
  cache.put(cacheKey, "done", 3600);

  if (postedCount > 0) {
    Logger.log("[" + traceId + "] 遅延起票完了: " + ym + " 起票=" + postedCount + "件");
  }

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
