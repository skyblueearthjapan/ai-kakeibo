/**
 * ocr.gs
 * Phase7: OCR processing (AI非依存)
 */

/**
 * OCRのエントリーポイント
 * @param {string} base64 画像Base64データ
 * @param {string} mimeType MIMEタイプ
 * @param {string} traceId トレースID
 * @return {{ fullText: string }}
 */
function runOcr_(base64, mimeType, traceId) {
  const provider = getOcrProvider_();

  if (provider === "vision") {
    return visionOcr_(base64, mimeType, traceId);
  }

  // 将来の拡張: Drive OCR等
  return { fullText: "" };
}

/**
 * Google Cloud Vision OCR 呼び出し
 * @param {string} base64 画像Base64データ
 * @param {string} mimeType MIMEタイプ
 * @param {string} traceId トレースID
 * @return {{ fullText: string }}
 */
function visionOcr_(base64, mimeType, traceId) {
  const apiKey = getVisionApiKey_();

  if (!apiKey) {
    console.log(`[${traceId}] Vision API key not configured, OCR skipped`);
    return { fullText: "" }; // OCR無効時は静かにスキップ
  }

  const url = "https://vision.googleapis.com/v1/images:annotate?key=" + apiKey;

  const payload = {
    requests: [{
      image: { content: base64 },
      features: [{ type: "TEXT_DETECTION" }]
    }]
  };

  try {
    const res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (res.getResponseCode() >= 400) {
      console.warn(`[${traceId}] Vision OCR failed: HTTP ${res.getResponseCode()}`);
      return { fullText: "" };
    }

    const json = JSON.parse(res.getContentText());
    const text = json.responses &&
                 json.responses[0] &&
                 json.responses[0].fullTextAnnotation &&
                 json.responses[0].fullTextAnnotation.text;

    return { fullText: text || "" };

  } catch (e) {
    console.warn(`[${traceId}] Vision OCR error: ${e}`);
    return { fullText: "" };
  }
}

/**
 * OCRテキストから TransactionDraft を生成
 * @param {string} fullText OCR抽出テキスト
 * @return {Object} TransactionDraft
 */
function buildDraftFromOcrText_(fullText) {
  return {
    date: extractDate_(fullText),
    amount: extractTotalAmount_(fullText),
    merchant: extractMerchant_(fullText),
    category: "",
    subcategory: "",
    payment_method: "",
    memo: "",
    raw_text: fullText || "",
    confidence: fullText ? 0.3 : 0
  };
}

/** ========== 抽出ヘルパー関数 ========== */

/**
 * 日付を抽出
 * @param {string} text OCRテキスト
 * @return {string} YYYY-MM-DD形式、または空文字
 */
function extractDate_(text) {
  if (!text) return "";

  // パターン1: YYYY/MM/DD or YYYY-MM-DD
  let m = text.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const y = m[1];
    const mm = ("0" + m[2]).slice(-2);
    const dd = ("0" + m[3]).slice(-2);
    return `${y}-${mm}-${dd}`;
  }

  // パターン2: YYYY年MM月DD日
  m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const y = m[1];
    const mm = ("0" + m[2]).slice(-2);
    const dd = ("0" + m[3]).slice(-2);
    return `${y}-${mm}-${dd}`;
  }

  // パターン3: MM/DD（年は当年補完）
  m = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
  if (m) {
    const y = new Date().getFullYear();
    const mm = ("0" + m[1]).slice(-2);
    const dd = ("0" + m[2]).slice(-2);
    // 月が13以上なら無効
    if (Number(m[1]) <= 12 && Number(m[2]) <= 31) {
      return `${y}-${mm}-${dd}`;
    }
  }

  return "";
}

/**
 * 合計金額を抽出（最大値優先）
 * @param {string} text OCRテキスト
 * @return {number} 金額、または0
 */
function extractTotalAmount_(text) {
  if (!text) return 0;

  // 「合計」「計」「お支払」「TOTAL」「税込」周辺の金額を優先
  const totalPatterns = [
    /(?:合計|計|お支払|TOTAL|税込)[^\d]*?(\d{1,3}(?:,\d{3})*)/gi,
    /(\d{1,3}(?:,\d{3})*)[^\d]*?(?:合計|計|円)/gi
  ];

  let maxAmount = 0;

  for (const pattern of totalPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const amt = Number(match[1].replace(/,/g, ""));
      if (amt > maxAmount) maxAmount = amt;
    }
  }

  // 見つからなかった場合、全てのカンマ区切り数字から最大値を取る
  if (maxAmount === 0) {
    const allAmounts = text.match(/\d{1,3}(?:,\d{3})+/g);
    if (allAmounts) {
      for (const s of allAmounts) {
        const amt = Number(s.replace(/,/g, ""));
        if (amt > maxAmount) maxAmount = amt;
      }
    }
  }

  // 小さい数字のみの場合（カンマなし）
  if (maxAmount === 0) {
    const smallAmounts = text.match(/(\d{3,6})円/g);
    if (smallAmounts) {
      for (const s of smallAmounts) {
        const amt = Number(s.replace(/[円,]/g, ""));
        if (amt > maxAmount) maxAmount = amt;
      }
    }
  }

  return maxAmount;
}

/**
 * 店名を抽出（先頭行優先）
 * @param {string} text OCRテキスト
 * @return {string} 店名、または空文字
 */
function extractMerchant_(text) {
  if (!text) return "";

  const lines = text.split("\n").filter(l => l.trim().length > 0);
  if (lines.length === 0) return "";

  // 先頭1〜3行から店名らしきものを探す
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const line = lines[i].trim();

    // 日付・時刻・電話番号っぽい行はスキップ
    if (/^\d{2,4}[\/\-年]/.test(line)) continue;
    if (/^\d{2}:\d{2}/.test(line)) continue;
    if (/^[\d\-\(\)]{8,}$/.test(line)) continue;
    if (/^〒/.test(line)) continue;

    // 長すぎる行は切り詰め
    if (line.length > 40) {
      return line.slice(0, 40);
    }

    // カタカナ/ひらがな/漢字を含む行を店名候補とする
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(line)) {
      return line;
    }

    // アルファベットのみの行も店名候補
    if (/^[A-Za-z\s]+$/.test(line) && line.length >= 2) {
      return line;
    }
  }

  // 見つからなければ先頭行を返す
  return lines[0].slice(0, 40);
}

/**
 * 空のDraftを生成（手入力用）
 * @return {Object} TransactionDraft
 */
function createEmptyDraft_() {
  return {
    date: getCurrentDateISO_(),
    amount: 0,
    merchant: "",
    category: "",
    subcategory: "",
    payment_method: "",
    memo: "",
    raw_text: "",
    confidence: 0
  };
}

/**
 * 現在日付をISO形式で取得
 */
function getCurrentDateISO_() {
  const d = new Date();
  const y = d.getFullYear();
  const m = ("0" + (d.getMonth() + 1)).slice(-2);
  const day = ("0" + d.getDate()).slice(-2);
  return `${y}-${m}-${day}`;
}
