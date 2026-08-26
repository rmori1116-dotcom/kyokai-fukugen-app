#!/usr/bin/env python3
"""fukugen-map.html をビルドする。
template.html の <!--@LIB:xxx--> をライブラリ本体に置換し、
sw.js にはHTMLの内容ハッシュを版番号として埋め込む（更新検知のため）。"""
import hashlib, pathlib, re, sys, datetime

here = pathlib.Path(__file__).resolve().parent
# ライブラリの置き場所。ソース一式に同梱した lib/ を優先する
lib  = here / 'lib'
if not lib.is_dir():
    lib = here.parent / 'build' / 'lib'
dist = here / 'dist'
dist.mkdir(exist_ok=True)

LIBS = {
    'geotiff':  lib / 'geotiff.js',
    'proj4':    lib / 'proj4.js',
    'encoding': lib / 'encoding.js',
}

html = (here / 'template.html').read_text(encoding='utf-8')

for name, path in LIBS.items():
    s = path.read_text(encoding='utf-8')
    s = re.sub(r'^//# sourceMappingURL=.*$', '', s, flags=re.M).rstrip()
    s = s.replace('</script', r'<\/script')
    token = f'<!--@LIB:{name}-->'
    if token not in html:
        sys.exit(f'placeholder not found: {token}')
    html = html.replace(token, '\n' + s + '\n')

if '<!--@LIB:' in html:
    sys.exit('unreplaced placeholder remains')

ver = hashlib.sha256(html.encode('utf-8')).hexdigest()[:12]
build = datetime.datetime.now().strftime('%Y-%m-%d') + ' (' + ver + ')'
if '@@BUILD@@' not in html:
    sys.exit('placeholder not found: @@BUILD@@')
html = html.replace('@@BUILD@@', build)
sw = (here / 'sw.src.js').read_text(encoding='utf-8').replace('@@VERSION@@', ver)

(dist / 'fukugen-map.html').write_text(html, encoding='utf-8')
(dist / 'index.html').write_text(html, encoding='utf-8')
(dist / 'sw.js').write_text(sw, encoding='utf-8')
(dist / '.nojekyll').write_text('', encoding='utf-8')

print(f'fukugen-map.html  {len(html.encode("utf-8"))/1024:.0f} KB   version={ver}')
print(f'sw.js             {len(sw.encode("utf-8"))/1024:.1f} KB')
