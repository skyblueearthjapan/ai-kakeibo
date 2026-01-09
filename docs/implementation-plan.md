# 段階別 実装指示（GAS Webアプリ × OpenAI × Spreadsheet）

Version: 0.1
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 0. 前提（共通）

### 0.1 参照ドキュメント
- design-spec.md（総合設計）
- api-contract.md（I/F）
- sheet-mapping.md（AI→Transactionsマッピング）
- data-dictionary.md（列定義/正規化）
- ui-spec.md（UI）
- error-handling.md（エラー/復旧）

### 0.2 スプレッドシート前提
- テンプレのタブ/列構成に準拠
- **書き込み先は `04_Transactions` のみ**

### 0.3 シークレット
- GAS Script Properties:
  - `OPENAI_API_KEY`（必須）
  - （任意）`OPENAI_MODEL_TEXT`, `OPENAI_MODEL_IMAGE`

### 0.4 成果物（リポジトリ構成）

```
/gas
  Code.gs
  openai.gs
  sheets.gs
  dictionary.gs
  errors.gs
  types.gs
  ui_index.html
  ui_style.html
  ui_app.html
/docs
  design-spec.md
  api-contract.md
  ui-spec.md
  data-dictionary.md
  sheet-mapping.md
  error-handling.md
  implementation-plan.md
```

---

## Phase 1: テキスト入力 → AI分類 → Transactions追記（MVP核）

### 1.1 目的
- スマホUIでテキスト入力し、OpenAI分類結果を `04_Transactions` に1行追記できる

### 1.2 完了条件（DoD）
- [ ] スマホブラウザから送信 → 数秒で結果が返る
- [ ] `04_Transactions` に行が増える
- [ ] date/amount/category が空のとき pending になる
- [ ] OpenAI失敗時にUIへエラーが返る（trace_id付き）

---

## Phase 2: レシート撮影 → 解析 → Transactions追記

### 2.1 目的
- カメラで撮ったレシート画像を送信し、1件取引として記帳できる

### 2.2 完了条件（DoD）
- [ ] レシートを撮影→送信→ `04_Transactions` に記帳
- [ ] Drive保存ON時、receipt_file_idが埋まる
- [ ] 画像が大きすぎるとUIに警告が出る（もしくは縮小で回避）

---

## Phase 3: 履歴（月切替）をUIに追加

### 3.1 目的
- 当月/前月/過去月の履歴をスマホで見られる
- pending / needs_review を修正して confirmed にできる

---

## Phase 4: ダッシュボード（見える化）

### 4.1 目的
- 当月/前月/過去月の支出・カテゴリ内訳・推移をUIで見える化する

---

## Phase 5: インサイト（使いすぎ/節約）

### 5.1 目的
- 何に使いすぎたか、節約できたかを分かりやすく提示する

---

## Phase 6: 運用・品質を固める

### 6.1 実装範囲
- trace_idでログ記録
- 二重送信防止
- OpenAIエラーの復旧フロー

---

## セットアップ手順

1. スプレッドシートを作成（テンプレをインポート、タブ名を維持）
2. Apps Script を開き、gas/配下のファイルを同名で追加
3. スクリプトプロパティ設定: `OPENAI_API_KEY`
4. デプロイ → ウェブアプリ
5. スマホからURLを開いて動作確認
