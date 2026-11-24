# Homes

家庭用ウェブアプリ。GitHub Pages は公開の入口です。家庭の情報は、リポジトリ・Pages・URL・ログに置かないでください。

## Google ログイン

認証・ログイン後の画面は専用の Cloudflare Worker で配信します。Pages はトップレベルのリンクで移動させるだけです。Safari のサードパーティ Cookie に依存せず、Google トークンをブラウザーや Works に渡しません。Homes が Google による確認済みアカウントを許可リストと照合し、Worker の Cookie と失効可能なサーバー側セッションを使います。有効時間はログインから8時間です。Workers 無料枠の上限を利用前に確認してください。

### 本番の準備

1. Workers で Homes 専用の `homes-auth` を準備し、専用 HTTPS オリジン（例: `https://homes-auth.<account>.workers.dev`）を確定します。設定や認証情報を Works から流用しません。
2. Google Cloud の Homes 専用プロジェクト、または Homes 専用の Web アプリ OAuth クライアントを用意します。Google Auth Platform で表示名・サポート情報・公開範囲を確認し、Google 側の許可されたリダイレクト URI を **そのオリジン + `/auth/callback`** に設定します。JavaScript オリジンの設定は不要です。権限は `openid email` のみです。[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
3. Worker の設定に `HOMES_AUTH_ORIGIN`（末尾スラッシュなし）、`GOOGLE_CLIENT_ID` を設定し、`GOOGLE_CLIENT_SECRET` と `HOMES_OWNER_EMAIL` を Worker の Secrets に登録します。必要に応じて `HOMES_OWNER_SUB` も Secret に登録し、Google の不変アカウント ID に制限します。Gmail 以外のアドレスでは `HOMES_OWNER_SUB` 必須です。実値を GitHub やチャットに載せないでください。
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
