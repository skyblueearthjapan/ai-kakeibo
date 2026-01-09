/**
 * マッピング + 辞書補正 + ステータス判定
 * sheet-mapping.md 準拠
 */

function mapAiToRow_(ai, ctx) {
  const id = generateTxnId_();

  const mapped = {
    id: id,
    date: safeStr_(ai.date),
    type: safeStr_(ai.txn_type),           // Spreadsheet C列は "type"
    account: safeStr_(ai.account),
    merchant: safeStr_(ai.merchant),
    item: safeStr_(ai.item),
    category: safeStr_(ai.category),
    subcategory: safeStr_(ai.subcategory),
    payment_method: safeStr_(ai.payment_method),
    amount: normalizeAmount_(ai.amount),
    memo: safeStr_(ai.memo),
    tags: Array.isArray(ai.tags) ? ai.tags.join(",") : safeStr_(ai.tags),
    source: ctx.source,
    confidence: typeof ai.confidence === "number" ? ai.confidence : 0,
    receipt_file_id: ctx.receiptFileId || "",
    raw_text: ctx.rawText || "",
    status: "",
    __clarification_questions: Array.isArray(ai.clarification_questions) ? ai.clarification_questions : []
  };

  // 辞書補正（02_Categories）
  const corrected = applyCategoryDictionary_(mapped);

  // ステータス判定
  corrected.status = decideStatus_(ai, corrected);

  return corrected;
}

function generateTxnId_() {
  const d = new Date();
  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  const rand = Utilities.getUuid().slice(0, 6);
  return `TXN_${y}${m}${day}_${rand}`;
}

function normalizeAmount_(amount) {
  const n = Number(amount);
  if (!isFinite(n)) return 0;
  return Math.abs(n);
}

function safeStr_(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * 02_Categories.keywords でカテゴリ補正
 */
function applyCategoryDictionary_(mappedRow) {
  const dict = loadCategoryDict_();
  if (!dict || dict.length === 0) return mappedRow;

  const haystack = `${mappedRow.merchant} ${mappedRow.item} ${mappedRow.raw_text}`.toLowerCase();

  let best = null;

  for (const entry of dict) {
    if (!entry.keywords || entry.keywords.length === 0) continue;

    for (const kw of entry.keywords) {
      const k = kw.toLowerCase();
      if (!k) continue;
      if (haystack.indexOf(k) >= 0) {
        const cand = {
          category: entry.category,
          subcategory: entry.subcategory,
          priority: entry.priority,
          kwLen: k.length
        };
        if (!best) best = cand;
        else {
          if (cand.priority > best.priority) best = cand;
          else if (cand.priority === best.priority && cand.kwLen > best.kwLen) best = cand;
        }
      }
    }
  }

  if (best) {
    mappedRow.category = best.category || mappedRow.category;
    mappedRow.subcategory = best.subcategory || mappedRow.subcategory;
  }

  return mappedRow;
}

/**
 * 02_Categories を読み込み（CacheServiceで10分キャッシュ）
 */
function loadCategoryDict_() {
  const cache = CacheService.getScriptCache();
  const key = "CATEGORY_DICT_V1";
  const cached = cache.get(key);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("02_Categories");
  if (!sheet) return [];

  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];

  const header = values[0].map(String);
  const idx = {
    category: header.indexOf("category"),
    subcategory: header.indexOf("subcategory"),
    keywords: header.findIndex(h => h.indexOf("keywords") >= 0),
    priority: header.indexOf("priority")
  };

  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const category = idx.category >= 0 ? safeStr_(row[idx.category]) : "";
    const subcategory = idx.subcategory >= 0 ? safeStr_(row[idx.subcategory]) : "";
    const keywordsRaw = idx.keywords >= 0 ? safeStr_(row[idx.keywords]) : "";
    const priority = idx.priority >= 0 ? Number(row[idx.priority]) : 0;

    const keywords = keywordsRaw
      ? keywordsRaw.split(",").map(s => s.trim()).filter(Boolean)
      : [];

    if (!category && !subcategory && keywords.length === 0) continue;
    out.push({ category, subcategory, keywords, priority: isFinite(priority) ? priority : 0 });
  }

  cache.put(key, JSON.stringify(out), 600);
  return out;
}

/**
 * ステータス判定（sheet-mapping.md準拠）
 */
function decideStatus_(ai, mappedRow) {
  const needsClarification = !!ai.needs_clarification;

  // 1) AIがclarification要求
  if (needsClarification) return "pending";

  // 2) 必須欠損
  if (!mappedRow.type || !mappedRow.category || mappedRow.amount <= 0 || !mappedRow.date) {
    return "pending";
  }

  // 3) confidence低い
  const conf = typeof ai.confidence === "number" ? ai.confidence : 0;
  if (conf < 0.6) return "needs_review";

  // 4) 異常値
  if (mappedRow.amount >= 1000000) return "needs_review";

  return "confirmed";
}
