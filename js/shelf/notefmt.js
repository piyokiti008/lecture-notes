/* ノート形式の投稿を、shelf.html に表示する（段階3b）。
 *  - 本文は、アプリ本体と同じ変換（js/markdown.js の LN.md.render）で HTML にする。変換は、利用者の文字をすべてエスケープし、画像は検査ずみの data:image だけを使う。
 *  - ただし、他人が書いたものなので、念のため、できあがった HTML を、そのまま画面に入れない：いったん「動かない文書」（DOMParser）に読み込み、
 *    許可したタグ・属性だけを、画面の要素として作り直す（スクリプト・style・イベントの属性・http(s) 以外のリンク・data:image 以外の画像は、すべて捨てる）。
 *  - 図解（SVG）・動く部品は読み込まない（コードとして文字で出る）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const N = (S.notefmt = {});
  const doc = root.document;

  const TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'BR', 'HR', 'STRONG', 'EM', 'DEL', 'MARK', 'CODE', 'PRE', 'SPAN', 'DIV', 'SUP', 'SUB', 'I', 'B', 'A', 'IMG', 'FIGURE']);
  const CLASS_RE = /^[A-Za-z0-9 _-]{1,80}$/;
  const IMG_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const LINK_RE = /^https?:\/\/[^\s"'<>]+$/i;

  function copy(src, dst) {
    src.childNodes.forEach((n) => {
      if (n.nodeType === 3) { dst.appendChild(doc.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName;
      if (!TAGS.has(tag)) { copy(n, dst); return; }                    // 許可していないタグは外し、中の文字だけ残す
      if (tag === 'IMG') {
        const s = n.getAttribute('src') || '';
        if (IMG_RE.test(s)) { const im = doc.createElement('img'); im.setAttribute('src', s); im.setAttribute('alt', n.getAttribute('alt') || ''); dst.appendChild(im); }
        else dst.appendChild(doc.createTextNode('［画像を表示できません］'));
        return;
      }
      const el = doc.createElement(tag.toLowerCase());
      const cls = n.getAttribute('class');
      if (cls && CLASS_RE.test(cls)) el.className = cls;
      if (tag === 'A') {
        const href = n.getAttribute('href') || '';
        if (LINK_RE.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
      }
      copy(n, el);
      dst.appendChild(el);
    });
  }

  /** 検査ずみのノート（M.parseNoteDoc の結果）→ 画面の要素（div.md.sh-notebody） */
  N.render = function (note) {
    const box = doc.createElement('div'); box.className = 'md sh-notebody';
    let html = null;
    const saved = LN.images;
    LN.images = note.images || {};                                   // 本文の ![](img:ID) は、このノートの画像だけから探す
    try { html = LN.md.render(note.body); } catch (e) { html = null; } finally { LN.images = saved; }
    if (html == null) { box.textContent = note.body; return box; }
    copy(new root.DOMParser().parseFromString('<!doctype html><body>' + html, 'text/html').body, box);
    return box;
  };
})(window);
