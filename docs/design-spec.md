# 家計簿チャットボット（GAS Webアプリ × OpenAI × Googleスプレッドシート）設計仕様書

Version: 0.1
Author: Yuji Imaizumi
Last Updated: 2026-01-09 (Asia/Tokyo)

---

## 1. 目的 / ゴール

スマホで直感的に入力（テキスト・音声入力・レシート撮影）できる家計簿Webアプリを、GAS Webアプリとして提供する。
入力は「受付（AI）」が解釈・分類し、Googleスプレッドシート（台帳）へ自動記帳する。
当月・前月・過去月の利用状況を、グラフと数値で分かりやすく見える化し、節約・使いすぎ検知につなげる。

---

## 2. 非ゴール（当面やらない）

- 銀行/カード明細の自動取得（スクレイピング・金融API連携）
- レシートの複数明細（1枚のレシートから複数商品を完全に明細化）※将来拡張
- 複数ユーザー（家族アカウント）管理 ※将来拡張
- アプリストア配布（ネイティブアプリ化）

---

## 3. 全体アーキテクチャ

### 3.1 コンポーネント
- **GAS Webアプリ**
  - スマホUI（HTML/JS/CSS）
  - APIエンドポイント（doGet / google.script.run）
  - OpenAI API呼び出し（分類・抽出）
  - スプレッドシートへ追記 / 集計
- **Googleスプレッドシート**
  - マスター（分類・口座・設定）
  - 取引ログ（Transactions）
  - 月次集計（Monthly）
  - ダッシュボード（Dashboard）
- **OpenAI API（マルチモーダル）**
  - テキスト入力 → 取引JSON化
  - 画像入力（レシート）→ 取引JSON化
  - Structured Output（JSON Schema）で出力固定

### 3.2 データフロー（基本）
1. ユーザーがスマホで入力（テキスト / レシート画像）
2. GASがOpenAIへ送信し、取引データを**JSON**で受領
3. GASが `04_Transactions` に1行追加（append）
4. Dashboard/Monthlyが自動更新（もしくはGASが再計算トリガー）

---

## 4. スプレッドシート設計（タブ構成 / ヘッダー仕様）

> テンプレートExcel: `kakeibo_master_template.xlsx`
> 本MDは、そのテンプレ構成に準拠する。

### 4.1 タブ一覧
| タブ名 | 役割 | 書き込み主体 |
|---|---|---|
| 00_Readme | 使い方・注意事項 | 手動 |
| 01_Settings | カテゴリ大分類・支払方法などの設定 | 手動 |
| 02_Categories | category/subcategory 辞書（キーワード補正） | 手動（将来GASで学習追加可） |
| 03_Accounts | 口座/財布/カード一覧 | 手動 |
| 04_Transactions | **明細ログ（唯一の自動追記先）** | **GAS** |
| 05_Monthly | 月次合計（自動集計） | 自動（関数） |
| 06_Dashboard | 見える化（対象月切替、円/折れ線） | 自動（関数） |
| 07_Insights | 使いすぎ/節約などの分析結果の表示領域 | 自動（GAS or 関数） |
| 08_Archive | 月締めスナップショット（固定値保存） | GAS（任意） |

---

### 4.2 `01_Settings`（設定）
#### 概要
カテゴリ大分類・支払方法候補など、アプリ全体の基準値を管理する。

#### 主要項目（例）
- 通貨（JPY）
- 月の開始日（1=毎月1日）
- カテゴリ大分類リスト
- 支払方法候補リスト

> ここを元に `04_Transactions` の入力補助（ドロップダウン）や集計の基礎が動く。

---

### 4.3 `02_Categories`（分類マスター）
#### ヘッダー
| 列名 | 型 | 説明 |
|---|---|---|
| category | string | 大分類（01_Settingsのリストに合わせる） |
| subcategory | string | 小分類 |
| keywords（任意） | string | カンマ区切りキーワード（merchant/item等との一致で補正） |
| priority | number | 競合時の優先度（大きいほど優先） |
| budget_group（任意） | string | needs / wants / income 等（分析用） |
| note | string | メモ |

#### 用途
- GPT分類の補正（辞書マッチ）
- UIでカテゴリ選択候補の表示
- 分析（needs/wants比率等）

---

### 4.4 `03_Accounts`（口座/財布）
#### ヘッダー
| 列名 | 型 | 説明 |
|---|---|---|
| account_name | string | 表示名（現金/メイン口座/カード等） |
| account_type | string | Cash/Bank/Card 等 |
| opening_balance | number | 初期残高（将来の残高推移で使用） |
| note | string | メモ |

---

### 4.5 `04_Transactions`（明細ログ：最重要）
#### 概要
**GASが追記する唯一の表。**
月別管理はここをフィルタ/集計して実現する（「月ごとに別シート」は作らない方針）。

#### ヘッダー（テンプレ準拠）
| 列 | 列名 | 型 | 必須 | 説明 |
|---:|---|---|---|---|
| A | id | number/string | 推奨 | 連番 or UUID（GASで採番） |
| B | date | date/string | 必須 | 取引日（YYYY-MM-DD） |
| C | type | enum | 必須 | expense / income / transfer |
| D | account | string | 任意 | 03_Accountsのaccount_name |
| E | merchant | string | 任意 | 店名/支払先 |
| F | item | string | 任意 | 品目（例：ラテ） |
| G | category | string | 必須 | 大分類 |
| H | subcategory | string | 任意 | 小分類 |
| I | payment_method | string | 任意 | 01_Settingsの支払方法候補 |
| J | amount | number | 必須 | 金額（支出=正、収入=正でも可。実装方針で統一） |
| K | memo | string | 任意 | メモ |
| L | tags | string | 任意 | カンマ区切りタグ（例：家族/仕事/臨時） |
| M | source | string | 任意 | text / receipt / manual |
| N | confidence | number | 任意 | AI推定確信度（0-1） |
| O | receipt_file_id | string | 任意 | Drive保存したレシートのFileId |
| P | raw_text | string | 任意 | 元入力（監査・再学習用） |
| Q | status | enum | 必須 | confirmed / pending / needs_review |

#### データ規約（推奨）
- `amount`: **支出は正の数**、収入も正の数（typeで区別）に統一する（集計が簡単）
- `date` が不明の場合は `pending` として追加し、UIで追加入力を促す
- `status`：
  - confirmed: 確定
  - pending: 情報不足（追質問待ち）
  - needs_review: AIが自信低い/異常値

---

### 4.6 `05_Monthly`（月次サマリー）
#### 概要
Transactionsから月別の支出・収入・収支を算出。
過去24か月を用意し、Dashboardの月選択に利用する。

#### ヘッダー
| 列名 | 型 | 説明 |
|---|---|---|
| month_start | date | 月初日（YYYY-MM-01） |
| total_expense | number | 当月支出合計 |
| total_income | number | 当月収入合計 |
| net | number | 収支（収入-支出） |

---

### 4.7 `06_Dashboard`（見える化）
#### 概要
対象月を切り替え、KPI・カテゴリ別円グラフ・過去12か月推移などを表示。

#### 主な領域
- 対象月（B2）：ドロップダウン
- KPI：支出合計/収入合計/収支
- カテゴリ別支出：カテゴリ一覧×SUMIFS
- 過去12か月推移：Monthly参照×折れ線

---

### 4.8 `07_Insights`（分析表示）
#### 概要
GASで計算した「使いすぎ」「節約成功」「前月比」「固定費比率」等を表示する領域。
最初は文面・数値のみ、将来カードUI化。

#### 例（将来）
- 当月支出 前月比（%）
- 使いすぎカテゴリTOP3（前月比+金額）
- 節約成功カテゴリTOP3
- needs/wants比率
- 店舗TOP5（merchant別）

---

### 4.9 `08_Archive`（月締め）
#### 概要
「月締め」操作をした時点の数値を固定保存する（後から履歴が動かない）。

#### ヘッダー
| 列名 | 型 | 説明 |
|---|---|---|
| month_start | date | 対象月 |
| closed_at | datetime | 締め日時 |
| total_expense | number | 締め時点支出 |
| total_income | number | 締め時点収入 |
| note | string | メモ |

---

## 5. UI仕様（スマホ優先・かわいい/淡色）

### 5.1 画面構成（最小）
1. **ホーム**
   - かんたん入力（テキスト）カード
   - レシート撮影カード
   - 今月のサマリー（支出合計・残り予算など）カード
2. **履歴**
   - 月切替（プルダウン/左右スワイプ）
   - 取引一覧（カード形式、カテゴリ色アイコン）
   - フィルタ（カテゴリ/支払方法）
3. **分析**
   - 円グラフ（カテゴリ別）
   - 推移（過去12か月）
   - 使いすぎ/節約の気づき（Insights）

### 5.2 デザイン指針
- 角丸（12〜16px）、カードUI
- 淡い背景色（パステル系）、強い原色は避ける
- 主要操作は大ボタン（親指操作）
- 入力→確認→確定の導線を短く（確認は任意でON/OFF）

---

## 6. AI（分類/抽出）仕様

### 6.1 入力パターン
- テキスト例：
  - 「昨日 スタバ 620円 ラテ」
  - 「交通費 180円」
  - 「給料 250000円」
- 画像（レシート）：
  - レシート全体写真（可能なら店名・合計金額が写るように）

### 6.2 出力（取引JSON）— Structured Output（JSON Schema）
GASが扱いやすいよう、常に同じJSONを返す。

```json
{
  "type": "transaction",
  "date": "2026-01-08",
  "txn_type": "expense",
  "amount": 620,
  "merchant": "スターバックス",
  "item": "ラテ",
  "category": "食費",
  "subcategory": "カフェ",
  "payment_method": "現金",
  "memo": "",
  "confidence": 0.82,
  "needs_clarification": false,
  "clarification_questions": []
}
```

※スプレッドシートの 04_Transactions.type と衝突しないよう、JSON側は txn_type を推奨。

### 6.3 不明時の挙動
- date/amount/カテゴリが曖昧 → needs_clarification=true にして質問を返す
- confidenceが低い（例：<0.6） → status を needs_review にする

---

## 7. GAS サーバ仕様（関数/エンドポイント）

### 7.1 Webアプリ
- doGet(): index.htmlを返す（ホーム）

### 7.2 クライアント→サーバ（google.script.run）
- processText(text: string) -> transaction_json
- processReceipt(dataUrl: string) -> transaction_json
- （任意）listTransactions(monthStart) -> rows
- （任意）getDashboard(monthStart) -> summary

### 7.3 記帳ロジック
1. OpenAIへ送信
2. JSON受領
3. 02_Categories で辞書補正（キーワード一致があれば上書き）
4. 04_Transactions に1行追加
5. status決定（confirmed/pending/needs_review）

### 7.4 シークレット管理
- OpenAI API Keyは スクリプトプロパティに保存（OPENAI_API_KEY）

---

## 8. 集計 / グラフ仕様（初期）

### 8.1 月次合計（Monthly）
- 当月支出合計
- 当月収入合計
- 収支（収入-支出）
- 過去24か月保持

### 8.2 ダッシュボード（Dashboard）
- 対象月を切替できる
- KPI（支出/収入/収支）
- カテゴリ別円グラフ（支出）
- 過去12か月支出推移（折れ線）

### 8.3 インサイト（Insights）
- 前月比（支出）
- 使いすぎカテゴリ（前月比+金額）
- 節約成功カテゴリ（前月比-金額）

---

## 9. 将来拡張（ロードマップ案）

- 予算機能：
  - Budgets シート追加（category/月/予算）
  - Dashboardで「予算残」表示
- 複数明細（レシート内の商品行の抽出）
- 家族ユーザー（user_id列追加、UIで切替）
- 支払いの締日（クレカ締め等）対応
- エクスポート（CSV/PDF）

---

## 10. 添付（テンプレ）

- kakeibo_master_template.xlsx（本会話で生成したテンプレ）
  - タブ構成・列構成の基準
  - 初期ダッシュボード/集計の雛形

---

## 11. 関連ドキュメント（予定）

必要に応じて以下のドキュメントも作成可能：

- `api-contract.md`（OpenAI入出力JSON Schema、GAS関数I/F、エラーコード）
- `ui-spec.md`（画面遷移、コンポーネント、配色/タイポ）
- `data-dictionary.md`（全カラム定義、正規化ルール、例データ）
