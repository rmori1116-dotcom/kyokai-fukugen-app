#!/usr/bin/env python3
"""template.src.html の <!--@SRC:a-b--> を、選点アプリ v1.7 の template.html の
その行範囲（1始まり・両端含む）でそのまま置き換える。
共通部分（座標系・タイル・GeoTIFF・永続化など）を写し間違えないための仕掛け。"""
import pathlib, re, sys, zipfile

here = pathlib.Path(__file__).resolve().parent
SRC = here.parent / 'build' / 'template.html'          # v1.7 のソース
SRC_ZIP = here.parent / 'ソース一式_地図版_v1.7.zip'   # 配布一式での代替元
IN  = here / 'template.src.html'
OUT = here / 'template.html'

if SRC.is_file():
    src_text = SRC.read_text(encoding='utf-8')
elif SRC_ZIP.is_file():
    with zipfile.ZipFile(SRC_ZIP) as zf:
        src_text = zf.read('template.html').decode('utf-8-sig')
else:
    sys.exit(f'選点アプリ v1.7 の template.html がありません: {SRC} / {SRC_ZIP}')
src_lines = src_text.split('\n')
text = IN.read_text(encoding='utf-8')

# アプリ本体（app.js）を差し込む
app = (here / 'app.js').read_text(encoding='utf-8')
if '<!--@APP-->' not in text:
    sys.exit('placeholder not found: <!--@APP-->')
text = text.replace('<!--@APP-->', app)

used = []
def sub(m):
    a, b = int(m.group(1)), int(m.group(2))
    used.append((a, b))
    return '\n'.join(src_lines[a-1:b])

text = re.sub(r'<!--@SRC:(\d+)-(\d+)-->', sub, text)
if '<!--@SRC:' in text:
    sys.exit('未置換の @SRC が残っています')

# 指でのタップ時は、地図を押した際の微小な指ぶれをドラッグと誤判定しにくくする。
old = "if(downInfo && Math.hypot(e.offsetX-downInfo.x,e.offsetY-downInfo.y)>8) downInfo.moved=true;"
new = "if(downInfo && Math.hypot(e.offsetX-downInfo.x,e.offsetY-downInfo.y)>(e.pointerType==='touch'?14:8)) downInfo.moved=true;"
if old not in text:
    sys.exit('共通操作部のタップ判定が見つかりません（v1.7との差分を確認してください）')
text = text.replace(old, new, 1)

# 選点地図版と同じoriginで配信しても、点・控え・地図タイルが混ざらない専用DB名にする。
old_db = "const DB_NAME='sentenApp', DB_STORE='kv', DB_KEY='store', SNAP_KEEP=10;"
new_db = "const DB_NAME='kyokaiFukugenMap', DB_STORE='kv', DB_KEY='store', SNAP_KEEP=10;"
if text.count(old_db) != 1:
    sys.exit('共通永続化部のDB名が見つかりません（v1.7との差分を確認してください）')
text = text.replace(old_db, new_db, 1)
OUT.write_text(text, encoding='utf-8')
print(f'template.html {len(text.encode("utf-8"))/1024:.0f} KB  流用 {len(used)}箇所 '
      f'{sum(b-a+1 for a,b in used)}行')
