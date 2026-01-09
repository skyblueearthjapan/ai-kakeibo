# Phase8 設計仕様書
モバイルUX強化：カメラ撮影ボタン + 音声入力（マイク）
（Phase7: OCR + 選択式入力 を前提に拡張）

Version: 0.1
Last Updated: 2026-01-09

---

## 1. 目的・ゴール

### 1.1 目的
スマホ利用を前提として、入力を「撮影」と「音声」で最短化し、手入力の負担を大幅に減らす。

### 1.2 Phase8ゴール
- ホーム画面（入力）に **カメラボタン**を設置し、押下で
  - その場で撮影 → アプリ内で自動アップロード → OCR（Phase7） → draftフォームに反映
- 同じく **マイクボタン（音声入力）**を設置し、押下で
  - 音声認識 → テキスト化 → draftフォームへ反映（またはテキスト受付の既存処理に送る）
- iOS/Androidでの挙動差を吸収し、失敗しても必ず手入力にフォールバックできる

---

## 2. 対象範囲

### 2.1 含む
- UI（GAS HTML）でのカメラ撮影導線改善（capture属性方式）
- UI（GAS HTML）での音声入力（Web Speech APIのSpeechRecognition）
- 既存Phase7の `processReceiptV2` / `saveTransactionDraft` と連携
- ログ（Phase6の 09_Logs）への追加記録（任意）

### 2.2 含まない（Phase9候補）
- カメラプレビュー付き撮影UI（getUserMedia）を標準化（オプション扱い）
- 音声から自動カテゴリ分類（AI無し運用では実施しない）
- 話者識別・マルチユーザー機能

---

## 3. 全体方針（重要）

### 3.1 UXの原則
- ユーザーが迷わない：
  - 「📷撮影」「🎤音声」「⌨手入力」の3導線を同じ画面に並べる
- 失敗しても止まらない：
  - カメラが使えない → 写真選択へ
  - 音声認識が使えない → テキスト入力へ

### 3.2 技術方針
- カメラ：`<input type="file" accept="image/*" capture="environment">` を基本（安定）
- 音声：Web Speech API（SpeechRecognition）を基本（ブラウザ対応差あり）
- すべて「ブラウザ側」で完結（GASに音声データは送らない。送るのはテキストのみ）

---

## 4. UI仕様（ホーム画面：入力タブ）

### 4.1 追加UIコンポーネント
1) **カメラボタン**
- ラベル：`📷 カメラで撮影`
- 機能：撮影 → 画像取得 → リサイズ → `processReceiptV2` へ送信 → draft反映

2) **写真選択ボタン（従来導線）**
- ラベル：`🖼 写真から選ぶ`
- 機能：フォルダから選択 → 同上

3) **マイクボタン（音声入力）**
- ラベル：`🎤 音声で入力`
- 状態：
  - idle（待機）
  - listening（録音中、波形表示は不要）
  - processing（テキスト化中）
  - error（使用不可 / 権限拒否）
- 結果テキストを以下どちらかへ反映（選択式）
  - A案：フォームの「メモ/店名/金額」の入力補助として反映（推奨）
  - B案：既存 `processText` に送って draft作成（AIが無い場合はルールベース）
    ※Phase8ではA案を採用し、B案はPhase9で拡張

---

## 5. 音声入力仕様（Web Speech API）

### 5.1 対応API
- `window.SpeechRecognition` または `window.webkitSpeechRecognition`

### 5.2 言語
- `lang = "ja-JP"`

### 5.3 設定
- `interimResults = true`（途中結果表示）
- `maxAlternatives = 1`

### 5.4 出力（音声→テキスト）
- テキストはUIに表示し、ユーザーが編集可能
- ボタン押下で「フォームに反映」

### 5.5 非対応時
- SpeechRecognitionが無いブラウザではマイクボタンを disabled
- ヒント表示：`このブラウザでは音声入力に対応していません（Chrome推奨）`

---

## 6. 既存APIとの接続

### 6.1 カメラ/写真
- UI → `processReceiptV2(dataUrl, clientContext)`
- 結果 `draft` をフォームへ反映
- 保存は `saveTransactionDraft(draft, clientContext)` のみ

### 6.2 音声（Phase8時点）
- UIで認識したテキストをフォームの `memo` または `raw_text` に入れる
- ユーザーが日付・金額を選択式で確定

---

## 7. データ取り扱い（プライバシー）
- 音声データ（生音声）はサーバへ送らない
- 音声→テキストのみUI内で利用し、必要なら `raw_text` / `memo` に保存可
- レシート画像は従来通りDrive保存（receipt_file_id）

---

## 8. エラーハンドリング

### 8.1 カメラ
- ユーザーがキャンセル → 何もしない
- 画像変換失敗 → `画像処理に失敗しました。別の写真でお試しください。`
- OCR失敗 → draftは空で表示し、手入力へ誘導

### 8.2 音声
- 権限拒否 → `マイク権限が必要です。ブラウザ設定をご確認ください。`
- 無音タイムアウト → `音声が認識できませんでした。もう一度お試しください。`
- 非対応 → disabled + ヒント

---

## 9. テスト観点（DoD）

- [ ] iPhone Safariで「📷カメラで撮影」が起動し、撮影→OCR→フォーム反映できる
- [ ] Android Chromeで同様に動作する
- [ ] 音声入力（Chrome）で日本語が認識され、テキストが表示される
- [ ] 音声非対応ブラウザでマイクボタンが無効化される
- [ ] どの失敗ケースでも手入力で確定できる

---

## 10. 実装タスク分割（コーディングエージェント用）

### Task A: UI（カメラ）
- input `capture="environment"` を追加
- 画像リサイズ→dataUrl生成→processReceiptV2送信
- draftをフォームへ反映

### Task B: UI（音声）
- SpeechRecognitionラッパ実装
- マイクボタン state管理（idle/listening/error）
- 認識テキストを表示・編集可能
- 「フォーム反映」ボタンで memo/raw_text に挿入

### Task C: ログ（任意）
- 音声入力イベント（start/stop/error）を UI側で記録（サーバに送らない）
- 画像入力（camera/picker）を clientContext に含める（source_device）

---

## 11. Phase8 完了条件
- [ ] カメラ撮影導線が追加され、撮影→OCR→フォーム反映が動く
- [ ] 音声入力導線が追加され、認識テキストがフォームに反映できる
- [ ] 非対応端末/ブラウザでも手入力にフォールバックできる
