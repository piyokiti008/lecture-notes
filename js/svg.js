/* 図解（SVG）の安全化。許可リスト方式：許可した要素・属性以外はすべて取り除く */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const TAGS = new Set(['svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'marker',
    'lineargradient', 'radialgradient', 'stop', 'pattern', 'clippath', 'mask', 'title', 'desc', 'symbol', 'use']);

  const ATTRS = new Set(['id', 'class', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'd', 'points', 'transform',
    'viewbox', 'preserveaspectratio', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
    'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'font-family', 'font-size', 'font-weight',
    'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'text-decoration', 'dx', 'dy', 'rotate',
    'textlength', 'lengthadjust', 'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight', 'refx', 'refy', 'orient',
    'markerunits', 'offset', 'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform', 'patternunits', 'patterntransform',
    'clip-path', 'clip-rule', 'mask', 'visibility', 'display', 'version', 'xml:space', 'fx', 'fy', 'spreadmethod', 'vector-effect']);

  const LOCAL_URL = /^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/;

  /** 属性値中の url(...) がすべてページ内参照（#id）であること */
  function urlsAreLocal(v) {
    const found = v.match(/url\([^)]*\)/gi);
    return !found || found.every((u) => LOCAL_URL.test(u.trim()));
  }

  function safeStyle(v) {
    if (/@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(v)) return false;
    return urlsAreLocal(v);
  }

  function sanitize(text) {
    let src = String(text || '').trim();
    const m = /<svg[\s\S]*<\/svg>/i.exec(src);
    if (!m) return { ok: false, error: 'SVG が見つかりません' };
    src = m[0];
    if (src.length > 2000000) return { ok: false, error: 'SVG が大きすぎます' };
    if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(src)) return { ok: false, error: '使用できない宣言が含まれています' };
    const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return { ok: false, error: 'SVG の記述に誤りがあります' };
    const rootEl = doc.documentElement;
    if (!rootEl || rootEl.localName.toLowerCase() !== 'svg') return { ok: false, error: 'SVG ではありません' };

    let count = 0;
    (function walk(el) {
      for (const child of Array.from(el.children)) {
        if (!TAGS.has(child.localName.toLowerCase()) || ++count > 4000) { child.remove(); continue; }
        walk(child);
      }
      for (const a of Array.from(el.attributes)) {
        const n = a.name.toLowerCase(), v = a.value;
        let keep = false;
        if (n === 'xmlns' || n === 'xmlns:xlink') keep = true;
        else if (n === 'href' || n === 'xlink:href') keep = el.localName.toLowerCase() === 'use' && /^#[\w.:-]+$/.test(v);
        else if (n === 'style') keep = safeStyle(v);
        else if (ATTRS.has(n)) keep = urlsAreLocal(v) && !/javascript:/i.test(v);
        if (!keep) el.removeAttribute(a.name);
      }
    })(rootEl);

    const vb = (rootEl.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    let w, h;
    if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; }
    else {
      w = parseFloat(rootEl.getAttribute('width')) || 800;
      h = parseFloat(rootEl.getAttribute('height')) || 600;
      rootEl.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    }
    rootEl.setAttribute('width', String(Math.round(w)));
    rootEl.setAttribute('height', String(Math.round(h)));
    rootEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    return { ok: true, svg: new XMLSerializer().serializeToString(rootEl), width: w, height: h };
  }

  const toDataUrl = (svg) => 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  const fromDataUrl = (url) => {
    const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(url || '');
    return m ? decodeURIComponent(escape(atob(m[1]))) : null;
  };

  LN.svg = { sanitize, toDataUrl, fromDataUrl };
})(window);
