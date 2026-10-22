/* 他のサイトの枠（iframe）の中で開かれたとき、アプリを動かさない（クリックジャッキング対策）。
 * 悪意のあるサイトが、このアプリを透明な枠で重ね、利用者に別のものを押させて、削除・ログインなどを押させる攻撃を防ぐ。
 * GitHub Pages では、「他のサイトに埋め込まれるのを断る」ヘッダー（X-Frame-Options や CSP の frame-ancestors）を付けられないため、アプリ側で守る。
 * 同じサイトの内側の枠なら、そのまま動かす。<head> の一番最初に読み込む。 */
(function (w) {
  'use strict';
  let framed = false;
  try {
    framed = w.top !== w.self;
    if (framed) { void w.top.location.href; framed = false; } // 同じサイトなら、外側の場所が読める。別のサイトなら、例外になる
  } catch (e) { framed = true; }
  if (!framed) return;
  w.__lnFramed = true;
  try { w.stop(); } catch (e) { /* 読み込みの中止に失敗しても、下で画面を置き換える */ }
  const d = w.document;
  const root = d.documentElement;
  while (root.firstChild) root.removeChild(root.firstChild);
  const head = d.createElement('head'), meta = d.createElement('meta'), title = d.createElement('title'), body = d.createElement('body'), p = d.createElement('p'), a = d.createElement('a');
  meta.setAttribute('charset', 'utf-8'); title.textContent = '講義ノート';
  head.appendChild(meta); head.appendChild(title);
  body.style.cssText = 'font:16px/1.9 sans-serif;padding:28px;color:#222;background:#fff';
  p.textContent = 'このページは、他のサイトの枠の中では使えません（安全のため）。';
  a.textContent = '新しいタブで開く'; a.href = w.location.href; a.target = '_blank'; a.rel = 'noopener';
  body.appendChild(p); body.appendChild(a);
  root.appendChild(head); root.appendChild(body);
})(window);
