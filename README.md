# 売上管理ツール(オフライン対応PWA)

Progressive Web App (PWA) として動作する、オフライン環境でも使える売上管理ツールです。
ビルド不要の素の HTML / CSS / JavaScript で構築されており、データは各端末内の IndexedDB にのみ保存されます(外部サーバーへの送信はありません)。

現在は **商品マスタ管理(MVP)** のみを実装しています。売上入力・集計レポート・顧客管理は今後のフェーズで追加予定です。

公開URL: https://tukuyomi1189.github.io/sales-management-pwa/

## 主な機能

- 商品の登録・編集・削除(商品コード / 商品名 / カテゴリ / 単価 / 在庫数 / 単位 / メモ)
- 商品名・商品コード・カテゴリでのキーワード検索
- 在庫少バッジ表示、登録件数・在庫合計・在庫評価額のサマリー表示
- JSONエクスポート / インポート(バックアップ・復元用)
- オンライン / オフライン状態の表示
- ホーム画面へのインストール(Add to Home Screen)対応

## 技術スタック

- 素の HTML / CSS / JavaScript(ビルドツール・フレームワーク不使用)
- データ保存: IndexedDB([js/db.js](js/db.js))
- オフラインキャッシュ: Service Worker([service-worker.js](service-worker.js))によるアプリシェルのキャッシュ
- PWAマニフェスト: [manifest.json](manifest.json)

## ファイル構成

```
index.html          エントリーポイント(UI骨格・商品フォーム・一覧)
css/style.css        スタイル(レスポンシブ・ダークモード対応)
js/db.js              IndexedDBラッパー(商品データのCRUD)
js/app.js             画面制御・検索・SW登録・オンライン/オフライン検知・JSON入出力
service-worker.js     アプリシェルのキャッシュ戦略(オフライン動作の要)
manifest.json         PWAマニフェスト
icons/                ホーム画面アイコン一式(通常 / maskable、192px・512px)
```

## オフライン環境での使用方法

このアプリは **一度読み込むとオフラインでも完全に動作します**。仕組みは次の2段構えです。

1. **Service Worker がアプリ本体(HTML/CSS/JS/アイコン)をキャッシュ**するため、ネットワークがなくても画面が表示されます。
2. **商品データは IndexedDB に保存**されるため、ネットワークがなくても登録・編集・削除・検索がすべて行えます。

### 注意点

- Service Worker は **HTTPS または localhost でしか動作しません**。`file://` で直接 `index.html` を開いたり、`http://` の LAN IP(例: `http://192.168.x.x:8080`)でアクセスした場合はオフラインキャッシュが有効になりません。
- データは **端末・ブラウザごとに独立**しています(PCとスマホ、Chrome と Safari 等で共有されません)。複数端末で同じデータを見るにはサーバー同期機能が別途必要です。
- コード更新後にオフラインキャッシュを確実に更新させたい場合は、[service-worker.js](service-worker.js) 冒頭の `CACHE_VERSION` を上げてから再デプロイしてください。

## ローカルで動かす

```bash
cd sales_management_project
python -m http.server 8080
```

ブラウザで `http://localhost:8080` を開きます(`localhost` は secure context 扱いのため Service Worker が有効になります)。一度読み込めば、以降はネットワークを切っても利用できます。

## スマホで使う

1. 公開URL(https://tukuyomi1189.github.io/sales-management-pwa/ )をスマホのブラウザで開く
2. ホーム画面に追加してインストール
   - **Android (Chrome)**: 右上メニュー(⋮) → 「アプリをインストール」または「ホーム画面に追加」
   - **iPhone (Safari)**: 共有ボタン → 「ホーム画面に追加」
3. インストール後はホーム画面のアイコンから単体アプリとして起動でき、機内モードでも利用できます

## 今後の拡張予定

- 売上入力・一覧
- 売上集計・レポート(日別/月別/商品別)
- 顧客管理
