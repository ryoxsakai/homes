# Homes

家庭用ウェブアプリ。GitHub Pages は公開の入口です。家庭の情報は、リポジトリ・Pages・URL・ログに置かないでください。

## Google ログイン

認証・ログイン後の画面は専用の Cloudflare Worker で配信します。Pages はトップレベルのリンクで移動させるだけです。Safari のサードパーティ Cookie に依存せず、Google トークンをブラウザーや Works に渡しません。Homes が Google による確認済みアカウントを許可リストと照合し、Worker の Cookie と失効可能なサーバー側セッションを使います。有効時間はログインから8時間です。Workers 無料枠の上限を利用前に確認してください。

### 本番の準備

1. Workers で Homes 専用の `homes-auth` を準備し、専用 HTTPS オリジン（例: `https://homes-auth.<account>.workers.dev`）を確定します。設定や認証情報を Works から流用しません。
2. Google Cloud の Homes 専用プロジェクト、または Homes 専用の Web アプリ OAuth クライアントを用意します。Google Auth Platform で表示名・サポート情報・公開範囲を確認し、Google 側の許可されたリダイレクト URI を **そのオリジン + `/auth/callback`** に設定します。JavaScript オリジンの設定は不要です。権限は `openid email` のみです。[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
3. Worker の設定に `HOMES_AUTH_ORIGIN`（末尾スラッシュなし）、`GOOGLE_CLIENT_ID` を設定し、`GOOGLE_CLIENT_SECRET` を Worker の Secrets に登録します。アクセス許可は後述の `HOMES_FAMILY_MEMBERS`、または従来の単独管理者用 `HOMES_OWNER_EMAIL` で設定します。後者では必要に応じて `HOMES_OWNER_SUB` も Secret に登録し、Google の不変アカウント ID に制限します。Gmail 以外のアドレスでは `HOMES_OWNER_SUB` 必須です。実値を GitHub やチャットに載せないでください。
4. `npm ci`、`npm test` を実行し、管理者の Wrangler または Cloudflare のビルド設定で Worker をデプロイします。設定が欠けている場合、Worker はログインを有効化しません。なお Wrangler で variables を別途設定済みならデプロイ時に `--keep-vars` を付けて保持します。Worker は Zero Trust や DNS の変更を必要としません。
5. HTTPS の専用 URL で、許可アカウントのログイン、別アカウントの拒否、ログアウト後に保護画面が見えないことを確認します。iPhone のホーム画面から直接開いた場合に Google がログインを拒否するなら、Safari または Chrome で開いてください。
6. 確認後、`homes-launch.mjs` の `homesOrigin` にその HTTPS オリジンだけを設定し、本番 Pages からリンクを表示します。ログインで保護されるのは Worker 側だけです。

### 検証

```sh
npm ci
npm test
```

テストは署名付きのテスト用 ID トークンと模擬 OAuth 通信を使用し、本番資格情報は不要です。

公開後は無認証のログイン開始リクエスト数と Workers の使用量をご確認ください。家庭の情報を扱い始める前に、必要に応じてレート制限と保護対象のアクセス制御を追加してください。

## ToDo・メモ

許可されたアカウントで認証後、専用 Worker の `/app` で利用します。GitHub Pages には公開の入口だけを置き、`worker/` と `test/` は公開ビルドから除外します。本文・タイトル・期限はブラウザーの永続ストレージに保存しません。ブラウザーに保存するのは表示設定のみです。

- ToDo：タイトル・任意の期限を登録・編集し、完了・未完了を切り替えます。期限は `YYYY-MM-DD` の日付のみで保存し、一覧では日本時間の日付と比較します。
- メモ：タイトル・本文を登録・編集・検索できます。競合した更新は先に保存された内容を優先し、古い画面から上書きしません。
- 認証用 `AUTH_STORE` とは独立した SQLite Durable Object `HOME_STORE` を `v2` で追加します。保存先はサーバー固定の `homes-data-v1:household` です。環境変数による保存先設定は不要で、ブラウザーからも変更できません。以前の UUID はローカル試験用で、本番では使いません。本番データのある状態で、保存先の名前を変更する場合は明示的な移行が必要です。
- ToDo・メモは各200件、タイトル120文字・メモ本文12,000文字まで。削除は元に戻せません。

### 家族それぞれの Google ログインと ToDo の操作表示

各自の Google アカウントを使います。管理者は Cloudflare Worker の非公開シークレット
`HOMES_FAMILY_MEMBERS` に次のような JSON 配列を登録します（以下は架空の値）。

```json
[
  {"email":"example-one@gmail.com","alias":"家族A"},
  {"email":"example-two@gmail.com","alias":"家族B"}
]
```

表示名とメールアドレスは重複させません。Gmail 以外は事前に本人と確認した Google の
不変アカウント ID（`sub`）を同じ項目に必ず指定します。Gmail にも指定できます。
これらは公開リポジトリやフロントエンドに保存しません。設定すると従来の
`HOMES_OWNER_EMAIL` / `HOMES_OWNER_SUB` に代わり、家族リストだけが有効です。
不正な設定はアクセスを拒否し、リストから削除した人は既存セッションでもアクセスできません。
家族メンバーは固定の同一世帯で ToDo とメモを読み書きします。

ToDo は操作時の表示名だけを「作成」「最終更新」「完了」として保存・表示します。
完了を取り消すと完了者を消し、再完了すると操作者を記録します。この機能を導入する前の行には
操作者が入らず、後から表示名を変えても過去の表示名は書き換えません。
これは全操作の履歴ではなく、個々の ToDo の現在の状態に関連する表示です。

### iPhoneのホーム画面に追加

GitHub Pages は案内ページです。アプリとして使うときは、Safari で Homes の
ログイン先（`HOMES_AUTH_ORIGIN`）を直接開いて Google ログインし、「共有」→
「ホーム画面に追加」で「ウェブアプリとして開く」をオンにします。すでに
案内ページを追加済みの場合も、実際のログイン先から新しく追加してください。
ログイン画面とアプリ本体は同一オリジンです。認証時に Google の画面へ移動する
ことがあります。ToDo・メモのオフライン保存は行いません。

### カスタムドメイン

`https://homes.lrnr.jp` と、従来の `HOMES_AUTH_ORIGIN` は、同じ Worker と
家庭データを使います。従来の環境変数は変えず、Google OAuth の「承認済みの
リダイレクト URI」に `https://homes.lrnr.jp/auth/callback` を追加してください。
従来の URI も残します。認証 Cookie はホストごとに独立するため、新しい URL では
Google ログインが必要です。iPhone のホーム画面も、新しい URL の Safari 画面から
追加し直してください。
