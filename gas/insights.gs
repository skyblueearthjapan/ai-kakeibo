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

  // 方針B: 固定費も04_Transactionsに存在するため、取引から計算
  const fixedCost = computeFixedCost_(thisTxns, fixedCategories);

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
 * 方針B: 04_Transactions から固定費と変動費を分けて計算
 * @param {Object[]} txns - 当月の取引配列
 * @param {string[]} fixedCategories - 固定費カテゴリ（参考用）
 */
function computeFixedCost_(txns, fixedCategories) {
  // 支出のみをフィルタ
  const expenseTxns = txns.filter(function(t) {
    return t.type === "expense";
  });

  // 固定費取引を分離（isFixedCostTransaction_で判定）
  const fixedTxns = expenseTxns.filter(function(t) {
    return isFixedCostTransaction_(t);
  });
  const variableTxns = expenseTxns.filter(function(t) {
    return !isFixedCostTransaction_(t);
  });

  // 固定費合計
  const fixedTotal = fixedTxns.reduce(function(sum, t) {
    return sum + (Number(t.amount) || 0);
  }, 0);

  // 変動費合計
  const variableTotal = variableTxns.reduce(function(sum, t) {
    return sum + (Number(t.amount) || 0);
  }, 0);

  // 支出合計
  const expenseTotal = fixedTotal + variableTotal;

  console.log("[FIXED] 固定費取引数:", fixedTxns.length);
  console.log("[FIXED] fixedTotal:", fixedTotal);
  console.log("[FIXED] variableTotal:", variableTotal);
  console.log("[FIXED] expenseTotal:", expenseTotal);

  // breakdown: 固定費の内訳（取引から生成）
  const breakdown = fixedTxns
    .filter(function(t) { return (Number(t.amount) || 0) > 0; })
    .map(function(t) {
      return {
        category: t.category || "固定費",
        name: t.merchant || t.item || "固定費",
        amount: Math.round(Number(t.amount) || 0)
      };
    })
    .sort(function(a, b) { return b.amount - a.amount; });

  const ratioPct = expenseTotal > 0 ? round1_((fixedTotal / expenseTotal) * 100) : 0;
  console.log("[FIXED] ratio%:", ratioPct);

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

// 方針B: getActiveFixedCostsForInsights_ は不要（04_Transactionsから計算するため削除）

function getDefaultFixedCategories_() {
  // MVP: よくある固定費カテゴリ。将来 01_Settings で設定化可能。
  return ["住居", "光熱費", "通信", "保険", "サブスク"];
}

function round1_(n) {
  return Math.round(n * 10) / 10;
}
