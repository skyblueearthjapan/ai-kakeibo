# データディクショナリー（Spreadsheet / JSON / 正規化ルール）

Version: 0.1
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 1. 基本ルール

- 取引データは **04_Transactions が正本（single source of truth）**
- 月別・カテゴリ別は Transactions から集計で生成（シート分割しない）
- 日付は ISO（YYYY-MM-DD）
- 金額は数値（通貨は 01_Settings.currency）

---

## 2. シート別データ定義

### 2.1 04_Transactions（明細）

| 列 | name | 型 | 例 | 制約/備考 |
|---:|---|---|---|---|
| A | id | string | TXN_20260109_000123 | GAS採番（推奨UUID可） |
| B | date | string/date | 2026-01-08 | 不明なら空、status=pending |
| C | type | enum | expense | expense/income/transfer |
| D | account | string | 現金 | 03_Accounts.account_name 推奨 |
| E | merchant | string | スターバックス | 店名/支払先 |
| F | item | string | ラテ | 品目 |
| G | category | string | 食費 | 01_Settingsカテゴリに準拠 |
| H | subcategory | string | カフェ | 02_Categories参照 |
| I | payment_method | string | 現金 | 01_Settings支払方法に準拠 |
| J | amount | number | 620 | **正の数**（typeで支出/収入を判別） |
| K | memo | string | 朝のコーヒー | 任意 |
| L | tags | string | 家族,臨時 | カンマ区切り |
| M | source | string | text | text/receipt/manual |
| N | confidence | number | 0.82 | 0〜1 |
| O | receipt_file_id | string | 1a2b3c... | Drive fileId |
| P | raw_text | string | 昨日 スタバ 620円 | 監査用 |
| Q | status | enum | confirmed | confirmed/pending/needs_review |

---

### 2.2 02_Categories（分類辞書）

| name | 型 | 例 | 備考 |
|---|---|---|---|
| category | string | 食費 | 大分類 |
| subcategory | string | カフェ | 小分類 |
| keywords | string | スタバ,カフェ,コーヒー | カンマ区切り |
| priority | number | 9 | 競合時優先 |
| budget_group | string | wants | needs/wants/income |
| note | string |  | 任意 |

---

### 2.3 03_Accounts（口座）

| name | 型 | 例 | 備考 |
|---|---|---|---|
| account_name | string | 現金 | 表示名 |
| account_type | string | Cash | Cash/Bank/Card等 |
| opening_balance | number | 0 | 将来残高対応 |
| note | string |  | 任意 |

---

## 3. 正規化ルール（AI→Transactions）

### 3.1 金額
- amountは常に正の数
- typeで支出/収入を分離
  - expense: 支出
  - income: 収入
  - transfer: 振替（将来）

### 3.2 日付
- 入力が「昨日/今日」などの場合は、GASでAsia/Tokyo基準に解釈してISO化
- 不明なら空文字 + status=pending

### 3.3 カテゴリ
- AI推定 → 02_Categoriesのkeywordsで補正（ヒットしたら上書き）
- ヒットしない場合は AI結果を採用し、後で辞書を育てる

### 3.4 ステータス
- confirmed: 必須項目が揃い、confidence基準を満たす
- pending: date/amount/category等が欠ける
- needs_review: confidence低い/異常値/矛盾

---

## 4. 例データ

```json
{
  "id": "TXN_20260109_000123",
  "date": "2026-01-08",
  "type": "expense",
  "account": "現金",
  "merchant": "スターバックス",
  "item": "ラテ",
  "category": "食費",
  "subcategory": "カフェ",
  "payment_method": "現金",
  "amount": 620,
  "memo": "",
  "tags": "日常",
  "source": "text",
  "confidence": 0.82,
  "receipt_file_id": "",
  "raw_text": "昨日 スタバ 620円 ラテ",
  "status": "confirmed"
}
```
