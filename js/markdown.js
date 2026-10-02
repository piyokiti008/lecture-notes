/* Markdown 変換 + 考査対策用の抽出ロジック（外部ライブラリなし） */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const RE_HEAD = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const RE_Q = /^\s*(?:Q|Ｑ|問)\s*[:：]\s*(.*)$/i;
  const RE_A = /^\s*(?:A|Ａ|答)\s*[:：]\s*(.*)$/i;
  const RE_TERM = /^\s*(?:[-*+]\s+)?([^\s`].{0,58}?)(?:\s+::\s+|\s*：：\s*)(\S.*)$/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

  /* ---------- 簡易 TeX（sup/sub/frac/sqrt/ギリシャ文字など） ---------- */
  const SYM = {
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
    lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
    Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡',
    sim: '∼', propto: '∝', ll: '≪', gg: '≫', infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫', oint: '∮',
    to: '→', rightarrow: '→', leftarrow: '←', uparrow: '↑', downarrow: '↓', Rightarrow: '⇒', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦',
    in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬', land: '∧', lor: '∨',
    ldots: '…', cdots: '⋯', dots: '…', degree: '°', angle: '∠', perp: '⊥', parallel: '∥', prime: '′', hbar: 'ℏ', ell: 'ℓ', therefore: '∴', because: '∵',
    langle: '⟨', rangle: '⟩', lbrace: '{', rbrace: '}', quad: ' ', qquad: '  ', ',': ' ', ';': ' ', '{': '{', '}': '}',
    '%': '%', '&': '&', _: '_', '#': '#', $: '$',
  };
  const OPS = new Set(['=', '<', '>', '+', '−', '×', '±', '∓', '≤', '≥', '≠', '≈', '≡', '∼', '∝', '→', '←', '⇒', '⇐', '↔', '⇔', '↦', '∈', '∉', '⊂', '⊆', '⊃', '∪', '∩', '·', '÷', '≪', '≫']);
  const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'arg', 'gcd', 'mod', 'sinh', 'cosh', 'tanh']);

  function tex(src) {
    let i = 0, upright = 0;
    const skipWs = () => { while (src[i] === ' ') i++; };
    const rawArg = () => {
      skipWs();
      if (src[i] !== '{') return esc(src[i++] || '');
      let depth = 0, j = i;
      for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}' && --depth === 0) break; }
      const t = src.slice(i + 1, j); i = j + 1; return esc(t);
    };
    const arg = () => {
      skipWs();
      if (src[i] === '{') { i++; const h = seq('}'); if (src[i] === '}') i++; return h; }
      return atom();
    };
    function command(n) {
      switch (n) {
        case 'frac': case 'dfrac': case 'tfrac': { const a = arg(), b = arg(); return '<span class="frac"><span>' + a + '</span><span>' + b + '</span></span>'; }
        case 'sqrt': {
          skipWs(); let idx = '';
          if (src[i] === '[') { const j = src.indexOf(']', i); if (j > 0) { idx = '<sup class="rad-idx">' + esc(src.slice(i + 1, j)) + '</sup>'; i = j + 1; } }
          return idx + '<span class="sqrt"><span class="rad">√</span><span class="rad-body">' + arg() + '</span></span>';
        }
        case 'text': case 'textbf': return '<span class="tx' + (n === 'textbf' ? ' b' : '') + '">' + rawArg() + '</span>';
        case 'mathrm': case 'mathbf': case 'operatorname': case 'mathbb': case 'mathcal': {
          upright++;
          const h = arg();
          upright--;
          return '<span class="tx' + (n === 'mathbf' ? ' b' : '') + '">' + h + '</span>';
        }
        case 'vec': case 'overrightarrow': return '<span class="ov vec">' + arg() + '</span>';
        case 'bar': case 'overline': return '<span class="ov">' + arg() + '</span>';
        case 'hat': case 'tilde': case 'dot': case 'ddot': return arg();
        case 'left': case 'right': case 'big': case 'Big': case 'bigg': case 'displaystyle': if (src[i] === '.') i++; return '';
        case '\\': return '<br>';
        default:
          if (SYM[n] !== undefined) return OPS.has(SYM[n]) ? '<span class="op">' + SYM[n] + '</span>' : SYM[n];
          if (FUNCS.has(n)) return '<span class="fn">' + n + '</span>';
          return esc('\\' + n);
      }
    }
    function atom() {
      const c = src[i++];
      if (c === undefined) return '';
      if (c === '\\') {
        let name = '';
        if (/[a-zA-Z]/.test(src[i] || '')) { while (/[a-zA-Z]/.test(src[i] || '')) name += src[i++]; } else name = src[i++] || '';
        return command(name);
      }
      if (c === '{') { const h = seq('}'); if (src[i] === '}') i++; return h; }
      if (/[a-zA-Z]/.test(c)) return upright ? c : '<i>' + c + '</i>';
      if (c === '-') return '<span class="op">−</span>';
      if (OPS.has(c)) return '<span class="op">' + esc(c) + '</span>';
      return esc(c);
    }
    function script() {
      const t = src[i++];
      const a = arg();
      return t === '^' ? '<sup>' + a + '</sup>' : '<sub>' + a + '</sub>';
    }
    function seq(end) {
      let out = '';
      while (i < src.length && src[i] !== end) {
        if (src[i] === '^' || src[i] === '_') { out += script(); continue; }
        if (src[i] === ' ') { i++; continue; }
        out += atom();
        while (src[i] === '^' || src[i] === '_') out += script();
      }
      return out;
    }
    return seq('\u0000');
  }

  function mathHtml(t) {
    try { return tex(String(t)); } catch (e) { return '<code>' + esc(t) + '</code>'; }
  }

  /* ---------- インライン ---------- */
  function imgHtml(alt, src) {
    if (src.startsWith('img:')) {
      const data = (LN.images || {})[src.slice(4)];
      return data ? '<img src="' + data + '" alt="' + esc(alt) + '">' : '<span class="img-missing">［画像が見つかりません］</span>';
    }
    if (/^https?:\/\//.test(src)) return '<img src="' + esc(src) + '" alt="' + esc(alt) + '">';
    return esc('![' + alt + '](' + src + ')');
  }

  function inline(text, ctx) {
    ctx = ctx || { answers: [] };
    const stash = [];
    const put = (h) => '\u0000' + (stash.push(h) - 1) + '\u0001';
    const restore = (s) => {
      for (let g = 0; g < 5 && /\u0000\d+\u0001/.test(s); g++) s = s.replace(/\u0000(\d+)\u0001/g, (_, k) => stash[+k]);
      return s;
    };
    let s = String(text);
    s = s.replace(/`([^`\n]+)`/g, (_, c) => put('<code>' + esc(c) + '</code>'));
    s = s.replace(/\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, t) => put('<span class="math">' + mathHtml(t) + '</span>'));
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => put(imgHtml(alt, src)));
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_, t, u) => put('<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(t) + '</a>'));
    s = esc(s);
    s = s.replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>');
    s = s.replace(/==(?=\S)([\s\S]+?)(?<=\S)==/g, '<mark>$1</mark>');
    s = s.replace(/\{\{([\s\S]+?)\}\}/g, (_, a) => { ctx.answers.push(restore(a)); return '<span class="cloze">' + a + '</span>'; });
    s = s.replace(/\n/g, '<br>');
    return restore(s);
  }

  /* ---------- ブロック ---------- */
  function readQA(lines, i) {
    const q = [RE_Q.exec(lines[i])[1]];
    let a = null, j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) {
        if (a === null && j + 1 < lines.length && RE_A.test(lines[j + 1])) continue;
        break;
      }
      if (RE_Q.test(l) || RE_HEAD.test(l) || /^\s*```/.test(l)) break;
      const am = RE_A.exec(l);
      if (am && a === null) { a = [am[1]]; continue; }
      if (a === null) q.push(l.trim()); else a.push(l.replace(/^\s{0,4}/, ''));
    }
    return { q: q.join('\n').trim(), a: a === null ? null : a.join('\n').trim(), next: j };
  }

  const isSep = (l) => l !== undefined && l.includes('-') && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const splitRow = (l) => {
    l = l.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|')) l = l.slice(0, -1);
    return l.split('|').map((c) => c.trim());
  };

  function startsBlock(lines, i) {
    const l = lines[i];
    return /^\s*```/.test(l) || /^\s*\$\$/.test(l) || RE_HEAD.test(l) || RE_HR.test(l) || /^\s*>/.test(l) || RE_LIST.test(l) ||
      RE_Q.test(l) || RE_TERM.test(l) || (l.includes('|') && isSep(lines[i + 1]));
  }

  function listHtml(buf, ctx) {
    const items = [];
    for (const raw of buf) {
      const m = RE_LIST.exec(raw);
      if (m) items.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), num: parseInt(m[2], 10), text: m[3] });
      else if (raw.trim() && items.length) items[items.length - 1].text += '\n' + raw.trim();
    }
    let pos = 0;
    const itemHtml = (t) => {
      const m = RE_TERM.exec(t);
      return m ? '<strong class="term">' + inline(m[1], ctx) + '</strong><span class="term-sep">：</span>' + inline(m[2], ctx) : inline(t, ctx);
    };
    function level() {
      const base = items[pos].indent, first = items[pos];
      const tag = first.ordered ? 'ol' : 'ul';
      let html = '<' + tag + (first.ordered && first.num !== 1 ? ' start="' + first.num + '"' : '') + '>';
      while (pos < items.length && items[pos].indent >= base) {
        if (items[pos].indent === base && items[pos].ordered !== first.ordered) break;
        const it = items[pos++];
        let li = itemHtml(it.text);
        if (pos < items.length && items[pos].indent > it.indent) li += level();
        html += '<li>' + li + '</li>';
      }
      return html + '</' + tag + '>';
    }
    let html = '';
    while (pos < items.length) html += level();
    return { html, items: items.map((it) => it.text) };
  }

  /** ノート本文を「ブロック」の配列に変換する。各ブロックは html / answers(穴埋めの答え) / meta（抽出用）を持つ */
  function blocks(src, opts) {
    opts = opts || {};
    const off = opts.headingOffset || 0;
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const push = (kind, html, answers, meta) => out.push({ kind, html, answers: answers || [], cloze: (answers || []).length, meta: meta || {} });
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;

      if ((m = /^\s*```\s*([\w+-]*)/.exec(line))) {
        const lang = m[1].toLowerCase(), buf = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i++;
        if (lang === 'svg' && LN.svg) {
          const r = LN.svg.sanitize(buf.join('\n'));
          push('figure', r.ok ? '<figure class="diagram"><img alt="図解" src="' + LN.svg.toDataUrl(r.svg) + '"></figure>'
            : '<p class="img-missing">［図を表示できませんでした：' + esc(r.error) + '］</p>');
        } else push('code', '<pre><code>' + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }
      if (/^\s*\$\$/.test(line)) {
        const first = line.replace(/^\s*\$\$/, '');
        const buf = [];
        if (first.includes('$$')) { buf.push(first.slice(0, first.indexOf('$$'))); i++; }
        else {
          buf.push(first); i++;
          while (i < lines.length && !lines[i].includes('$$')) buf.push(lines[i++]);
          if (i < lines.length) { buf.push(lines[i].slice(0, lines[i].indexOf('$$'))); i++; }
        }
        push('math', '<div class="math-block">' + mathHtml(buf.join(' ').trim()) + '</div>');
        continue;
      }
      if ((m = RE_HEAD.exec(line))) {
        const n = Math.min(6, m[1].length + off), ctx = { answers: [] };
        push('h', '<h' + n + '>' + inline(m[2], ctx) + '</h' + n + '>', ctx.answers, { text: m[2] });
        i++; continue;
      }
      if (RE_HR.test(line)) { push('hr', '<hr>'); i++; continue; }
      if (line.includes('|') && isSep(lines[i + 1])) {
        const head = splitRow(line), seps = splitRow(lines[i + 1]);
        const aligns = seps.map((s) => (/^:-+:$/.test(s) ? 'center' : /-:$/.test(s) ? 'right' : ''));
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        const ctx = { answers: [] };
        const cell = (tag, c, k) => '<' + tag + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : '') + '>' + inline(c, ctx) + '</' + tag + '>';
        const html = '<div class="table-wrap"><table><thead><tr>' + head.map((c, k) => cell('th', c, k)).join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c, k) => cell('td', c, k)).join('') + '</tr>').join('') + '</tbody></table></div>';
        push('table', html, ctx.answers, { rows: [head].concat(rows) });
        continue;
      }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        const inner = blocks(buf.join('\n'), opts);
        push('quote', '<blockquote>' + inner.map((b) => b.html).join('\n') + '</blockquote>', [].concat(...inner.map((b) => b.answers)), { inner });
        continue;
      }
      if (RE_LIST.test(line)) {
        const buf = [];
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            if (i + 1 < lines.length && /^\s+([-*+]|\d+[.)])\s/.test(lines[i + 1])) { i++; continue; }
            break;
          }
          if (RE_LIST.test(l) || /^\s+\S/.test(l)) { buf.push(l); i++; continue; }
          break;
        }
        const ctx = { answers: [] };
        const r = listHtml(buf, ctx);
        push('list', r.html, ctx.answers, { items: r.items });
        continue;
      }
      if (RE_Q.test(line)) {
        const qa = readQA(lines, i);
        i = qa.next;
        const ctx = { answers: [] };
        let html = '<div class="qa"><div class="qa-row qa-q"><span class="qa-tag">Q</span><div class="qa-body">' + inline(qa.q, ctx) + '</div></div>';
        if (qa.a !== null) {
          const ab = blocks(qa.a, opts);
          html += '<div class="qa-row qa-a"><span class="qa-tag">A</span><div class="qa-body">' + ab.map((b) => b.html).join('') + '</div></div>';
          ab.forEach((b) => ctx.answers.push(...b.answers));
        }
        push('qa', html + '</div>', ctx.answers, { q: qa.q, a: qa.a });
        continue;
      }
      if ((m = RE_TERM.exec(line))) {
        const ctx = { answers: [] };
        push('term', '<div class="term-line"><strong class="term">' + inline(m[1], ctx) + '</strong><span class="term-sep">：</span><span>' + inline(m[2], ctx) + '</span></div>',
          ctx.answers, { term: m[1], def: m[2] });
        i++; continue;
      }
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) buf.push(lines[i++]);
      const ctx = { answers: [] };
      push('p', '<p>' + inline(buf.join('\n'), ctx) + '</p>', ctx.answers, { lines: buf });
    }
    return out;
  }

  const render = (src, opts) => blocks(src, opts).map((b) => b.html).join('\n');

  /* ---------- 抽出（重要ポイント / 用語 / 一問一答 / 穴埋め） ---------- */
  const HL = /==(?=\S)[\s\S]+?(?<=\S)==/;
  const cache = new Map();

  function extract(src) {
    src = String(src || '');
    const hit = cache.get(src);
    if (hit) return hit;
    const out = { highlights: [], terms: [], qas: [], cloze: 0 };
    let heading = '';
    const seen = new Set();
    const addHL = (text) => {
      text = text.trim();
      if (text && HL.test(text) && !seen.has(text)) { seen.add(text); out.highlights.push({ text, heading }); }
    };
    (function walk(bs) {
      for (const b of bs) {
        out.cloze += b.cloze;
        const mt = b.meta;
        if (b.kind === 'h') heading = mt.text;
        else if (b.kind === 'qa') out.qas.push({ q: mt.q, a: mt.a, heading });
        else if (b.kind === 'term') out.terms.push({ term: mt.term, def: mt.def, heading });
        else if (b.kind === 'list') {
          mt.items.forEach((t) => {
            const m = RE_TERM.exec(t);
            if (m) out.terms.push({ term: m[1], def: m[2], heading }); else addHL(t.replace(/\n/g, ' '));
          });
        }
        else if (b.kind === 'p') mt.lines.forEach((l) => addHL(l));
        else if (b.kind === 'table') mt.rows.forEach((r) => addHL(r.join(' ／ ')));
        else if (b.kind === 'quote') walk(mt.inner);
      }
    })(blocks(src));
    if (cache.size > 400) cache.clear();
    cache.set(src, out);
    return out;
  }

  LN.md = { esc, inline, blocks, render, extract, mathHtml };
})(typeof window !== 'undefined' ? window : globalThis);
