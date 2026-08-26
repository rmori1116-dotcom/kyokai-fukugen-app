# ソース一式（境界復元支援アプリ v0.2）

> 現在のアプリ版は **v0.2** です。v0.2では全画面のタップ領域と、地図上の選点判定をスマホ向けに拡大しました。

`ソース一式_境界復元_v0.1.zip` の中身と、再ビルドの手順です。

## 中身

| ファイル | 役割 |
|---|---|
| `template.src.html` | HTMLの外枠（画面の並び・パネル・使い方）。**ここと app.js だけを直します** |
| `app.js` | **アプリ本体。**取込・記録・距離・描画・一覧など、境界復元の中身はすべてここ |
| `prep.py` | `<!--@SRC:a-b-->` を選点アプリ v1.7 の該当行に置き換え、`app.js` を差し込んで `template.html` を作る |
| `build.py` | `template.html` にライブラリを埋め込み、版ハッシュを付けて `dist/` を作る |
| `sw.src.js` | オフライン用 Service Worker のもと（`@@VERSION@@` に版ハッシュが入る） |
| `lib/` | 内蔵ライブラリ（geotiff / proj4 / encoding-japanese） |
| `test.mjs` | 自動テスト 271項目 |
| `shot.mjs` | 画面キャプチャ（`shots/` に出ます） |
| `sample/画地サンプル.sim` | テスト用のSIMA（画地データ入り・2,397点／4画地） |

`dist/` は入っていません。`build.py` で作れるためです。

## 選点アプリのソースが要ります

`prep.py` は、**選点支援アプリ（地理院地図版）v1.7 の `template.html`** から、共通部分（座標系・地理院タイル・GeoTIFF・永続化・パネルなど 22箇所・約1,575行）をそのまま写して使います。

```
基準点選点支援アプリ/
├ 06_ソース/ソース一式_地図版_v1.7.zip   ← この中の template.html
└ ...
```

`prep.py` の `SRC` が指す場所（既定は `../build/template.html`）に、v1.7 の `template.html` を置いてください。

**v1.7 の template.html の行番号がずれると、写す範囲もずれます。** 共通部分を直したいときは v1.7 側を直さず、`app.js` の側に同名の関数を書いて上書きするか、`prep.py` の行番号を直してください。

## 再ビルド

```
python3 prep.py     # template.html を作る
python3 build.py    # dist/index.html・dist/fukugen-map.html・dist/sw.js を作る
```

`dist/index.html` と `dist/fukugen-map.html` は中身が同じです（配信先に合わせてどちらでも置けます）。

## テスト

```
node test.mjs
```

現在のテストは、スマホ縦390×844のタッチ領域検証を含む280項目です。

## GitHub Pagesへ公開

`dist/` と `.github/workflows/pages.yml` を含めて `main` ブランチへpushし、リポジトリの **Settings → Pages → Source** を **GitHub Actions** にすると公開されます。以降は `main` へのpushごとに自動更新されます。

Playwright（Chromium）が要ります。実行前に `python3 prep.py && python3 build.py` をしてください。
テストは IndexedDB と Service Worker を使うため、`file://` ではなく**簡易HTTPサーバを立てて**検査します（test.mjs の中で自動的に立ち上がります）。

## 気をつけるところ

- **版ハッシュが変わると Service Worker のキャッシュ名が変わり、端末が新版を取りに行きます。** 直したら必ずビルドし直してください。
- 端末では**電波のある場所で2回開く**と新版に切り替わります。ヘッダーの版数で確認してください。
- 選点アプリとは**別サイト**です。同じURLに置くと、保存データとキャッシュが混ざります。
