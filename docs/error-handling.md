# エラーハンドリング仕様（UI / GAS / OpenAI / Spreadsheet）

Version: 0.1
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 1. 目的

- スマホUIで「失敗しても戻れる」体験を担保する
- OpenAI呼び出し・画像アップロード・シート書込みなどの失敗点を特定し、復旧可能にする
- 障害時に **データを失わない**（最低でも raw_text / 画像 / trace_id を残す）

---

## 2. 障害ポイント（一覧）

| 層 | 失敗例 |
|---|---|
| UI（ブラウザ） | 画像が大きすぎる、通信断、二重送信 |
| GAS | 例外発生、実行時間超過、権限不足、UrlFetch失敗 |
| OpenAI | タイムアウト、レート制限、クォータ超過、JSON不整合 |
| Spreadsheet | append失敗、シート名違い、ロック競合 |
| Drive（任意） | 画像保存失敗、容量不足、権限不足 |

---

## 3. エラー分類（error.code）

### 3.1 共通エラーコード
| code | レベル | 説明 | 例 |
|---|---|---|---|
| E_BAD_REQUEST | warn | 入力不正 | 空入力、形式不正dataUrl |
| E_CLIENT_IMAGE_TOO_LARGE | warn | 画像サイズ超過 | base64が上限超え |
| E_NETWORK | warn | 通信断/不安定 | 送信失敗 |
| E_GAS_RUNTIME | error | GAS例外 | null参照、未定義 |
| E_GAS_TIMEOUT | error | 実行時間超過 | 画像処理で遅延 |
| E_OPENAI_TIMEOUT | error | OpenAIタイムアウト | UrlFetch timeout |
| E_OPENAI_RATE_LIMIT | error | レート制限 | 429 |
| E_OPENAI_QUOTA | error | クォータ/課金 | 402/403相当 |
| E_OPENAI_BAD_RESPONSE | error | APIレスポンス不正 | JSON不備 |
| E_PARSE_FAILED | error | JSONパース失敗 | outputが壊れている |
| E_SHEET_WRITE_FAILED | error | シート書込失敗 | appendRow失敗 |
| E_DRIVE_WRITE_FAILED | error | Drive保存失敗 | createFile失敗 |
| E_UNKNOWN | fatal | 想定外 | その他 |

---

## 4. UIの復旧方針

### 4.1 原則
- ユーザーに「何が起きたか」「次に何をすればいいか」を短く表示
- 再送可能なら「リトライ」ボタン
- 二重送信防止（送信中はボタン無効化）

### 4.2 UI表示テンプレ
- warn：薄い黄色カード「入力を確認してください」
- error：薄いピンクカード「通信に失敗しました。もう一度お試しください」
- fatal：薄いグレーカード「システムエラー。時間をおいて再度お試しください」

### 4.3 レシート画像の扱い
- クライアント側で縮小（推奨：最大辺1280px、JPEG品質0.7程度）
- 画像が大きい場合：`E_CLIENT_IMAGE_TOO_LARGE` で縮小を促す

---

## 5. GAS側の復旧方針（重要）

### 5.1 トレースID
全リクエストに `trace_id` を付与し、ログと行データに紐づけ可能にする。

- 生成例：`TRACE_YYYYMMDD_HHMMSS_rand`

### 5.2 ログシート（推奨：将来追加）
`09_Logs` を追加し、最低限以下を保存する：
- timestamp
- trace_id
- operation（processText/processReceipt）
- input_summary（raw_text/receipt_file_id）
- error_code
- error_message
- openai_status（HTTP）
- duration_ms

> MVPではLoggerでもよいが、運用するならログシート推奨。

### 5.3 リトライ
- OpenAIタイムアウト/一時エラーは **最大2回** リトライ
- リトライ間隔：指数バックオフ（例：300ms → 1000ms）
- 429（rate limit）は即リトライせず、UIへ「時間をおいて」表示

### 5.4 "データを失わない"戦略
OpenAIが失敗しても、入力は残す：
- `04_Transactions` に暫定行を追加（status=needs_review）
  - category="その他"
  - amount=0（不明）
  - raw_text を保存
  - memo にエラーコードを保存（例：`OPENAI_FAILED:E_OPENAI_TIMEOUT`）

または
- `09_Logs` のみに保存（記帳はしない）
どちらにするかは運用方針で決める（推奨は暫定行）。

---

## 6. OpenAI関連の失敗と対策

### 6.1 JSON Schema不一致（E_PARSE_FAILED / E_OPENAI_BAD_RESPONSE）
**原因**
- output_textが空
- JSONが壊れている
- Schema strict だがモデルが逸脱

**対策**
1) 1回だけ "再生成" を試す（同じ入力で再リクエスト）
2) それでもダメなら暫定行保存（needs_review）+ UIへ「後で修正できます」

### 6.2 タイムアウト（E_OPENAI_TIMEOUT）
**対策**
- 画像サイズ縮小
- 2回までリトライ
- 失敗時は暫定行 or ログ保存

### 6.3 レート制限（E_OPENAI_RATE_LIMIT）
**対策**
- UIに「混雑しています。少し待って再送してください」
- サーバ側で即時リトライしない（悪化する）

---

## 7. Spreadsheet書込み失敗と対策（E_SHEET_WRITE_FAILED）

**原因**
- シート名誤り
- 競合（ロック）
- 範囲異常

**対策**
- `LockService` を利用し、短時間ロック（例：5秒）
- 失敗時は Logger + UIにリトライ表示
- 連続失敗時は `09_Logs` に詳細を残す

擬似コード：
```javascript
const lock = LockService.getScriptLock();
try {
  lock.tryLock(5000);
  sheet.appendRow(row);
} finally {
  lock.releaseLock();
}
```

---

## 8. Drive保存失敗と対策（E_DRIVE_WRITE_FAILED）

**方針**
- Drive保存は"任意"扱いにし、失敗しても記帳は進める
- receipt_file_id を空にして記帳、memoに DRIVE_SAVE_FAILED を残す

---

## 9. エラー時レスポンスフォーマット（UI向け）

```json
{
  "ok": false,
  "error": {
    "code": "E_OPENAI_TIMEOUT",
    "message": "OpenAI request timed out",
    "trace_id": "TRACE_20260109_101200_ab12",
    "retryable": true,
    "user_message": "通信が混雑しています。もう一度お試しください。"
  }
}
```

- retryable: UIでリトライボタンを出すか判断
- user_message: UIへそのまま表示可能な文言

---

## 10. チェックリスト（実装完了条件）

- [ ] UIは送信中に二重送信できない
- [ ] 画像はクライアントで縮小できる（またはサイズエラーを出す）
- [ ] OpenAI失敗でも raw_text（または画像）は失わない
- [ ] JSONパース失敗時の再試行がある
- [ ] Spreadsheet書込みはLockServiceで競合を抑制
- [ ] trace_id がログ/行に紐づく
