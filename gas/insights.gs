/**
 * insights.gs
 * Phase5 insights aggregation.
 */

/**
 * Build insights result.
 * @param {Object[]} txns TransactionRow[]
 * @param {string} monthStartISO
 * @param {Object=} opts {includeUnconfirmed?:boolean, fixedCategories?:string[]}
 */
function buildInsights_(txns, monthStartISO, opts) {
  opts = opts || {};
  const includeUnconfirmed = !!opts.includeUnconfirmed;
  const fixedCategories = Array.isArray(opts.fixedCategories) && opts.fixedCategories.length
    ? opts.fixedCategories
    : getDefaultFixedCategories_();

  const monthStart = parseISODate_(monthStartISO);
  if (!monthStart) throw new Error("Invalid monthStart: " + monthStartISO);

  const prevMonthStart = addMonths_(monthStart, -1);
  const nextMonthStart = addMonths_(monthStart, 1);
  const prevNextMonthStart = addMonths_(prevMonthStart, 1);

  const thisTxns = filterTxnsMonth_(txns, monthStart, nextMonthStart, includeUnconfirmed);
  const prevTxns = filterTxnsMonth_(txns, prevMonthStart, prevNextMonthStart, includeUnconfirmed);

  // Expense totals (confirmed only by default)
  const thisExpense = sumByType_(thisTxns, "expense");
  const prevExpense = sumByType_(prevTxns, "expense");

  const delta = thisExpense - prevExpense;
  const deltaPct = prevExpense > 0 ? round1_((delta / prevExpense) * 100) : null;

  const summary = {
    expense: Math.round(thisExpense),
    prev_expense: Math.round(prevExpense),
    delta: Math.round(delta),
    delta_pct: deltaPct
  };

  // category maps for expense（全支出：サマリー・固定費計算用）
  const thisCat = sumExpenseByCategory_(thisTxns);
  const prevCat = sumExpenseByCategory_(prevTxns);

  // 変動費のみのカテゴリマップ（Top3用：固定費を除外）
  const thisCatVariable = sumExpenseByCategory_(thisTxns, true);
  const prevCatVariable = sumExpenseByCategory_(prevTxns, true);

  // Top3は変動費のみで計算
  const diffListVariable = buildCategoryDiff_(thisCatVariable, prevCatVariable);

  const overspendTop3 = diffListVariable
    .filter(x => x.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);

  const savingsTop3 = diffListVariable
    .filter(x => x.delta < 0)
    .sort((a, b) => a.delta - b.delta) // more negative first
    .slice(0, 3);

  const fixedCost = computeFixedCost_(thisCat, thisExpense, fixedCategories);

  return {
    monthStart: monthStartISO,
    prevMonthStart: isoMonthStart_(prevMonthStart),
    summary,
    overspendTop3,
    savingsTop3,
    fixedCost
  };
}

/** month filter */
function filterTxnsMonth_(txns, start, end, includeUnconfirmed) {
  return txns.filter(t => {
    const d = parseISODate_(t.date);
    if (!d) return false;
    if (d < start || d >= end) return false;
    if (!includeUnconfirmed && t.status !== "confirmed") return false;
    return true;
  });
}

/** sum for a type */
function sumByType_(txns, type) {
  let s = 0;
  for (const t of txns) {
    if (t.type !== type) continue;
    s += Number(t.amount) || 0;
  }
  return s;
}

/**
 * expense by category map
 * @param {Object[]} txns Transaction array
 * @param {boolean=} excludeFixedCosts If true, exclude fixed cost transactions (for Top3)
 */
function sumExpenseByCategory_(txns, excludeFixedCosts) {
  const map = {};
  for (const t of txns) {
    if (t.type !== "expense") continue;
    // 固定費除外オプション（Top3用）
    if (excludeFixedCosts && isFixedCostTransaction_(t)) continue;
    const cat = (t.category || "その他").trim() || "その他";
    map[cat] = (map[cat] || 0) + (Number(t.amount) || 0);
  }
  return map;
}

/**
 * Build list of category diffs.
 * Output items: {category, this, prev, delta, delta_pct}
 */
function buildCategoryDiff_(thisMap, prevMap) {
  const cats = new Set([...Object.keys(thisMap), ...Object.keys(prevMap)]);
  const out = [];

  cats.forEach(cat => {
    const a = Number(thisMap[cat] || 0);
    const b = Number(prevMap[cat] || 0);
    const d = a - b;
    const pct = b > 0 ? round1_((d / b) * 100) : (a > 0 ? null : 0);

    out.push({
      category: cat,
      this: Math.round(a),
      prev: Math.round(b),
      delta: Math.round(d),
      delta_pct: pct
    });
  });

  // optional: remove tiny categories where both are 0
  return out.filter(x => !(x.this === 0 && x.prev === 0));
}

/**
 * Fixed cost ratio and breakdown.
 * 07_FixedCosts シートから直接読み込んで計算（カテゴリベースではなく）
 * @param {number} txnExpenseTotal - 04_Transactions の支出合計
 */
function computeFixedCost_(thisCatMap, txnExpenseTotal, fixedCategories) {
  // 07_FixedCosts シートから active=TRUE の固定費を全件取得
  const fixedCosts = getActiveFixedCostsForInsights_();

  // デバッグログ
  console.log("[FIXED] rows=", fixedCosts.length);

  // active=TRUE の固定費を全件合算（reduce の初期値 0 必須）
  const fixedTotal = fixedCosts.reduce(function(sum, r) {
    return sum + (Number(r.amount) || 0);
  }, 0);

  console.log("[FIXED] fixedTotal=", fixedTotal);
  console.log("[FIXED] txnExpenseTotal=", txnExpenseTotal);

  // breakdown: 固定費の内訳
  const breakdown = fixedCosts
    .filter(function(r) { return (Number(r.amount) || 0) > 0; })
    .map(function(r) {
      return {
        category: r.category || "固定費",
        name: r.name,
        amount: Math.round(Number(r.amount) || 0)
      };
    })
    .sort(function(a, b) { return b.amount - a.amount; });

  // 変動費 = Transactions の支出合計（固定費は別管理なので含まない）
  const variableTotal = txnExpenseTotal;

  // 支出合計 = 固定費 + 変動費
  const expenseTotal = fixedTotal + variableTotal;
  console.log("[FIXED] variableTotal=", variableTotal);
  console.log("[FIXED] expenseTotal (fixed+variable)=", expenseTotal);

  const ratioPct = expenseTotal > 0 ? round1_((fixedTotal / expenseTotal) * 100) : 0;
  console.log("[FIXED] ratio%=", ratioPct);

  return {
    categories: fixedCategories,
    this_total: Math.round(fixedTotal),
    variable_total: Math.round(variableTotal),
    expense_total: Math.round(expenseTotal),
    this_ratio_pct: ratioPct,
    breakdown,
    // ドーナツグラフ用データ
    pie: {
      labels: ["固定費", "変動費"],
      values: [Math.round(fixedTotal), Math.round(variableTotal)]
    }
  };
}

/**
 * 07_FixedCosts から active=TRUE の固定費を取得（インサイト用）
 */
function getActiveFixedCostsForInsights_() {
  const ss = getSs_();
  const sheet = ss.getSheetByName("07_FixedCosts");
  if (!sheet) {
    console.log("[FIXED] 07_FixedCosts シートが存在しません");
    return [];
  }

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) {
    console.log("[FIXED] 07_FixedCosts データなし（ヘッダのみ）");
    return [];
  }

  const headers = data[0].map(function(h) { return String(h).trim().toLowerCase(); });
  const idxName = headers.indexOf("name");
  const idxAmount = headers.indexOf("amount");
  const idxCategory = headers.indexOf("category");
  const idxActive = headers.indexOf("active");

  // 必須列チェック
  if (idxAmount < 0) {
    console.log("[FIXED] ERROR: amount列が見つかりません");
    return [];
  }
  if (idxActive < 0) {
    console.log("[FIXED] ERROR: active列が見つかりません");
    return [];
  }

  const results = [];
  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    var activeRaw = row[idxActive];
    var activeStr = String(activeRaw).toUpperCase().trim();

    // active判定
    var isActive = (activeRaw === true) ||
                   (activeStr === "TRUE") ||
                   (activeStr === "1") ||
                   (activeStr === "YES") ||
                   (activeStr === "ON");

    if (isActive) {
      var name = String(row[idxName] || "").trim();

      // amount: 数値 or カンマ入り文字列 "80,000" 両対応
      var amtRaw = row[idxAmount];
      var amt = 0;
      if (typeof amtRaw === "number") {
        amt = amtRaw;
      } else {
        // 文字列の場合：カンマ除去して数値化
        amt = Number(String(amtRaw).replace(/,/g, "").trim());
      }
      if (!isFinite(amt)) amt = 0;

      console.log("[FIXED] 行" + (i+1) + ": " + name + " ¥" + amt + " (raw=" + amtRaw + ", type=" + typeof amtRaw + ") active=" + activeRaw);

      if (name && amt > 0) {
        results.push({
          name: name,
          amount: amt,
          category: String(row[idxCategory] || "").trim()
        });
      }
    }
  }

  var total = results.reduce(function(s,r){return s+r.amount;},0);
  console.log("[FIXED] 有効な固定費: " + results.length + "件, 合計: ¥" + total);
  return results;
}

function getDefaultFixedCategories_() {
  // MVP: よくある固定費カテゴリ。将来 01_Settings で設定化可能。
  return ["住居", "光熱費", "通信", "保険", "サブスク"];
}

function round1_(n) {
  return Math.round(n * 10) / 10;
}
