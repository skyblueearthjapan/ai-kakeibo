/**
 * クレジットカード精算処理
 *
 * 機能：
 * - カード払いの未精算明細を検索
 * - 精算処理（settlement_status を settled に更新）
 * - 差額の計算と警告
 */

/**
 * 指定カードの未精算明細を取得
 * @param {string} cardName カード名（楽天カード、JCBカード等）
 * @return {Object} { items: Array, total: number }
 */
function getUnsettledByCard(cardName) {
  const traceId = makeTraceId_();

  try {
    if (!cardName || String(cardName).trim() === "") {
      return { items: [], total: 0, error: "カード名が指定されていません" };
    }

    const normalizedCard = normalizeCardName_(cardName);
    const sheet = getTxnSheet_();
    const data = sheet.getDataRange().getValues();

    if (data.length < 2) {
      return { items: [], total: 0 };
    }

    const headers = data[0];
    const colIdx = buildColumnIndex_(headers);

    const items = [];
    let total = 0;

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const rowNum = i + 1;

      // settlement_status が unsettled かつ card_name が一致
      const settlementStatus = String(row[colIdx.settlement_status] || "").trim();
      const rowCardName = normalizeCardName_(String(row[colIdx.card_name] || row[colIdx.payment_method] || ""));

      if (settlementStatus === "unsettled" && rowCardName === normalizedCard) {
        const amount = Number(row[colIdx.amount] || 0);
        items.push({
          rowNum: rowNum,
          id: row[colIdx.id],
          date: formatDateForDisplay_(row[colIdx.date]),
          merchant: row[colIdx.merchant] || "",
          item: row[colIdx.item] || "",
          category: row[colIdx.category] || "",
          amount: amount
        });
        total += amount;
      }
    }

    // 日付でソート（新しい順）
    items.sort((a, b) => {
      if (a.date > b.date) return -1;
      if (a.date < b.date) return 1;
      return 0;
    });

    return { items: items, total: total };

  } catch (e) {
    logError_(traceId, "getUnsettledByCard", e);
    return { items: [], total: 0, error: String(e) };
  }
}

/**
 * 精算処理を実行
 * @param {string} cardName カード名
 * @param {number} settledAmount 精算金額（請求金額）
 * @param {string} settledDate 精算日（引き落とし日）
 * @param {Object} options { recordDifference: boolean, differenceCategory: string }
 * @return {Object} 処理結果
 */
function processSettlement(cardName, settledAmount, settledDate, options) {
  const traceId = makeTraceId_();
  const opts = options || {};

  try {
    const normalizedCard = normalizeCardName_(cardName);
    const unsettled = getUnsettledByCard(normalizedCard);

    if (unsettled.error) {
      return { success: false, message: unsettled.error };
    }

    const sheet = getTxnSheet_();
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const colIdx = buildColumnIndex_(headers);

    // 未精算明細を settled に更新
    const settledIds = [];
    for (const item of unsettled.items) {
      const rowNum = item.rowNum;
      // settlement_status 列を更新
      sheet.getRange(rowNum, colIdx.settlement_status + 1).setValue("settled");
      settledIds.push(item.id);
    }

    const difference = settledAmount - unsettled.total;
    let differenceId = null;

    // 差額がある場合
    if (opts.recordDifference && Math.abs(difference) >= 1) {
      // 差額を新規取引として記録
      differenceId = recordDifferenceTransaction_(
        normalizedCard,
        difference,
        settledDate,
        opts.differenceCategory || "その他",
        traceId
      );
    }

    return {
      success: true,
      cardName: normalizedCard,
      settledCount: unsettled.items.length,
      settledTotal: unsettled.total,
      requestedAmount: settledAmount,
      difference: difference,
      differenceId: differenceId,
      settledIds: settledIds,
      message: buildSettlementMessage_(unsettled.items.length, unsettled.total, settledAmount, difference)
    };

  } catch (e) {
    logError_(traceId, "processSettlement", e);
    return { success: false, message: "精算処理に失敗しました: " + String(e) };
  }
}

/**
 * 差額を取引として記録
 */
function recordDifferenceTransaction_(cardName, difference, date, category, traceId) {
  const id = generateTxnId_();
  const sheet = getTxnSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = buildColumnIndex_(headers);

  const txnType = difference > 0 ? "expense" : "income";
  const amount = Math.abs(difference);
  const memo = `${cardName}精算の差額（記帳漏れ分）`;

  const row = new Array(headers.length).fill("");
  row[colIdx.id] = id;
  row[colIdx.date] = date || "";
  row[colIdx.type] = txnType;
  row[colIdx.account] = "";
  row[colIdx.merchant] = cardName;
  row[colIdx.item] = "精算差額";
  row[colIdx.category] = category;
  row[colIdx.subcategory] = "";
  row[colIdx.payment_method] = cardName;
  row[colIdx.amount] = amount;
  row[colIdx.memo] = memo;
  row[colIdx.tags] = "精算差額";
  row[colIdx.source] = "settlement";
  row[colIdx.confidence] = 1;
  row[colIdx.receipt_file_id] = "";
  row[colIdx.raw_text] = "";
  row[colIdx.status] = "confirmed";
  row[colIdx.settlement_status] = "settled";
  row[colIdx.card_name] = cardName;

  sheet.appendRow(row);

  return id;
}

/**
 * 精算結果メッセージを生成
 */
function buildSettlementMessage_(count, recordedTotal, requestedAmount, difference) {
  let msg = `${count}件の明細を精算しました。\n`;
  msg += `記録済み合計: ${recordedTotal.toLocaleString()}円\n`;
  msg += `請求額: ${requestedAmount.toLocaleString()}円\n`;

  if (Math.abs(difference) < 1) {
    msg += "差額なし（ぴったり一致）";
  } else if (difference > 0) {
    msg += `差額: +${difference.toLocaleString()}円（未記帳分）`;
  } else {
    msg += `差額: ${difference.toLocaleString()}円（記録が多い）`;
  }

  return msg;
}

/**
 * カード名を正規化
 */
function normalizeCardName_(name) {
  if (!name) return "";
  let n = String(name).trim();

  // よくある表記ゆれを統一
  n = n.replace(/クレジット|クレカ|カード払い/g, "");
  n = n.replace(/\s+/g, "");

  // カード名の正規化マッピング
  const cardMap = {
    "楽天": "楽天カード",
    "rakuten": "楽天カード",
    "jcb": "JCBカード",
    "JCB": "JCBカード",
    "visa": "VISAカード",
    "VISA": "VISAカード",
    "master": "Masterカード",
    "Master": "Masterカード",
    "マスター": "Masterカード",
    "三井住友": "三井住友カード",
    "イオン": "イオンカード",
    "セゾン": "セゾンカード",
    "エポス": "エポスカード",
    "dカード": "dカード",
    "PayPayカード": "PayPayカード",
    "paypay": "PayPayカード"
  };

  // 部分一致でマッピング
  for (const [key, val] of Object.entries(cardMap)) {
    if (n.toLowerCase().includes(key.toLowerCase())) {
      return val;
    }
  }

  // マッピングになければ「カード」を付加して返す
  if (!n.includes("カード")) {
    n = n + "カード";
  }

  return n;
}

/**
 * 日付を表示用にフォーマット
 */
function formatDateForDisplay_(date) {
  if (!date) return "";
  if (date instanceof Date) {
    return Utilities.formatDate(date, "Asia/Tokyo", "yyyy-MM-dd");
  }
  return String(date);
}

/**
 * 列インデックスを構築
 */
function buildColumnIndex_(headers) {
  const idx = {};
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i]).trim().toLowerCase();
    idx[h] = i;
  }
  return idx;
}

/**
 * カード払い時に settlement_status と card_name を設定
 * (sheets.gs の mapAiToRow_ から呼ばれる)
 */
function setCardSettlementInfo_(mapped, ai) {
  // カード払いかどうかを判定
  const paymentMethod = String(ai.payment_method || mapped.payment_method || "").toLowerCase();
  const isCard = isCardPayment_(paymentMethod);

  if (ai.txn_type === "settlement") {
    // 精算取引の場合
    mapped.settlement_status = "";  // 精算取引自体は settlement_status 不要
    mapped.card_name = normalizeCardName_(ai.card_name || ai.payment_method || "");
  } else if (isCard && ai.txn_type === "expense") {
    // カード払いの支出の場合
    mapped.settlement_status = "unsettled";
    mapped.card_name = normalizeCardName_(ai.payment_method || "");
  } else {
    // 現金・その他の即時決済
    mapped.settlement_status = "";
    mapped.card_name = "";
  }

  return mapped;
}

/**
 * カード払いかどうかを判定
 */
function isCardPayment_(paymentMethod) {
  if (!paymentMethod) return false;
  const pm = paymentMethod.toLowerCase();

  const cardKeywords = [
    "カード", "card", "クレジット", "credit",
    "楽天", "jcb", "visa", "master", "マスター",
    "三井住友", "イオン", "セゾン", "エポス", "dカード", "paypay"
  ];

  return cardKeywords.some(kw => pm.includes(kw.toLowerCase()));
}
