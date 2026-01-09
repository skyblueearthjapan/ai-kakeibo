# Phase7 実装指示書（コーディングエージェント向け）
AI非依存運用 + OCR + 選択式入力

Version: 1.0
Status: 実装開始OK
対象: GAS Webアプリ / Spreadsheet連携

---

## このフェーズの大前提（最重要）
- **OpenAIは必須ではない**
- APIキーが無くても、アプリは「正常系」で完走する必要がある
- AIは「拡張スロット」として残すだけ
- **最終確定は必ずユーザー操作**

👉 自動で「confirmed」にしない
👉 OCR/AIは *draft（下書き）* を作るだけ

---

## 実装ゴール（Phase7）
1. レシート画像をアップロードできる
2. OCRで文字抽出できる（AIなし）
3. 抽出結果を **フォームに自動反映**
4. ユーザーが選択式で修正・確定
5. confirmed 保存で既存分析/インサイトがそのまま動く

---

## 実装順序（絶対にこの順で進める）

### Step 0️⃣：既存コードは壊さない
- Phase1〜6 の関数は **変更しない**
- 新機能は「V2 / 新関数 / 分岐」で追加
- 既存 `processReceipt()` は残す

---

## Step 1️⃣ 設定まわり（config.gs）

### やること
- Phase7用のフラグを追加
- OpenAIキーが無い場合でも落ちないようにする

### 実装指示
1. `config.gs` に以下キーを **必ず追加**
   - `AI_ENABLED`
   - `OCR_ENABLED`
   - `OCR_PROVIDER`
2. 値が無い場合は **安全側デフォルト**
   ```js
   AI_ENABLED = false
   OCR_ENABLED = true
   OCR_PROVIDER = "vision"
   ```

### 禁止事項
- OPENAI_API_KEY の有無で throw しない
- AIが使えない = エラー にしない

---

## Step 2️⃣ OCR専用モジュールを作る（ocr.gs）

### 新規ファイル
```
/gas/ocr.gs
```

### ocr.gs に持たせる責務
- 画像 → OCRテキスト
- OCR結果 → draft生成
- 分類はしない

### 実装する関数（必須）

```javascript
/**
 * OCRのエントリーポイント
 */
function runOcr_(imageBase64, mimeType, traceId)

/**
 * Vision OCR 呼び出し
 */
function visionOcr_(imageBase64, mimeType, traceId)

/**
 * OCRテキストから draft を作る
 */
function buildDraftFromOcrText_(fullText)

/**
 * 日付抽出
 */
function extractDate_(text)

/**
 * 金額抽出（最大値優先）
 */
function extractTotalAmount_(text)

/**
 * 店名抽出（先頭行）
 */
function extractMerchant_(text)
```

### 重要ルール
- 正規表現は 緩く
- 失敗しても null を返す
- throw しない（上位で処理）

---

## Step 3️⃣ 新しい受付APIを作る（processReceiptV2）

### なぜ V2 か？
- 既存 processReceipt() を壊さない
- AI/OCR/手入力を切り替えるため

### Code.gs に追加する関数
```javascript
function processReceiptV2(imageData, clientContext)
```

### 処理フロー（厳守）
```
1. client_request_id を取得
2. config 読み込み
3. 画像を Drive 保存
4. if (AI_ENABLED && OPENAI_API_KEY)
     → 既存AIフロー（将来）
   else if (OCR_ENABLED)
     → OCRフロー
   else
     → 空draft生成
5. draft を返す（保存しない）
```

### 戻り値（必須）
```json
{
  "ok": true,
  "result": {
    "draft": "TransactionDraft"
  }
}
```

❌ この関数では 04_Transactions に書かない

---

## Step 4️⃣ Draft保存APIを作る

### 新規API
```javascript
function saveTransactionDraft(draft, clientContext)
```

### 役割
- フォーム確定時に呼ばれる
- ここで初めてシートに保存

### 保存ルール
- 保存先：04_Transactions
- status：confirmed
- source：
  - 手入力 → manual
  - OCR → ocr
  - AI → ai

---

## Step 5️⃣ UIを「入力フォーム中心」に切り替える

### UI構成（Phase7）
```
[ レシート撮影 ]
        ↓
[ OCR解析中… ]
        ↓
[ 入力フォーム ]
  - 日付
  - 金額
  - カテゴリ（select）
  - 支払方法（select）
  - メモ
        ↓
[ 確定して保存 ]
```

### UI実装指示
- OCR結果は input の初期値に入れる
- 未入力項目は空のまま
- 「確定」ボタン押下まで保存しない

---

## Step 6️⃣ スプレッドシート連携（既存構造を使う）

### 04_Transactions
- 列構成は **一切変更しない**
- Phase7で追加するのは **値の入れ方だけ**

### draft → row マッピング

| フィールド | 値 |
|------------|-----|
| status | confirmed |
| raw_text | OCR全文 |
| source | ocr / manual |
| confidence | 0 |

---

## Step 7️⃣ 既存分析・インサイトへの影響確認

### 確認事項（必須）
- OCR保存した取引が：
  - Phase4 ダッシュボードに出る
  - Phase5 インサイトに反映される
- amount=0 の draft は保存されない
- confirmed のみ集計される

---

## よくあるNG（必ず避ける）

❌ OCR結果をそのまま自動保存
❌ カテゴリをOCR/AIで勝手に確定
❌ OpenAIキー無しでエラー
❌ Phase1〜6の既存関数を書き換える

---

## 完了条件（Phase7 Done）
- [ ] OpenAIキー無しで記帳できる
- [ ] レシート画像 → OCR → フォーム表示
- [ ] ユーザーが選択式で確定できる
- [ ] 保存後、分析/インサイトに反映
- [ ] AIは設定ONで即有効化可能

---

## 次フェーズ（参考）
- Phase8：予算・アラート
- Phase9：定期支出
- Phase10：AI説明アシスタント
