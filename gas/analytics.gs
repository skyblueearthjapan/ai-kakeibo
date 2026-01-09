/**
 * analytics.gs
 * Dashboard aggregation for Phase4.
 * Source: 04_Transactions only.
 */

/**
 * Build dashboard result from transactions.
 * @param {Object[]} txns all transactions rows (object)
 * @param {string} monthStartISO "YYYY-MM-01"
 * @param {Object=} opts
 * @return {Object} {kpi, byCategory, trend12m}
 */
function buildDashboard_(txns, monthStartISO, opts) {
  opts = opts || {};
  const includeUnconfirmed = !!opts.includeUnconfirmed;

  const monthStart = parseISODate_(monthStartISO);
  if (!monthStart) throw new Error("Invalid monthStart: " + monthStartISO);

  const nextMonthStart = addMonths_(monthStart, 1);

  // Filter confirmed only by default
  const monthTxns = txns.filter(t => {
    const d = parseISODate_(t.date);
    if (!d) return false;
    if (d < monthStart || d >= nextMonthStart) return false;
    if (!includeUnconfirmed && t.status !== "confirmed") return false;
    return true;
  });

  const kpi = computeKpi_(monthTxns);
  const byCategory = computeByCategory_(monthTxns);
  const trend12m = computeTrend12m_(txns, monthStart, { includeUnconfirmed });

  return { kpi, byCategory, trend12m };
}

/**
 * KPI: expense/income/net for a month
 * @param {Object[]} monthTxns
 */
function computeKpi_(monthTxns) {
  let expense = 0;
  let income = 0;

  for (const t of monthTxns) {
    const amt = Number(t.amount) || 0;
    if (t.type === "expense") expense += amt;
    else if (t.type === "income") income += amt;
  }
  return {
    expense: Math.round(expense),
    income: Math.round(income),
    net: Math.round(income - expense)
  };
}

/**
 * Category breakdown (expense only), sorted desc
 * @param {Object[]} monthTxns
 */
function computeByCategory_(monthTxns) {
  const map = {};
  for (const t of monthTxns) {
    if (t.type !== "expense") continue;
    const cat = (t.category || "その他").trim() || "その他";
    const amt = Number(t.amount) || 0;
    map[cat] = (map[cat] || 0) + amt;
  }

  const arr = Object.keys(map).map(cat => ({
    category: cat,
    amount: Math.round(map[cat])
  }));

  arr.sort((a, b) => b.amount - a.amount);
  return arr;
}

/**
 * Trend for last 12 months ending at monthStart (inclusive)
 * Returns 12 points: oldest -> newest
 * @param {Object[]} txns all txns
 * @param {Date} monthStart
 * @param {Object} opts
 */
function computeTrend12m_(txns, monthStart, opts) {
  opts = opts || {};
  const includeUnconfirmed = !!opts.includeUnconfirmed;

  // build month starts for last 12 months
  const months = [];
  for (let i = 11; i >= 0; i--) {
    months.push(addMonths_(monthStart, -i));
  }

  // init sums
  const sums = {};
  for (const m of months) {
    sums[isoMonthStart_(m)] = 0;
  }

  // sum expense per month
  for (const t of txns) {
    if (t.type !== "expense") continue;
    if (!includeUnconfirmed && t.status !== "confirmed") continue;

    const d = parseISODate_(t.date);
    if (!d) continue;

    const m = new Date(d.getFullYear(), d.getMonth(), 1);
    const key = isoMonthStart_(m);
    if (key in sums) {
      sums[key] += Number(t.amount) || 0;
    }
  }

  return months.map(m => {
    const key = isoMonthStart_(m);
    return { month: key, expense: Math.round(sums[key] || 0) };
  });
}

/** ---------- Date helpers ---------- */

/**
 * Parse "YYYY-MM-DD" into Date (local timezone).
 * Returns null if invalid / empty.
 */
function parseISODate_(s) {
  if (!s) return null;
  const str = String(s).trim();

  // Handle Date objects from Spreadsheet
  if (s instanceof Date) {
    return isNaN(s.getTime()) ? null : s;
  }

  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d);
  // validate
  if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
  return dt;
}

function addMonths_(dateObj, deltaMonths) {
  return new Date(dateObj.getFullYear(), dateObj.getMonth() + deltaMonths, 1);
}

function isoMonthStart_(dateObj) {
  const y = dateObj.getFullYear();
  const m = ("0" + (dateObj.getMonth() + 1)).slice(-2);
  return `${y}-${m}-01`;
}
