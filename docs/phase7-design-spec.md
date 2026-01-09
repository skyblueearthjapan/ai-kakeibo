# Phase7 設計仕様書
AI非依存運用 + OCRレシート読取 + 選択式入力（AI拡張可能）

Version: 0.1
Last Updated: 2026-01-09

---

## 1. 背景・目的

本システムは Phase6 までで以下を達成している：

- 家計簿入力（テキスト / レシート）
- AI分類（OpenAI）
- 履歴編集、分析、インサイト
- 運用ログ・復旧・二重防止

Phase7 では以下を実現する：

1. **OpenAI APIキー無しでも運用可能**
2. **レシート画像から自動で文字抽出（OCR）**
3. **カテゴリ分類はユーザー選択式**
4. OpenAIは「後からONにできる拡張機能」として残す

---

## 2. 全体方針（重要）

### 2.1 モード設計（必須）
システムは以下の3モードを内部的に持つ：

| モード | 説明 |
|------|------|
| MANUAL | 完全手入力（選択式UIのみ） |
| OCR | OCRで文字抽出 → 仮入力 → ユーザー確定 |
| AI | OpenAIで解析（既存Phase） |

### 2.2 モード切替条件
```text
if (AI_ENABLED && OPENAI_API_KEYあり) → AI
else if (OCR_ENABLED) → OCR
else → MANUAL
```

※ AI_ENABLED / OCR_ENABLED は設定値
※ APIキーが無い場合は自動でAIをスキップ

---

## 3. 設定仕様（config.gs 拡張）

### 3.1 新規設定キー

| Key | 型 | 例 | 説明 |
|-----|----|----|------|
| AI_ENABLED | boolean | false | OpenAI自動解析ON/OFF |
| OCR_ENABLED | boolean | true | OCR処理ON/OFF |
| OCR_PROVIDER | string | vision | vision / drive |
| VISION_API_KEY | string | xxx | Vision OCR用 |
| AUTO_SAVE_OCR_DRAFT | boolean | true | OCR失敗時も仮保存 |

01_Settings または Script Properties で設定可能

---

## 4. OCR設計仕様

### 4.1 OCR Provider

**推奨：Google Cloud Vision OCR**
- APIキー or サービスアカウント
- GASから HTTP 経由で呼び出す

（代替：Drive OCRは Phase8候補）

### 4.2 OCR処理フロー（processReceipt）

```
1. 画像アップロード
2. Driveに保存（receipt_file_id）
3. OCR実行 → fullText
4. ルールベース抽出
   - 日付候補
   - 合計金額候補
   - 店名候補
5. 仮取引オブジェクト生成
6. status = needs_review で保存
7. UIで編集 → confirmed
```

### 4.3 OCR抽出ルール（最低限）

**日付**
- YYYY/MM/DD
- YYYY-MM-DD
- YYYY年MM月DD日
- MM/DD（年は当年補完）

**金額**
- 「合計」「計」「お支払」「TOTAL」「税込」周辺
- 抽出値の最大値を優先

**店名**
- OCRテキスト先頭 1〜3行
- カタカナ / 大文字行を優先

---

## 5. スプレッドシート保存仕様（変更なし）

### 04_Transactions
- OCR/手入力時も **必ず同一構造**
- OCR時の初期値例：

| 列 | 値 |
|----|----|
| source | ocr |
| raw_text | OCR全文 |
| status | needs_review |
| memo | OCR_AUTO |
| category | （空 or その他） |

---

## 6. UI設計（Phase7）

### 6.1 入力UIの原則
- フォーム中心（選択式）
- AI/OCRは「補助」
- ユーザーが最終確定する

### 6.2 フォーム項目（必須）
- 日付（date input）
- 金額（number）
- カテゴリ（select）
- サブカテゴリ（select）
- 支払方法（select）
- メモ（text）

### 6.3 レシート連携
- レシート読み込み → OCR → フォーム自動入力
- ユーザーが修正 → 確定

---

## 7. APIコントラクト（追加）

### processReceiptV2

```javascript
processReceiptV2(imageData, clientContext) -> {
  ok: boolean
  result?: {
    draft: TransactionDraft
  }
}
```

- draftのみ返す
- UIは draft をフォームに展開
- 保存は saveTransactionDraft() で別途実行

---

## 8. データ構造（追加）

### TransactionDraft

```json
{
  "date": "2026-01-08",
  "amount": 2480,
  "merchant": "スーパー〇〇",
  "category": "",
  "payment_method": "",
  "raw_text": "...",
  "confidence": 0.3
}
```

---

## 9. OpenAI拡張ポイント（将来）

### 9.1 AIをONにした場合
- OCRテキスト + 画像 + 過去履歴を AI に渡す
- AIは draftを改善する役割
- 自動確定はしない（UX事故防止）

### 9.2 AIの役割（限定）
- カテゴリ候補提案
- 入力補完
- インサイト自然言語説明

---

## 10. フェーズ分割ロードマップ（更新）

| Phase | 内容 |
|-------|------|
| 7 | OCR + 選択式入力 |
| 8 | 予算管理 / アラート |
| 9 | 定期支出自動化 |
| 10 | AI説明アシスタント |

---

## 11. Phase7 完了条件（DoD）

- [ ] OpenAIキー無しで全機能が使える
- [ ] レシート画像 → OCR → 仮入力が動く
- [ ] ユーザーが選択式で確定できる
- [ ] AIは設定ONで即有効化できる
- [ ] 既存Phase1〜6に影響が出ない
