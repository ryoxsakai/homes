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

## ToDo・メモ（Works から移植）

ログイン後の画面は [Works](https://github.com/ryoxsakai/works) の ToDo・メモ・共通ヘッダー（PC の左サイドバー、スマホのドロワーと下部のサービス切替バー、クイック追加）をそのまま使い、配色だけを Homes の暖色に置き換えています。スマホの下部バーは左右スワイプで ToDo ⇄ メモを切り替え、前回使ったサービスに戻ります。

- 画面のファイルは `public/` にあり、Workers の静的アセットとして配信します。`run_worker_first` により、すべてのファイルは Worker のログイン確認を通った家族にだけ返します。
- Works から外したもの：生徒の紐付け、授業記録からの起点、Google カレンダー反映、プッシュ通知、Google フォント（外部読み込みなし）。Works の認証（`shared/auth.js`）は、Homes の HttpOnly Cookie を使う同名の薄い実装に差し替えています。
- メモ画面の `onclick` 等は、厳格な CSP（インラインスクリプト不可）に合わせて `data-onclick` に置き換え、`shared/inline-handlers.mjs` が名前付き関数だけを呼び出します。
- 配色は `public/shared/homes-theme.css` で Works のデザイントークン（`--works-*`）を上書きしています。
- API は同一オリジンのみ：`GET /api/me`、`GET|PUT /api/todo`、`GET|POST /api/todo/clone`、`GET|PUT /api/memo`。Works と同じく文書全体を revision 付きで保存し、古い画面からの上書きは 409 で拒否します。検証ルールは `worker/state.mjs`。
- 保存先は従来どおり SQLite Durable Object `HOME_STORE`（`homes-data-v1:household`）の `documents` テーブルです。初回の読み込み時に、旧 `todos` / `notes` テーブルの内容を一度だけ Works 形式へ変換します（旧テーブルは残します）。各文書は 1.5MB まで。
- ToDo の作成者・最終更新者・完了者はサーバーがログイン中の家族の表示名から決め、ブラウザーの値は使いません。一覧には代表 1 人、詳細には 3 つを分けて表示します。
- セッション切れ（8時間）で API が 401 を返すと、画面のデータを残さずログイン画面へ戻ります。

## 本棚（絵本の管理）

`/books/` は家族の絵本を管理する画面です。ToDo・メモと同じく、ログインした家族だけが使えます。

- **登録**：「本を登録」（またはヘッダーのクイック追加）でカメラが起動し、裏表紙の ISBN バーコード（978/979 で始まる上段）を読み取ります。下段の価格バーコード（192…）は無視し、案内を出します。ISBN（13桁・10桁）の手入力、ISBN のない本の手入力にも対応します。登録済みの ISBN を読んだときは、その本の詳細を開きます。
- **読み取り方式**：Android の Chrome などは標準の `BarcodeDetector`、iPhone の Safari など未対応の環境では `public/books/vendor/` に同梱した [ZXing](https://github.com/zxing-js/library)（Apache-2.0）で読み取ります。映像は端末内で処理し、送信しません。カメラは HTTPS でのみ使えます。
- **書誌と表紙**：Worker が Google Books API から書名・著者・出版社・出版日を取得し、表紙も `GET /api/books/cover?id=…` で中継します。ブラウザーは Google に直接接続せず、ページの CSP（`img-src 'self'`）もそのままです。表紙は Cloudflare のエッジに30日、ブラウザーに7日キャッシュします。Google Books に無い本や表紙の無い本は、タイトル入りの仮表紙で表示します。
- **表紙写真**：自動取得できない場合は「写真を選ぶ」「表紙を撮影」で、登録時または登録済みの本に追加できます。選んだ写真は端末で小さいJPEGに変換してから、書誌情報と同時に保存します。表紙は家族だけが見られます。写真を外すか、本を削除すると保存した写真も削除します。
- **書誌の予備検索**：Google Booksで対象ISBNが見つからない、または検索に失敗した場合は、[国立国会図書館サーチ](https://ndlsearch.ndl.go.jp/help/api)の国立国会図書館作成レコードからISBNが一致する書誌情報を取得します。予備検索では表紙は取得しません。
- **項目**：借りた／持っている／欲しい、場所、カテゴリ、タグ（自由入力、30個まで）、メモ。場所とカテゴリは「分類と場所」で追加・名前の変更（登録済みの本にも反映）・並び順の変更・削除ができます。登録した家族の表示名はサーバーが記録します。
- **一覧**：表紙のグリッド／リスト表示、所有状況・カテゴリ・場所・タグでの絞り込み、検索（タイトル・著者・タグ・メモ・ISBN）、並べ替え（登録日・タイトル・著者・出版日・場所・カテゴリ）。並べ替えと表示形式だけをブラウザーに記憶します。タイトル順は文字コード順に近い日本語照合のため、漢字の書名は読みの順になりません。
- **API**：`GET|PUT /api/books`（本棚全体を revision 付きで保存。検証は `worker/books.mjs`）、`GET /api/books/lookup?isbn=…`、`GET /api/books/cover?id=…`。保存先は他と同じ Durable Object の `documents` テーブル（`kind = 'books'`、最大3000冊）。
- **Google Books の API キー（任意）**：キーなしでも動きますが、Cloudflare の共有 IP からの無認証リクエストは利用上限に当たりやすいため、Google Cloud で Books API を有効にした API キーを Worker の Secret `GOOGLE_BOOKS_API_KEY` に登録することをおすすめします（`npx wrangler secret put GOOGLE_BOOKS_API_KEY`）。上限に当たった場合は、画面から手入力で登録できます。キーは URL ではなく `X-Goog-Api-Key` ヘッダーで送ります。Google が拒否した場合は、理由（キーが無効、Books API が無効、キーの制限、利用上限、キー未設定）を画面に表示し、Worker のログにも状態コードと理由を残します。失敗した応答はエッジにキャッシュしません。

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
