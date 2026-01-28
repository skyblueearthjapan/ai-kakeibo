/**
 * masters.gs
 * マスタデータ管理（カテゴリ/支払方法）
 * 設定K/V (01_SettingsKV) とマスタ (02_Master) を分離
 */

// ════════════════════════════════════════════════════════════════════════════
// シート初期化
// ════════════════════════════════════════════════════════════════════════════

/**
 * マスタ関連シートを確保（なければ作成）
 */
function ensureMasterSheets_() {
  const ss = getSs_();

  // 01_SettingsKV（設定K/V専用）
  if (!ss.getSheetByName("01_SettingsKV")) {
    const kvSheet = ss.insertSheet("01_SettingsKV");
    kvSheet.getRange(1, 1, 1, 2).setValues([["key", "value"]]);
    kvSheet.getRange(1, 1, 1, 2).setFontWeight("bold");
  }

  // 02_Master（カテゴリ/支払方法マスタ）
  if (!ss.getSheetByName("02_Master")) {
    const masterSheet = ss.insertSheet("02_Master");
    masterSheet.getRange(1, 1, 1, 4).setValues([["kind", "name", "sort", "deleted"]]);
    masterSheet.getRange(1, 1, 1, 4).setFontWeight("bold");
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 設定K/V管理
// ════════════════════════════════════════════════════════════════════════════

/**
 * 設定値を取得（01_SettingsKV）
 * @param {string} key
 * @return {*} 値（見つからなければnull）
 */
function getSettingsKV_(key) {
  ensureMasterSheets_();
  const sh = getSs_().getSheetByName("01_SettingsKV");
  const last = sh.getLastRow();
  if (last < 1) return null;

  const values = sh.getRange(1, 1, last, 2).getValues();
  for (const [k, v] of values) {
    if (String(k).trim() === key) return v;
  }
  return null;
}

/**
 * 設定値を保存（01_SettingsKV）
 * @param {string} key
 * @param {*} value
 */
function setSettingsKV_(key, value) {
  ensureMasterSheets_();
  const sh = getSs_().getSheetByName("01_SettingsKV");
  const last = sh.getLastRow();
  const values = last ? sh.getRange(1, 1, last, 2).getValues() : [];

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() === key) {
      sh.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  // 新規追加
  sh.appendRow([key, value]);
}

// ════════════════════════════════════════════════════════════════════════════
// マスタ管理（CATEGORY / PAYMENT）
// ════════════════════════════════════════════════════════════════════════════

/**
 * マスタ一覧を取得（active=falseを除外）
 * @param {string} kind - "CATEGORY" or "PAYMENT"
 * @return {string[]} 名前の配列
 */
function listMasters_(kind) {
  ensureMasterSheets_();
  const sh = getSs_().getSheetByName("02_Master");
  const last = sh.getLastRow();
  if (last < 2) return [];

  const rows = sh.getRange(2, 1, last - 1, 4).getValues();
  const out = [];

  for (const [k, name, sort, deleted] of rows) {
    if (String(k).trim() !== kind) continue;
    if (String(deleted).toLowerCase() === "true") continue;
    const n = String(name || "").trim();
    if (!n) continue;
    out.push({ name: n, sort: Number(sort) || 9999 });
  }

  out.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, "ja"));
  return out.map(x => x.name);
}

/**
 * マスタを追加
 * @param {string} kind - "CATEGORY" or "PAYMENT"
 * @param {string} name - 名前
 * @return {Object} { ok, message }
 */
function addMaster_(kind, name) {
  ensureMasterSheets_();
  const n = String(name || "").trim();
  if (!n) throw new Error("name required");

  const sh = getSs_().getSheetByName("02_Master");

  // 重複チェック
  const existing = listMasters_(kind);
  if (existing.includes(n)) {
    return { ok: true, message: "already exists" };
  }

  // sort値を決定（最大+1）
  const last = sh.getLastRow();
  let maxSort = 0;
  if (last >= 2) {
    const rows = sh.getRange(2, 1, last - 1, 4).getValues();
    for (const [k, , sort] of rows) {
      if (String(k).trim() === kind) {
        maxSort = Math.max(maxSort, Number(sort) || 0);
      }
    }
  }

  sh.appendRow([kind, n, maxSort + 1, false]);
  return { ok: true };
}

/**
 * マスタ名を変更
 * @param {string} kind - "CATEGORY" or "PAYMENT"
 * @param {string} oldName - 旧名
 * @param {string} newName - 新名
 * @param {Object=} options - { propagateToTransactions: boolean }
 * @return {Object} { ok }
 */
function renameMaster_(kind, oldName, newName, options) {
  ensureMasterSheets_();
  const o = String(oldName || "").trim();
  const n = String(newName || "").trim();
  if (!o || !n) throw new Error("old/new required");
  if (o === n) return { ok: true };

  const sh = getSs_().getSheetByName("02_Master");
  const last = sh.getLastRow();
  if (last < 2) throw new Error("master empty");

  // newName重複チェック
  const existing = listMasters_(kind);
  if (existing.includes(n)) throw new Error("newName already exists");

  const rows = sh.getRange(2, 1, last - 1, 4).getValues();
  let updated = false;

  for (let i = 0; i < rows.length; i++) {
    const k = String(rows[i][0]).trim();
    const name = String(rows[i][1] || "").trim();
    const deleted = String(rows[i][3]).toLowerCase() === "true";
    if (deleted) continue;
    if (k === kind && name === o) {
      sh.getRange(i + 2, 2).setValue(n);
      updated = true;
      break;
    }
  }

  if (!updated) throw new Error("oldName not found");

  // 取引データへの追従（オプション）
  if (options?.propagateToTransactions) {
    propagateMasterRenameToTransactions_(kind, o, n);
  }

  return { ok: true };
}

/**
 * マスタを論理削除
 * @param {string} kind - "CATEGORY" or "PAYMENT"
 * @param {string} name - 名前
 * @return {Object} { ok }
 */
function deleteMaster_(kind, name) {
  ensureMasterSheets_();
  const target = String(name || "").trim();
  if (!target) throw new Error("name required");

  const sh = getSs_().getSheetByName("02_Master");
  const last = sh.getLastRow();
  if (last < 2) return { ok: true };

  const rows = sh.getRange(2, 1, last - 1, 4).getValues();
  for (let i = 0; i < rows.length; i++) {
    const k = String(rows[i][0]).trim();
    const nm = String(rows[i][1] || "").trim();
    if (k === kind && nm === target) {
      sh.getRange(i + 2, 4).setValue(true); // deleted=true
      return { ok: true };
    }
  }

  return { ok: true };
}

/**
 * 取引データのカテゴリ/支払方法を一括置換
 * @param {string} kind - "CATEGORY" or "PAYMENT"
 * @param {string} oldName
 * @param {string} newName
 */
function propagateMasterRenameToTransactions_(kind, oldName, newName) {
  const sh = getSheetOrNull_("04_Transactions");
  if (!sh) return;

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return;

  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());

  // kind に応じたカラム名を決定
  const colName = (kind === "CATEGORY") ? "category" : "payment_method";
  const idx = header.indexOf(colName);
  if (idx < 0) return;

  const rng = sh.getRange(2, idx + 1, lastRow - 1, 1);
  const vals = rng.getValues();
  let changed = false;

  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === oldName) {
      vals[i][0] = newName;
      changed = true;
    }
  }

  if (changed) rng.setValues(vals);
}

// ════════════════════════════════════════════════════════════════════════════
// 公開API（UIから呼び出す）
// ════════════════════════════════════════════════════════════════════════════

/**
 * UI -> GAS: マスタデータを取得（新版）
 * @return {Object} { ok, result: { categories, payments } }
 */
function getMasters() {
  const traceId = makeTraceId_();
  try {
    const categories = listMasters_("CATEGORY");
    const payments = listMasters_("PAYMENT");
    return { ok: true, result: { categories, payments } };
  } catch (e) {
    return { ok: false, error: { code: "E_MASTER_LOAD_FAILED", message: String(e), traceId } };
  }
}

/**
 * UI -> GAS: マスタを追加
 * @param {string} kind - "CATEGORY" or "PAYMENT"
 * @param {string} name
 * @return {Object} { ok, result }
 */
function addMaster(kind, name) {
  const traceId = makeTraceId_();
  try {
    const result = addMaster_(kind, name);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: { code: "E_MASTER_ADD_FAILED", message: String(e), traceId } };
  }
}

/**
 * UI -> GAS: マスタ名を変更
 * @param {string} kind
 * @param {string} oldName
 * @param {string} newName
 * @param {boolean=} propagate - 取引データも更新するか（デフォルトtrue）
 * @return {Object} { ok, result }
 */
function renameMaster(kind, oldName, newName, propagate) {
  const traceId = makeTraceId_();
  try {
    const opts = { propagateToTransactions: propagate !== false };
    const result = renameMaster_(kind, oldName, newName, opts);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: { code: "E_MASTER_RENAME_FAILED", message: String(e), traceId } };
  }
}

/**
 * UI -> GAS: マスタを削除（論理削除）
 * @param {string} kind
 * @param {string} name
 * @return {Object} { ok, result }
 */
function deleteMaster(kind, name) {
  const traceId = makeTraceId_();
  try {
    const result = deleteMaster_(kind, name);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: { code: "E_MASTER_DELETE_FAILED", message: String(e), traceId } };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// マイグレーション（1回だけ実行）
// ════════════════════════════════════════════════════════════════════════════

/**
 * 既存の01_Settingsからデータを移行
 * GASエディタで1回だけ実行してください
 */
function migrateSettingsAndMasters() {
  const ss = getSs_();
  ensureMasterSheets_();

  const oldSheet = ss.getSheetByName("01_Settings");
  if (!oldSheet) {
    console.log("01_Settings シートが見つかりません");
    return;
  }

  const lastRow = oldSheet.getLastRow();
  if (lastRow < 1) {
    console.log("01_Settings が空です");
    return;
  }

  const values = oldSheet.getDataRange().getValues();

  // 設定K/V用の予約語
  const reservedKeys = [
    "AI_ENABLED", "AI_PROVIDER",
    "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_TIMEOUT_MS", "OPENAI_MAX_RETRIES",
    "GEMINI_API_KEY", "GEMINI_MODEL",
    "MODEL", "MODEL_TEXT", "MODEL_IMAGE",
    "OCR_ENABLED", "OCR_PROVIDER", "VISION_API_KEY",
    "CURRENCY", "CONFIDENCE_THRESHOLD", "ABNORMAL_AMOUNT_THRESHOLD",
    "FIXED_COST_CATEGORIES", "INCLUDE_UNCONFIRMED_IN_DASHBOARD"
  ];

  const kvSheet = ss.getSheetByName("01_SettingsKV");
  const masterSheet = ss.getSheetByName("02_Master");

  // 既存のマスタデータをクリア（ヘッダー以外）
  const masterLastRow = masterSheet.getLastRow();
  if (masterLastRow > 1) {
    masterSheet.deleteRows(2, masterLastRow - 1);
  }

  let categorySort = 1;
  let paymentSort = 1;
  let kvCount = 0;
  let catCount = 0;
  let payCount = 0;

  // A列: カテゴリ一覧（9行目以降）
  // C列: 支払方法一覧（9行目以降）
  // A列/B列: 設定K/V（予約語にマッチする行）

  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    const colA = String(row[0] || "").trim();
    const colB = row[1];
    const colC = String(row[2] || "").trim();

    // A列が予約語なら設定K/Vとして移行
    if (reservedKeys.includes(colA.toUpperCase())) {
      setSettingsKV_(colA, colB);
      kvCount++;
      continue;
    }

    // 9行目以降のA列をカテゴリとして移行（空でない、予約語でない）
    if (r >= 8 && colA && !reservedKeys.includes(colA.toUpperCase())) {
      // カテゴリとして追加
      const existingCats = listMasters_("CATEGORY");
      if (!existingCats.includes(colA)) {
        masterSheet.appendRow(["CATEGORY", colA, categorySort++, false]);
        catCount++;
      }
    }

    // 9行目以降のC列を支払方法として移行
    if (r >= 8 && colC && !reservedKeys.includes(colC.toUpperCase())) {
      const existingPays = listMasters_("PAYMENT");
      if (!existingPays.includes(colC)) {
        masterSheet.appendRow(["PAYMENT", colC, paymentSort++, false]);
        payCount++;
      }
    }
  }

  console.log(`マイグレーション完了: 設定K/V=${kvCount}件, カテゴリ=${catCount}件, 支払方法=${payCount}件`);

  // 結果をUIに表示
  SpreadsheetApp.getUi().alert(
    "マイグレーション完了",
    `設定K/V: ${kvCount}件\nカテゴリ: ${catCount}件\n支払方法: ${payCount}件`,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/**
 * デフォルトマスタを投入（シートが空の場合）
 */
function ensureDefaultMasters_() {
  const categories = listMasters_("CATEGORY");
  const payments = listMasters_("PAYMENT");

  // カテゴリがなければデフォルトを投入
  if (categories.length === 0) {
    const defaultCategories = [
      "食費", "日用品", "住居", "光熱費", "通信", "交通",
      "医療", "教育", "娯楽", "交際", "衣服", "美容", "その他"
    ];
    defaultCategories.forEach((cat, i) => {
      const sh = getSs_().getSheetByName("02_Master");
      sh.appendRow(["CATEGORY", cat, i + 1, false]);
    });
  }

  // 支払方法がなければデフォルトを投入
  if (payments.length === 0) {
    const defaultPayments = [
      "現金", "クレジットカード", "デビット", "QR/電子マネー",
      "口座振替", "振込", "ポイント"
    ];
    defaultPayments.forEach((pay, i) => {
      const sh = getSs_().getSheetByName("02_Master");
      sh.appendRow(["PAYMENT", pay, i + 1, false]);
    });
  }
}
