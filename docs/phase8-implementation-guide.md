# Phase8 実装指示書（コーディングエージェント向け）
カメラ撮影ボタン + 音声入力（マイク）をホーム画面に統合

Version: 1.0
Status: 実装開始OK
Last Updated: 2026-01-09

---

## 0. このフェーズの結論（最重要）
- Phase8は **サーバ（GAS）をほぼ触らず**、UI中心で完結させる
- カメラ：`capture="environment"` を使い **スマホでカメラ起動**導線を作る
- 音声：Web Speech API（SpeechRecognition）で **音声→テキスト**にしてフォームへ反映
- 失敗時は必ず **手入力にフォールバック**する（落ちない、止まらない）

---

## 1. 変更対象ファイル

```
/ui
ui_index.html   # ボタンUI（📷/🖼/🎤）追加、音声テキスト表示エリア追加
ui_style.html   # ボタンスタイル、音声状態（listening等）の見た目
ui_app.html     # 画像処理（resize+upload）と音声入力（SpeechRecognition）実装
/gas
変更なし（原則）
```

> Phase7で `processReceiptV2` と `saveTransactionDraft` が存在する前提。
> カメラ/写真は `processReceiptV2` を叩くだけ。

---

## 2. UI構成（ホーム画面）
ホーム（入力）に以下3導線を並べる：

1) 📷 **カメラで撮影**（優先導線）
2) 🖼 **写真から選ぶ**（補助導線）
3) 🎤 **音声で入力**（補助導線）

加えて音声認識結果の表示欄を用意：

- 認識テキスト表示（編集可）
- 「フォームへ反映」ボタン
- 「クリア」ボタン

---

## 3. 実装手順（迷わない順）

### Step A：ui_index.html へボタンと領域を追加
#### A-1) レシート入力カードに以下を追加
- `receiptCam`（capture付き）
- `receiptPick`（従来の写真選択）
- `btnMic`（音声入力）
- `voiceText`（認識結果表示）
- `btnApplyVoice`（フォーム反映）
- `btnClearVoice`（クリア）

#### A-2) 追加位置
- 「レシート撮影」カード（または入力カード）の最上部に配置
- その下にフォーム（Phase7の確定フォーム）がある構成がベスト

---

### Step B：ui_style.html にスタイル追加
- `.camBtn`（押しやすい角丸ボタン）
- `.micBtn`（録音中は点滅/色変化）
- `.voiceBox`（認識テキスト領域）

---

### Step C：ui_app.html にロジック追加
#### C-1) 画像（カメラ/写真）
- `change` イベントで `handleReceiptFile_(file, source)` 呼び出し
- `resizeImageToDataUrl_()`（既存があれば流用、なければ追加）
- `processReceiptV2(dataUrl, clientContext)` を呼び、
  - `res.result.draft` を `applyDraftToForm_()` でフォームへ反映

#### C-2) 音声
- `SpeechRecognition` を検出して有効化/無効化
- `startVoiceInput_()` / `stopVoiceInput_()` を実装
- 認識結果は `voiceText` に出して編集可にする
- 「フォームへ反映」は `applyVoiceToForm_()` で memo/raw_text に入れる
  - Phase8では **分類しない**
  - ユーザーがカテゴリ/金額等はフォームで確定する

---

## 4. 実装詳細（要件）
### 4.1 カメラ（capture）の要件
- input属性：
  - `accept="image/*"`
  - `capture="environment"`（背面カメラ優先）
- iOSでは「撮影/ライブラリ」選択が出る場合がある → 許容

### 4.2 音声入力の要件
- `window.SpeechRecognition || window.webkitSpeechRecognition` を使用
- `lang = "ja-JP"`
- `interimResults = true`
- `continuous = false`（まずは短文で安定）
- state：
  - idle：🎤 音声で入力
  - listening：⏺ 録音中…（ボタンに反映）
  - error：非対応 or 権限拒否（disabled + ヒント）

### 4.3 失敗時のフォールバック
- カメラ/写真：失敗してもフォームを開ける（手入力）
- 音声：非対応ならボタンをdisabledにして説明表示
- どちらも "アプリが落ちない" が最優先

---

## 5. 受け入れテスト（DoD）
### カメラ
- [ ] iPhone Safariで📷→撮影→OCR→フォーム反映
- [ ] Android Chromeで📷→撮影→OCR→フォーム反映
- [ ] 🖼から選んでも同様に動く
- [ ] キャンセル時は何も起きず戻れる

### 音声
- [ ] Chrome系で🎤→話す→テキストが表示される
- [ ] 「フォームへ反映」でmemo/raw_textに入る
- [ ] クリアできる
- [ ] 非対応ブラウザで🎤が無効化される

---

## 6. コーディング上の注意（地雷回避）
- 音声データ（生音声）をサーバに送らない（テキストのみ）
- processReceiptV2 は保存しない（draftのみ）
- saveTransactionDraft だけが保存（Phase7原則）
- iOS Safariでは SpeechRecognition が弱い/無い場合があるので必ず fallback

---

## 7. 実装完了の定義
- UIに📷/🖼/🎤があり、スマホで自然に入力できる
- OCRは既存Phase7の通り動く
- 音声は「フォーム入力補助」として動く
- 不対応でも手入力で完走できる
