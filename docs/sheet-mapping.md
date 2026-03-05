# AI出力JSON → Spreadsheet（04_Transactions）マッピング仕様

Version: 0.1
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 1. 目的

OpenAI（受付AI）が返す **TransactionAI JSON** を、Googleスプレッドシートの
`04_Transactions` の1行へ確実に変換し、記帳品質（整合性・追跡可能性）を担保する。

---

## 2. 前提

- AI出力は `api-contract.md` の JSON Schema（TransactionAI）に準拠する
- `04_Transactions` が唯一の正本（single source of truth）
- 金額 `amount` は **常に正の数**（支出/収入は `txn_type` で区別）
- 日付不明・支払方法不明等は `status=pending` として保存し、UIで追完する

---

## 3. AI出力JSON（入力）

### 3.1 TransactionAI（要約）
```json
{
  "type": "transaction",
  "date": "2026-01-08",
  "txn_type": "expense",
  "account": "現金",
  "merchant": "スターバックス",
  "item": "ラテ",
  "category": "食費",
  "subcategory": "カフェ",
  "payment_method": "現金",
  "amount": 620,
  "memo": "",
  "tags": ["日常"],
  "confidence": 0.82,
  "needs_clarification": false,
  "clarification_questions": []
}
```

---

## 4. 04_Transactions（出力）列定義

| 列 | 列名 |
|---|---|
| A | id |
| B | date |
| C | type |
| D | account |
| E | merchant |
| F | item |
| G | category |
| H | subcategory |
| I | payment_method |
| J | amount |
| K | memo |
| L | tags |
| M | source |
| N | confidence |
| O | receipt_file_id |
| P | raw_text |
| Q | status |
| R | settlement_status |
| S | card_name |

---

## 5. マッピング（JSON → 列）

| 04_Transactions列 | 変換元 | 変換ルール / 備考 |
|---|---|---|
| A id | GAS生成 | TXN_YYYYMMDD_連番 または UUID（推奨） |
| B date | date | 空なら空文字。UIで追完。 |
| C type | txn_type | expense/income/transfer をそのまま保存 |
| D account | account | 空可。候補は 03_Accounts.account_name |
| E merchant | merchant | 空可 |
| F item | item | 空可 |
| G category | category | 辞書補正あり（後述） |
| H subcategory | subcategory | 辞書補正あり（後述） |
| I payment_method | payment_method | 候補は 01_Settings の支払方法 |
| J amount | amount | 数値（常に正の数）。小数は許可（例：外貨換算）するか運用で決める。 |
| K memo | memo | 空可 |
| L tags | tags | 配列 → カンマ区切り文字列へ tags.join(",") |
| M source | GAS指定 | text / receipt / manual |
| N confidence | confidence | 0〜1 |
| O receipt_file_id | GAS指定 | レシート保存する場合のみ Drive fileId |
| P raw_text | 入力元 | テキスト入力 or (receipt) 等の固定値 + OCR要約でも可 |
| Q status | ルール | status判定ロジック（後述） |
| R settlement_status | ルール | カード払い時 = "unsettled"、現金/即時決済 = ""、精算後 = "settled" |
| S card_name | payment_method | カード名を正規化（楽天カード、JCBカード等） |

---

## 6. 辞書補正（02_Categories）ルール

### 6.1 目的

AIの分類ブレを吸収して、カテゴリ精度を継続的に改善する。

### 6.2 入力
- merchant, item, raw_text を連結した検索対象文字列 haystack

### 6.3 マッチング
- 02_Categories.keywords（カンマ区切り）を分割し、部分一致で判定
- 複数候補がヒットした場合：
  1. priority が高いものを優先
  2. 同率なら より長いキーワード を優先（誤ヒットを減らす）
  3. それでも同率なら、元のAI出力を維持（上書きしない）でも可

### 6.4 上書き
- ヒットしたら category/subcategory を辞書側で上書き
- 上書きした場合、memo 末尾に "(dict)" を付ける等のトレースを任意で残す

---

## 7. status判定ロジック（必須）

### 7.1 判定に使う値
- needs_clarification（AI）
- clarification_questions（AI）
- confidence（AI）
- 必須項目の充足（date/amount/category/txn_type）

### 7.2 ルール（推奨）

以下の優先順で決める：
1. needs_clarification == true → pending
2. 必須項目欠損（date空 or amount<=0 or category空 or txn_type空）→ pending
3. confidence < 0.6 → needs_review
4. 異常値（例：amount >= 1,000,000 など）→ needs_review（閾値は設定化推奨）
5. それ以外 → confirmed

例：dateが空でも、金額・カテゴリが明確なら pending にして date だけ追完させる。

---

## 8. 追加質問（pending）の扱い

### 8.1 UIへ返す

pending の場合、UIレスポンス clarification.questions に質問を入れて表示する。

### 8.2 追完後の更新
- UIから追完値を送信し、対象の id 行を更新して confirmed にする
- 更新I/F（任意）：
  - resolvePending(id, patch) -> TransactionResult

---

## 9. 実装用 擬似コード（GAS）

```javascript
function mapAiToRow(ai, source, rawText, receiptFileId) {
  const id = generateTxnId_();
  const mapped = {
    id,
    date: ai.date || "",
    type: ai.txn_type || "",
    account: ai.account || "",
    merchant: ai.merchant || "",
    item: ai.item || "",
    category: ai.category || "",
    subcategory: ai.subcategory || "",
    payment_method: ai.payment_method || "",
    amount: Number(ai.amount || 0),
    memo: ai.memo || "",
    tags: (ai.tags || []).join(","),
    source,
    confidence: Number(ai.confidence || 0),
    receipt_file_id: receiptFileId || "",
    raw_text: rawText || "",
    status: "" // below
  };

  // 辞書補正
  const corrected = applyCategoryDictionary_(mapped);

  // status判定
  corrected.status = decideStatus_(ai, corrected);

  return corrected;
}
```
