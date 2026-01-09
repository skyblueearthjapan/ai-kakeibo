# OpenAIプロンプト設計・モデル仕様（家計簿受付）

Version: 0.1
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 1. 役割定義

- OpenAI（GPT）は「受付」として、ユーザー入力を **1件の取引JSON** に正規化する。
- 記帳/集計/グラフ化はGAS + Spreadsheetが担当する。

---

## 2. システムプロンプト（例）

```text
あなたは家計簿入力の受付です。
ユーザー入力（テキスト/レシート画像）から「1件の取引」を抽出し、指定JSON Schemaに厳密に従って返してください。

- 日付は YYYY-MM-DD。不明なら空文字にする。
- 取引種別は txn_type=expense/income/transfer。
- amountは数値（常に正の数）。支出か収入かは txn_type で区別する。
- カテゴリは一般的な家計簿の大分類（例：食費/日用品/住居/光熱費/通信/交通/医療/教育/娯楽/美容・衣服/交際/子ども/貯蓄・投資/特別費/収入/その他）から選ぶ。
- 不明点がある場合は needs_clarification=true にし、clarification_questions に短い質問を入れる。
- 迷った場合は confidence を低めに設定する。
```

---

## 3. 出力JSON（必須）

api-contract.md の JSON Schema（TransactionAI）に準拠する。

---

## 4. レシート画像の扱い

- できるだけ「店名」「合計金額」「日付」が写る画像を前提
- 1枚のレシートからはMVPでは **合計金額で1件化** を基本
- 将来拡張で複数明細（商品行）に分解可能

---

## 5. 追加質問（clarification）戦略

**優先順位（最初に不足しがちな順）**
1. date（いつの支出？）
2. payment_method（現金/カード/QR）
3. category（分類が曖昧なとき）
4. account（財布/口座）

質問は1〜2個ずつ返す（UIで詰まりにくい）

---

## 6. コスト/品質の運用

- 通常は軽量モデルで分類（コスト最適）
- 以下の場合は上位モデルへ切替（将来）
  - OCR/読み取りが難しいレシート
  - 重要度が高い（確定処理）
  - エラー率が高い店舗

---

## 7. ログ設計（再学習/改善用）

- raw_text（元入力）
- receipt_file_id（Drive）
- ai_output_json（将来：別ログシートに保存）
- confidence
- status
- ユーザー修正履歴（将来）
