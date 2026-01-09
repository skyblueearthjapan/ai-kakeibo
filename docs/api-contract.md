# 家計簿チャットボット APIコントラクト（GAS Webアプリ / OpenAI / Spreadsheet）

Version: 0.1
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 1. 概要

本システムは以下の2系統のAPI（I/F）を持つ。

1) **UI（ブラウザ）→ GAS（google.script.run）**
2) **GAS → OpenAI API（Responses API）**
3) **GAS → Spreadsheet（append / read）** ※内部I/F（関数）

本ドキュメントは 1) と 2) を中心に、リクエスト/レスポンス、エラー、ステータス遷移を定義する。

---

## 2. UI → GAS（google.script.run）I/F

### 2.1 processText

**目的**: テキスト入力を取引に正規化し、Transactionsへ記帳する。
**署名**:
- `processText(text: string, clientContext?: ClientContext) -> TransactionResult`

**Request**
```json
{
  "text": "昨日 スタバ 620円 ラテ",
  "clientContext": {
    "client_time": "2026-01-09T10:12:00+09:00",
    "timezone": "Asia/Tokyo",
    "device": "mobile",
    "ui_version": "0.1"
  }
}
```

**Response（成功）**
```json
{
  "ok": true,
  "result": {
    "transaction": {
      "id": "TXN_20260109_000123",
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
      "tags": [],
      "source": "text",
      "confidence": 0.82,
      "receipt_file_id": "",
      "raw_text": "昨日 スタバ 620円 ラテ",
      "status": "confirmed"
    },
    "clarification": null
  }
}
```

**Response（追加確認が必要）**
```json
{
  "ok": true,
  "result": {
    "transaction": {
      "id": "TXN_20260109_000124",
      "date": "",
      "txn_type": "expense",
      "account": "",
      "merchant": "スターバックス",
      "item": "ラテ",
      "category": "食費",
      "subcategory": "カフェ",
      "payment_method": "",
      "amount": 620,
      "memo": "",
      "tags": [],
      "source": "text",
      "confidence": 0.62,
      "receipt_file_id": "",
      "raw_text": "スタバ 620円 ラテ",
      "status": "pending"
    },
    "clarification": {
      "needs_clarification": true,
      "questions": ["利用日はいつですか？（例：今日/昨日/2026-01-08）", "支払方法は？（現金/カード/QRなど）"]
    }
  }
}
```

---

### 2.2 processReceipt

**目的**: レシート画像を取引に正規化し、Transactionsへ記帳する。
**署名**:
- `processReceipt(dataUrl: string, clientContext?: ClientContext) -> TransactionResult`

**Request**
```json
{
  "dataUrl": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
  "clientContext": {
    "client_time": "2026-01-09T10:12:00+09:00",
    "timezone": "Asia/Tokyo",
    "device": "mobile",
    "ui_version": "0.1"
  }
}
```

**Response（成功）**
- receipt_file_id に Drive fileId が入る（保存する場合）

---

### 2.3 listTransactions（任意/推奨）

**目的**: 指定月の取引一覧をUIに返す。
**署名**:
- `listTransactions(monthStart: string, filters?: Filters) -> TransactionListResult`

**Request**
```json
{
  "monthStart": "2026-01-01",
  "filters": { "category": "食費", "status": "confirmed" }
}
```

**Response（成功）**
```json
{
  "ok": true,
  "result": {
    "monthStart": "2026-01-01",
    "rows": [
      {
        "id": "TXN_...",
        "date": "2026-01-08",
        "txn_type": "expense",
        "merchant": "スターバックス",
        "category": "食費",
        "amount": 620,
        "status": "confirmed"
      }
    ]
  }
}
```

---

### 2.4 getDashboard（任意/推奨）

**目的**: 指定月のKPIやカテゴリ別集計を返す（UI描画用）。
**署名**:
- `getDashboard(monthStart: string) -> DashboardResult`

**Response例**
```json
{
  "ok": true,
  "result": {
    "monthStart": "2026-01-01",
    "kpi": { "expense": 123456, "income": 250000, "net": 126544 },
    "byCategory": [{ "category": "食費", "amount": 34567 }],
    "trend12m": [{ "month": "2025-02-01", "expense": 110000 }]
  }
}
```

---

## 3. GAS → OpenAI（Responses API）I/F

### 3.1 基本方針
- Structured Output（JSON Schema）で 取引JSONを固定する。
- 入力は text または input_image（data URL）を使用。
- モデルは「分類/抽出」用途で軽量モデルを使用し、必要なら上位モデルへ切替可能にする。

---

### 3.2 OpenAI Request（例：テキスト）

```json
{
  "model": "gpt-4o-mini",
  "input": [
    {
      "role": "system",
      "content": [
        { "type": "text", "text": "あなたは家計簿入力の受付です。..." }
      ]
    },
    {
      "role": "user",
      "content": [{ "type": "text", "text": "昨日 スタバ 620円 ラテ" }]
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "kakeibo_transaction", "schema": { "$ref": "#/definitions/TransactionAI" }, "strict": true }
  }
}
```

---

### 3.3 OpenAI Request（例：レシート）

```json
{
  "model": "gpt-4o-mini",
  "input": [
    {
      "role": "system",
      "content": [{ "type": "text", "text": "あなたは家計簿入力の受付です。..." }]
    },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "このレシート画像から、1件の支出取引を抽出してJSONで返してください。" },
        { "type": "input_image", "image_url": "data:image/jpeg;base64,/9j/..." }
      ]
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "kakeibo_transaction", "schema": { "$ref": "#/definitions/TransactionAI" }, "strict": true }
  }
}
```

---

## 4. JSON Schema（AI出力）

注意: Spreadsheet列 type と衝突しないよう AI出力は txn_type を使う。

```json
{
  "definitions": {
    "TransactionAI": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "type": { "type": "string", "enum": ["transaction", "unknown"] },
        "date": { "type": "string", "description": "YYYY-MM-DD or empty" },
        "txn_type": { "type": "string", "enum": ["expense", "income", "transfer"] },
        "account": { "type": "string" },
        "merchant": { "type": "string" },
        "item": { "type": "string" },
        "category": { "type": "string" },
        "subcategory": { "type": "string" },
        "payment_method": { "type": "string" },
        "amount": { "type": "number" },
        "memo": { "type": "string" },
        "tags": { "type": "array", "items": { "type": "string" } },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
        "needs_clarification": { "type": "boolean" },
        "clarification_questions": { "type": "array", "items": { "type": "string" } }
      },
      "required": [
        "type","date","txn_type","account","merchant","item","category","subcategory",
        "payment_method","amount","memo","tags","confidence","needs_clarification","clarification_questions"
      ]
    }
  }
}
```

---

## 5. エラー設計（UI向け）

### 5.1 エラーコード

| code | 想定 | UI表示 | 対応 |
|---|---|---|---|
| E_BAD_REQUEST | 入力が空/形式不正 | 「入力を確認してください」 | 再入力 |
| E_OPENAI_TIMEOUT | OpenAIタイムアウト | 「通信が混雑しています」 | リトライ |
| E_OPENAI_QUOTA | 課金/制限 | 「利用制限に達しました」 | 管理者対応 |
| E_PARSE_FAILED | JSONパース失敗 | 「解析に失敗しました」 | 再送/ログ保存 |
| E_SHEET_WRITE_FAILED | シート書込失敗 | 「保存できませんでした」 | リトライ/管理者 |

### 5.2 Error Response例

```json
{
  "ok": false,
  "error": {
    "code": "E_OPENAI_TIMEOUT",
    "message": "OpenAI request timed out",
    "trace_id": "TRACE_20260109_abcdef"
  }
}
```

---

## 6. ステータス遷移（Transactions.status）

- **confirmed**: 記帳確定
- **pending**: 追加質問待ち（date/payment_method等）
- **needs_review**: 低confidence/異常値/矛盾

**遷移例**:
- pending → confirmed（ユーザーが追加回答）
- needs_review → confirmed（ユーザー修正確定）
- confirmed → needs_review（後から矛盾検知した場合）
