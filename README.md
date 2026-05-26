# Aster Stella（アステルステッラ）

ステッラシステムの一部。ネット上の人たちが操作する WEB ページ。
第一段階として、地図（MapChart 形式の SVG）から各ステートの **接続関係（隣接関係）** を
JSON 化するツールを実装している。

## ファイル構成

```
Aster_Stella/
  index.html                ページ本体（接続関係エディタ）
  admin.html                管理者ページ（ステートのステータス編集）
  nations.html              国家管理ページ（建国・編集・領土編入）
  css/style.css             スタイル（モバイル対応 / iOS ぼやけ対策）
  js/app.js                 接続関係エディタの処理
  js/admin.js               管理者ページの処理
  js/nations.js             国家管理ページの処理
  js/adjacency.js           隣接関係の計算アルゴリズム
  js/state-schema.js        ステートのフィールド定義
  js/nation-schema.js       国家のフィールド定義
  js/random-placement.js    資源のランダム配置
  js/map-pan-zoom.js        SVG viewBox 方式のパン/ズーム
  js/firebase-config.js     Firebase 設定（Realtime Database）
  MapChart_Map.svg          地図データ（差し替え可能）
  aster_stella_map.json     接続関係のキャッシュ（任意）

  player-login.html         playerサイド ログイン画面
  player.html               playerサイド メイン画面（タブ式）
  js/player-login.js        ログイン処理
  js/player-auth.js         セッション認証（sessionStorage）
  js/player.js              メイン画面の処理（全タブ）
  js/player-schema.js       予約(order)種別・市場・ログのスキーマ
  js/orders.js              予約キュー（append-only / 競合回避）
  js/economy.js             共有経済モデル（産業・資源・景気の式）
  js/charts.js              依存なしの軽量SVGチャート
  gas/Code.gs               GAS ターン処理・Sheetsバックアップ・API
  gas/appsscript.json       GAS プロジェクト設定（ウェブアプリ）
```

## playerサイド

プレイヤーは `player-login.html` で自国（管理者が nations.html でパスワード設定済みの国家）に
ログインし、`player.html` で内政・産業・経済・研究などの操作を行う。

### 予約方式（重要なアーキテクチャ）

プレイヤーの操作は集計済みステータスを直接書き換えず、
`aster_stella/nations/{id}/orders/{orderId}` に **1件ずつ固有キーの「予約」** として積む。
GAS が一定時刻に全国家分を読み込んで一斉処理（ターン進行）する。

- 予約は配列まるごとではなく子ノード単位で読み書きするため、複数プレイヤーが
  同時に操作しても、また GAS 処理中に予約が追加されても、上書きで消えない。
- GAS は処理した予約キーだけを個別削除し、集計値は PATCH（merge）で書く（orders には触れない）。

### GAS の設定

1. `gas/Code.gs` を Apps Script プロジェクトに貼り付ける。
2. `setupProperties()` を1回実行し、ログに出る `API_KEY` を控える（`DATABASE_URL` は自動設定）。
3. `setupTriggers()` を1回実行（`runTurn` 6時間ごと / `backupToSheets` 毎日3時）。
4. ウェブアプリとしてデプロイすると入出力APIが使える:
   - 吐き出し: `GET ?key=APIKEY&path=aster_stella/nations`
   - バックアップ取得: `GET ?key=APIKEY&action=backup&date=yyyy-MM-dd`
   - 入力: `POST {"key":APIKEY,"path":"aster_stella/...","value":...}`
5. 計算式の調整はスプレッドシートの `Config` シート（key/value）で上書きできる。
   バックアップは同スプレッドシートの `Backup` / `Nations` シートに保存される。

## ローカルサーバーでの開き方

ES モジュールと SVG の fetch を使うため、`file://` で直接開くと動きません。
**ローカルサーバー経由**で開いてください。このフォルダ内で次のどれかを実行します。

Python（Windows なら標準で入っていることが多い）:

```
python -m http.server 8000
```

Python が `py` の場合:

```
py -m http.server 8000
```

Node.js がある場合:

```
npx serve -l 8000
```

起動したらブラウザで以下を開きます:

```
http://localhost:8000/
```

止めるときはターミナルで `Ctrl + C`。

## 使い方

1. ページを開くと地図が表示される。
2. 「接続関係をJSONにする」を押すと、各ステートの隣接関係を計算して JSON を表示する。
3. 地図のステートをタップすると、そのステート（青）と隣接ステート（オレンジ）が色分け表示される。隣接の確認用。
4. JSON は手で編集できる。海をまたぐ接続など、幾何的に求められないものはここで追記する。
5. 「JSONをダウンロード」でローカル保存、「Firebaseに保存」で Realtime Database に保存。
6. 「Firebaseから読込」で保存済みデータを呼び出す。

判定がうまくいかないときは「判定距離 (threshold)」「サンプル間隔 (step)」を調整して再生成する。
- 隣接しているのに繋がらない → threshold を大きく
- 隣接していないのに繋がる → threshold を小さく

## 隣接関係の計算方法（adjacency.js）

1. `<svg id="map">` 直下の各 `<path>`（= ステート）の輪郭上に、一定間隔でサンプル点を取る。
2. サンプル点を格子（spatial hash）に登録する。
3. 別ステートのサンプル点が `threshold` 以内にあれば、その2ステートを「隣接」と判定する。

出力 JSON の形式:

```json
{
  "meta": {
    "generatedAt": "...",
    "source": "MapChart_Map.svg",
    "stateCount": 1046,
    "connectionCount": 0,
    "threshold": 1.5,
    "sampleStep": 1
  },
  "adjacency": {
    "ステート名": ["隣接ステート名", "..."]
  }
}
```

地図を更新したいときは `MapChart_Map.svg` を差し替えて、再度ボタンを押せば JSON が更新される。

## 国家管理ページ（nations.html）

`aster_stella/nations` に国家データを保存し、地図上のステートを編入することで領土を作る。

主な操作:

- 「新規建国」 ... 国家を作成（自動的に未使用のカラーが割り当てられる）
- 国家リスト ... タップで選択。選択中の国家がフォームで編集可能になる
- 編集できるステータス: 正式国名 / 略称 / 国家色 / 首都 / イデオロギー / 政体 / 建国年 /
  安定度 / 戦争支持率 / 政治力 / 国庫 / 兵力 / 技術水準 / 外交力 / 威信 / 自由記述
- クリック動作の切り替え:
  - 情報表示: タップしたステートの所属を表示
  - 建国モード: タップしたステートを選択中の国家に編入
  - 編入解除: タップしたステートを未所属に戻す
  - 首都指定: タップしたステートを選択中の国家の首都にする（自動編入も行う）
- 地図はその国家の色で塗られる。首都は濃い枠で強調される
- 「Firebaseに保存」で国家データ（`aster_stella/nations`）と各ステートの所属
  （`aster_stella/states/{name}/country` に国家ID）を一括保存

ステート編集ページ（admin.html）は国家データが存在する場合、「所属国家」フィールドが
プルダウンになり、表示モード「所属国家」では実際の国家色で地図を塗る。

## Firebase について

- 保存先（地図接続）: `aster_stella/map`
- 保存先（ステート）: `aster_stella/states`
- 保存先（国家）  : `aster_stella/nations`
- 設定は `js/firebase-config.js`（CDN の ES モジュールを使用、ビルド不要）

### 書き込み権限

保存でエラーが出る場合は、Firebase コンソールの Realtime Database のルールを確認する。
開発中だけ緩める例（**公開前に必ず見直すこと**）:

```json
{
  "rules": {
    "aster_stella": {
      ".read": true,
      ".write": true
    }
  }
}
```

### npm 版を使いたい場合

CDN ではなく npm で管理したいときは:

```
npm install firebase
```

その上で `firebase-config.js` の import を `from "firebase/app"` などに変えるが、
その場合はバンドラ（Vite など）が必要になる。GitHub Pages にそのまま載せる前提なら
現状の CDN 版が手間が少ない。

## GitHub への移植

このフォルダはビルド不要の静的サイトなので、そのまま GitHub Pages に載せられる。

1. リポジトリを作成して push する。
2. リポジトリの Settings > Pages で、ブランチ（`main` など）の `/root` を公開対象にする。
3. 公開された URL を開けば、ローカルと同じように動作する。

## 地図のパン/ズーム

`js/map-pan-zoom.js` が SVG の `viewBox` を直接書き換える方式で
パン/ズームを実装している。CSS `transform: scale()` 方式と違い、
何倍に拡大してもラスタライズされず、iOS Safari でも輪郭がぼやけない。

操作:

- マウスホイール ... カーソル位置を中心にズーム
- マウスドラッグ ... パン
- 1本指ドラッグ  ... パン（スマホ）
- 2本指ピンチ    ... ズーム（スマホ）
- 右下のボタン   ... 拡大 / 縮小 / リセット

ステートのタップ/クリックはドラッグ判定としきい値（5px）で区別される。
ドラッグ中の click は capture phase で抑制されるため、ステート選択と干渉しない。

## 原則（作ってほしいもの.txt より）

- 絵文字は使わない
- スマホで使いやすくする
- SVG 地図は iOS でぼやけやすいので対策する（ルートの width/height 属性を外し viewBox で拡大、ズームも viewBox で行う）
- パソコンで開発し、完成したら GitHub に移植する
- 地図データは Firebase に保存する
- 国家データも Firebase（`aster_stella/nations`）に保存する
