# freee × Claude 自動仕訳システム セットアップガイド

銀行口座・クレジットカードの未処理明細を毎日自動で取得し、Claude（AI）が勘定科目・税区分を判定してfreee会計に取引として登録する仕組みです。

## 仕組み

```
毎日 6:00 JST（GitHub Actions）
  │
  ├─ 1. freee API: 未処理明細（消込待ち）を取得
  ├─ 2. Claude: 勘定科目・税区分・摘要を判定（確信度つき）
  ├─ 3. freee API: 確信度が高いものだけ取引として自動登録
  └─ 4. 確信度が低いものは「要レビュー」としてActionsのサマリーに表示
```

- 二重登録防止のため、処理済み明細IDは `freee-journal-log.json` に記録されます
- `DRY_RUN` モードで「登録せずに判定結果だけ確認」もできます（初回はこれを推奨）

---

## セットアップ手順

### 1. freeeアプリを作成する

1. [freeeアプリストアの開発者ページ](https://app.secure.freee.co.jp/developers/applications) にログイン
2. 「新規アプリ作成」→ アプリ名（例: `自動仕訳Bot`）を入力し **プライベートアプリ** として作成
3. 権限設定で **会計freee** の以下を「読み取り・更新」にする
   - 取引（収入・支出）
   - 口座・明細
   - 決算・申告に関わるマスタ（勘定科目・税区分の読み取り）
4. コールバックURLは初期値 `urn:ietf:wg:oauth:2.0:oob` のままでOK
5. 表示された **Client ID** と **Client Secret** を控える

### 2. 初回認可（トークン取得）— ローカルPCで1回だけ

```bash
git clone https://github.com/trainersgym00-creator/trainers-gym-lp-b.git
cd trainers-gym-lp-b
npm install
FREEE_CLIENT_ID=＜Client ID＞ FREEE_CLIENT_SECRET=＜Client Secret＞ node freee-get-token.js
```

画面の指示に従ってブラウザで認可すると、**リフレッシュトークン**と**事業所ID**が表示されます。

### 3. GitHub Secretsを登録する

リポジトリの `Settings → Secrets and variables → Actions → New repository secret` で以下を登録：

| Secret名 | 値 |
|---|---|
| `FREEE_CLIENT_ID` | freeeアプリのClient ID |
| `FREEE_CLIENT_SECRET` | freeeアプリのClient Secret |
| `FREEE_REFRESH_TOKEN` | 手順2で表示されたリフレッシュトークン |
| `FREEE_COMPANY_ID` | 手順2で表示された事業所ID |
| `ANTHROPIC_API_KEY` | 登録済み（LP最適化と共用） |
| `PAT_TOKEN` | 登録済み。**`repo`スコープ（Secretsの更新権限）が必要**（トークン自動更新に使用） |

> 💡 freeeのリフレッシュトークンは**1回使うと無効になり、新しいものに入れ替わる**仕様です。
> このシステムは実行のたびに新しいトークンを `FREEE_REFRESH_TOKEN` シークレットへ自動で書き戻します（`PAT_TOKEN` を使用）。

### 4. まずはDRY RUNで動作確認

1. GitHubリポジトリの `Actions → freee自動仕訳 → Run workflow`
2. **dry_run にチェックを入れて**実行
3. 実行後のサマリー画面で、AIの仕訳判定結果を確認
4. 問題なければ、次回からチェックなしで実行（毎日6:00 JSTに自動実行されます）

---

## 運用ルール（重要）

### ⚠️ freee APIの制約: 明細の「消込」はAPIからできません

freee APIには「自動で経理」画面の明細を消込済み（処理済み）にする機能がありません（[公式にも認識されている制約](https://github.com/freee/freee-api-schema/issues/541)）。そのため：

- **帳簿（仕訳）はこのシステムで正しく登録されます**が、freeeの「自動で経理」画面には同じ明細が「未処理」として残り続けます
- **残った明細をfreeeのUIから手動で登録しないでください**（二重計上になります）
- 月次で「自動で経理」画面を開き、このシステムが登録済みの明細（Actionsのサマリーやログで確認できます）を**まとめて「無視」**にしてください

### 要レビューになった明細の処理

確信度が低い明細（デフォルト0.75未満）は自動登録されません。Actionsのサマリーに理由つきで表示されるので、freeeの「自動で経理」画面から通常どおり手動で登録してください（手動登録した明細は消込もされるので二重計上になりません）。

### 設定のカスタマイズ

`.github/workflows/freee-auto-journal.yml` の `env:` に追加して調整できます：

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `FREEE_SYNC_DAYS` | `30` | 何日前までの明細を対象にするか |
| `FREEE_MAX_TXNS` | `50` | 1回の実行で処理する明細の上限 |
| `FREEE_MIN_CONFIDENCE` | `0.75` | この確信度未満は自動登録せずレビューへ |

---

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| `トークン更新失敗 (401)` | リフレッシュトークンが失効しています（90日間未使用、または保存失敗）。手順2の初回認可をやり直し、`FREEE_REFRESH_TOKEN` シークレットを更新してください |
| `Secret更新エラー` | `PAT_TOKEN` に `repo` スコープがあるか確認してください。このエラーが出た次の実行は401になるため、手順2で再認可が必要です |
| 仕訳の科目がおかしい | `freee-auto-journal.js` のプロンプト内「事業の背景」を実態に合わせて加筆すると精度が上がります。また `FREEE_MIN_CONFIDENCE` を上げると自動登録が慎重になります |
| 誤って登録された取引を消したい | freeeの「取引一覧」から該当取引を削除し、`freee-journal-log.json` から該当明細IDのエントリを削除してください |
