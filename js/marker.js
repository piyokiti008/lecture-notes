/* マーカー（js/marker.js）：選んだ範囲を、マーカー（重要マーク ==…==。色つきは ==…=={p}）にする（同じ色のマーカーの所だけを選んだとき・消しゴムのときは、その部分のマーカーを消す）純粋な部品。画面には触れない。
 *  本文（文字列）と、選んだ範囲（from〜to）と、色を渡すと、書き換える範囲（edit）と、新しい文字を返す。ボタンやなぞる操作は js/app.js。
 *  色：y 黄（印なし）・p ピンク {p}・g 緑 {g}・b 青 {b}・o 橙 {o}。色の印は、閉じの == のすぐあとに付く（==大事=={p}）。
 *  ノートの書き方を壊さないよう、行ごとに、次のようにする（プレビュー・エディタと同じ記号の見つけ方を使う）。
 *   ・見出し・箇条書き・番号・引用・Q:／A: の行頭の記号、用語の「::」、表の「|」には付けない（その手前・後ろの文字だけに付ける）。コードブロック・数式ブロック・区切り線・表の区切り行は、そのまま。
 *   ・選んだ文字の前後の空白は、マーカーの外に出す。空の行・空白だけの所には付けない。複数の行にまたがる選び方は、行ごとに付ける。
 *   ・**太字** ~~取り消し~~ *斜体* {{穴埋め}} の記号を、半端にまたぐ選び方は、記号の手前で区切って、それぞれに付ける。
 *   ・`コード` $数式$ ![画像]() [リンク]() は、半端に選んでも、ひとまとまりにして付ける。
 *   ・すでに付いたマーカーと重なるときは、同じ色なら、つなげて1つにする。違う色の所は、選んだ色に塗り替える。選んだ文字がすべて、すでに選んだ色なら、選んだ部分だけを消す（残りは、そのまま）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const K = (LN.marker = {});
  K.COLORS = ['y', 'p', 'g', 'b', 'o'];   // 黄・ピンク・緑・青・橙

  /* 記号の見つけ方は js/editor.js の RX と同じ（変えるときは、両方そろえる） */
  const RX = () => ({
    code: /`([^`\n]+)`/g,
    math: /\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g,
    img: /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    link: /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    bold: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g,
    em: /(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g,
    del: /~~(?=\S)([\s\S]+?)(?<=\S)~~/g,
    mark: /==(?=\S)([\s\S]+?)(?<=\S)==(?:\{([ypgbo])\})?/g,
    cloze: /\{\{([\s\S]+?)\}\}/g,
  });
  const RE_PREFIX = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?|(?:Q|Ｑ|問)\s*[:：]\s*|(?:A|Ａ|答)\s*[:：]\s*)/i;
  const RE_TERM_POS = /^(\s*)([^\s`].{0,58}?)(\s+::\s+|\s*：：\s*)(\S.*)$/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  const isWs = (c) => /\s/.test(c);

  /** 1行の中の記号の位置：atoms（コード・数式・画像・リンク。ひとまとまり）・wraps（太字など。n＝記号の長さ）・marks（マーカー。suf＝色の印 {p} の長さ） */
  function analyze(line) {
    let s = line;
    const mask = (a, b) => { s = s.slice(0, a) + '\u0000'.repeat(b - a) + s.slice(b); };
    const find = (re) => { re.lastIndex = 0; const r = []; let m; while ((m = re.exec(s))) { r.push(m); if (!m[0].length) re.lastIndex++; } return r; };
    const rx = RX(), atoms = [], wraps = [], marks = [];
    for (const k of ['code', 'math', 'img', 'link']) find(rx[k]).forEach((m) => { atoms.push({ a: m.index, b: m.index + m[0].length, img: k === 'img' }); mask(m.index, m.index + m[0].length); });
    for (const [k, n] of [['bold', 2], ['em', 1], ['del', 2], ['mark', 2], ['cloze', 2]]) {
      find(rx[k]).forEach((m) => {
        const a = m.index, b = a + m[0].length;
        if (k === 'mark') { const suf = m[2] ? 3 : 0; marks.push({ a, b, suf, color: m[2] || 'y' }); mask(a, a + 2); mask(b - 2 - suf, b); }
        else { wraps.push({ a, b, n }); mask(a, a + n); mask(b - n, b); }
      });
    }
    return { atoms, wraps, marks };
  }

  /** 各行が「そのまま」（コードブロック・数式ブロック・区切り線・表の区切り行）かどうか。0行目から調べる */
  function skipLines(lines, upto) {
    const skip = new Array(lines.length).fill(false);
    for (let i = 0; i <= upto && i < lines.length; i++) {
      const t = lines[i];
      if (/^\s*```/.test(t)) { skip[i] = true; i++; while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { skip[i] = true; i++; } if (i < lines.length) skip[i] = true; continue; }
      if (/^\s*\$\$/.test(t)) {
        skip[i] = true;
        if (!t.replace(/^\s*\$\$/, '').includes('$$')) { i++; while (i < lines.length && !lines[i].includes('$$')) { skip[i] = true; i++; } if (i < lines.length) skip[i] = true; }
        continue;
      }
      if (RE_HR.test(t) || (t.includes('-') && RE_SEP.test(t) && /[|:]/.test(t))) skip[i] = true;
    }
    return skip;
  }

  /** 行の中の、マーカーを付けてはいけない位置（行頭の記号・用語の「::」・表の「|」） */
  function forbiddenOf(line, atoms) {
    const f = new Array(line.length).fill(false);
    let p = 0;
    for (let g = 0; g < 8; g++) { const m = RE_PREFIX.exec(line.slice(p)); if (!m || !m[0].length) break; p += m[0].length; }
    for (let i = 0; i < p; i++) f[i] = true;
    const t = RE_TERM_POS.exec(line.slice(p));
    if (t) { const a = p + t[1].length + t[2].length; for (let i = a; i < a + t[3].length; i++) f[i] = true; }
    const inAtom = (i) => atoms.some((x) => i >= x.a && i < x.b);
    for (let i = 0; i < line.length; i++) if (line[i] === '|' && !inAtom(i)) f[i] = true;
    for (const x of atoms) if (line.slice(x.a, x.b).includes('|')) for (let i = x.a; i < x.b; i++) f[i] = true;   // 「|」を含むコード等は、表の区切りと見間違えられるので、付けない
    return f;
  }

  /** 1行の、マーカーの色の印（col：'' ＝なし、'y'・'p'… ＝その色）と、マーカーの記号（delim。色の印 {p} も含む）。記号は、中身の文字ではない */
  function flagsOf(line, marks) {
    const delim = new Array(line.length).fill(false), col = new Array(line.length).fill('');
    for (const m of marks) {
      for (let i = m.a; i < m.a + 2; i++) delim[i] = true;
      for (let i = m.b - 2 - m.suf; i < m.b; i++) delim[i] = true;
      for (let i = m.a + 2; i < m.b - 2 - m.suf; i++) col[i] = m.color;
    }
    return { delim, col };
  }

  /** 印のついた文字（chars：{ c:文字, atom:コード等の中か }）を、==…== にして並べる（color が y 以外なら、閉じのあとに {色}）。先頭・末尾の空白と「=」は、マーカーの外に出す。「==」が文字の中にあれば、そこで区切る（コードなどの中の「=」は、数えない） */
  function emit(chars, color) {
    let out = '', cur = [];
    const tail = color && color !== 'y' ? '==' + '{' + color + '}' : '==';
    const eq = (j) => chars[j] !== undefined && chars[j].c === '=' && !chars[j].atom;
    const flush = () => {
      if (!cur.length) return;
      const edge = (x) => isWs(x.c) || (x.c === '=' && !x.atom);
      let a = 0, b = cur.length;
      while (a < b && edge(cur[a])) a++;
      while (b > a && edge(cur[b - 1])) b--;
      const str = (arr) => arr.map((x) => x.c).join('');
      out += a >= b ? str(cur) : str(cur.slice(0, a)) + '==' + str(cur.slice(a, b)) + tail + str(cur.slice(b));
      cur = [];
    };
    for (let j = 0; j < chars.length; j++) {
      if (eq(j) && eq(j + 1)) {
        flush();
        while (j < chars.length && eq(j)) out += chars[j++].c;
        j--; continue;
      }
      cur.push(chars[j]);
    }
    flush();
    return out;
  }

  /** 行を、印（col）どおりに組み直す（マーカーの記号を付け直す。同じ色が続く所が、1つのマーカー）。atoms＝コード・数式・画像・リンクの範囲 */
  function build(line, delim, col, atoms) {
    const inAtom = (i) => atoms.some((x) => i >= x.a && i < x.b);
    let out = '', run = [], runColor = '';
    const flushRun = () => { if (run.length) { out += emit(run, runColor); run = []; } };
    for (let i = 0; i < line.length; i++) {
      if (delim[i]) continue;
      if (col[i]) { if (run.length && col[i] !== runColor) flushRun(); runColor = col[i]; run.push({ c: line[i], atom: inAtom(i) }); }
      else { flushRun(); out += line[i]; }
    }
    flushRun();
    return out;
  }

  /** 印を整える：太字・斜体・取り消し・穴埋めの記号は、その記号を含む全体（記号から記号まで）が、同じ色のマーカーのときだけ印のまま。半端な印は、記号だけ外す
   *  （外さないと、マーカーが太字などの記号を半端にまたいでしまい、表示が崩れる）。コード・数式・画像・リンクも、全部が同じ色か、全くないか */
  function tidy(info, col, delim) {
    const uniform = (a, b) => { let c = null; for (let i = a; i < b; i++) { if (delim[i]) continue; if (!col[i]) return false; if (c === null) c = col[i]; else if (col[i] !== c) return false; } return true; };
    for (const w of info.wraps) {
      const d = []; for (let i = w.a; i < w.a + w.n; i++) d.push(i); for (let i = w.b - w.n; i < w.b; i++) d.push(i);
      if (d.some((i) => col[i]) && !uniform(w.a, w.b)) d.forEach((i) => { col[i] = ''; });
    }
    for (const x of info.atoms) {
      let some = false; for (let i = x.a; i < x.b; i++) if (col[i]) some = true;
      if (some && !uniform(x.a, x.b)) for (let i = x.a; i < x.b; i++) col[i] = '';
    }
  }

  /** 直したあとの行が、元の行と同じ文字で、表示の組み立ても正しいか（プレビューと同じ変換で確かめる）。崩れるなら、その行は直さない */
  const VOID = { br: 1, hr: 1, img: 1, col: 1, input: 1 };
  function wellFormed(html) {
    const st = [], re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g; let m;
    while ((m = re.exec(html))) { const close = m[1] === '/', tag = m[2].toLowerCase(); if (VOID[tag] || m[3] === '/') continue; if (!close) st.push(tag); else if (st.pop() !== tag) return false; }
    return st.length === 0;
  }
  function lineIntact(oldLine, newLine) {
    const md = LN.md;
    if (!md || !md.inline) return true;
    try {
      const a = md.inline(oldLine), b = md.inline(newLine);
      return wellFormed(b) && a.replace(/<[^>]*>/g, '') === b.replace(/<[^>]*>/g, '');
    } catch (e) { return false; }
  }

  /** 1行の中で、選んだ範囲 [a, b) から、実際に付ける（消す）範囲の一覧（行の中の位置）を作る。info＝その行の解析結果 */
  function piecesOf(line, a, b, info, forb, delim) {
    a = Math.max(0, a); b = Math.min(line.length, b);
    if (a >= b) return [];
    // コード・数式・画像・リンクは、半端に選んでも、ひとまとまり
    for (let g = 0; g < 6; g++) {
      let moved = false;
      for (const x of info.atoms) if (x.a < b && x.b > a && !(a <= x.a && b >= x.b)) { a = Math.min(a, x.a); b = Math.max(b, x.b); moved = true; }
      if (!moved) break;
    }
    // 太字・斜体・取り消し・穴埋めの記号を半端にまたぐときは、その記号は、範囲から外す
    const cut = forb.slice();
    for (const w of info.wraps) {
      if (!(w.a < b && w.b > a)) continue;
      const contains = a <= w.a && b >= w.b, inside = a >= w.a + w.n && b <= w.b - w.n;
      if (contains || inside) continue;
      for (let i = w.a; i < w.a + w.n; i++) cut[i] = true;
      for (let i = w.b - w.n; i < w.b; i++) cut[i] = true;
    }
    const out = [];
    let i = a;
    while (i < b) {
      while (i < b && cut[i]) i++;
      let j = i;
      while (j < b && !cut[j]) j++;
      let p = i, q = j;
      while (p < q && (delim[p] || isWs(line[p]))) p++;
      while (q > p && (delim[q - 1] || isWs(line[q - 1]))) q--;
      if (p < q) {
        let text = false;
        for (let k = p; k < q; k++) if (!delim[k] && !isWs(line[k]) && !info.atoms.some((x) => x.img && k >= x.a && k < x.b)) { text = true; break; }
        if (text) out.push([p, q]);
      }
      i = j;
    }
    return out;
  }

  /**
   * 選んだ範囲 [from, to) にマーカーを付ける。opt＝{ color:'y'|'p'|'g'|'b'|'o'（初期は y）, erase:true（消しゴム：色に関係なく、消す） }。
   * すでに、選んだ文字がすべて、選んだ色のマーカーなら、消す（付ける・消すが、なぞるたびに切り替わる）。違う色の所は、塗り替える。
   * 戻り値：{ ok:true, changed, action:'paint'|'erase'|'none', edit:{ from, to, insert }（text の from〜to を insert に置き換える）, cursor（直したあとの、カーソルを置く位置）, text（直したあとの全文） }
   */
  K.apply = function (text, from, to, opt) {
    text = String(text || '');
    const color = opt && K.COLORS.includes(opt.color) ? opt.color : 'y', eraser = !!(opt && opt.erase);
    let s = Math.min(from, to), e = Math.max(from, to);
    s = Math.max(0, s); e = Math.min(text.length, e);
    const none = { ok: true, changed: false, action: 'none', edit: { from: s, to: s, insert: '' }, cursor: e, text };
    if (s >= e) return none;
    const lines = text.split('\n');
    const starts = []; { let o = 0; for (const l of lines) { starts.push(o); o += l.length + 1; } }
    let li0 = 0; while (li0 + 1 < lines.length && starts[li0 + 1] <= s) li0++;
    let li1 = li0; while (li1 + 1 < lines.length && starts[li1 + 1] < e) li1++;
    const skip = skipLines(lines, li1);

    const plan = [];   // 行ごとの { i, line, info, flags, pieces }
    for (let i = li0; i <= li1; i++) {
      if (skip[i]) continue;
      const line = lines[i];
      const a = Math.max(s, starts[i]) - starts[i], b = Math.min(e, starts[i] + line.length) - starts[i];
      if (a >= b) continue;
      const info = analyze(line), flags = flagsOf(line, info.marks), forb = forbiddenOf(line, info.atoms);
      const pieces = piecesOf(line, a, b, info, forb, flags.delim);
      if (pieces.length) plan.push({ i, line, info, flags, pieces });
    }
    if (!plan.length) return none;

    // 選んだ文字が、すべて、選んだ色のマーカーなら「消す」。消しゴムは、いつも「消す」。そうでなければ「付ける」（違う色は塗り替える）
    let anyMarked = false, allSame = true, any = false;
    for (const p of plan) for (const [x, y] of p.pieces) for (let k = x; k < y; k++) {
      if (p.flags.delim[k] || isWs(p.line[k])) continue;
      any = true; if (p.flags.col[k]) anyMarked = true; if (p.flags.col[k] !== color) allSame = false;
    }
    const paint = eraser ? false : !(any && allSame);
    if (eraser && !anyMarked) return none;

    const newLines = lines.slice(); let lastChanged = -1;
    for (const p of plan) {
      const col = p.flags.col.slice();
      for (const [x, y] of p.pieces) for (let k = x; k < y; k++) if (!p.flags.delim[k]) col[k] = paint ? color : '';
      tidy(p.info, col, p.flags.delim);
      if (col.every((v, k) => v === p.flags.col[k])) continue;
      const out = build(p.line, p.flags.delim, col, p.info.atoms);
      if (out !== p.line && lineIntact(p.line, out)) { newLines[p.i] = out; lastChanged = Math.max(lastChanged, p.i); }
    }
    if (lastChanged < 0) return none;

    const from0 = starts[li0], oldRegion = lines.slice(li0, li1 + 1).join('\n'), newRegion = newLines.slice(li0, li1 + 1).join('\n');
    let pre = 0; const lim = Math.min(oldRegion.length, newRegion.length);
    while (pre < lim && oldRegion[pre] === newRegion[pre]) pre++;
    let suf = 0; while (suf < lim - pre && oldRegion[oldRegion.length - 1 - suf] === newRegion[newRegion.length - 1 - suf]) suf++;
    const full = lines.slice(0, li0).concat(newLines.slice(li0, li1 + 1), lines.slice(li1 + 1)).join('\n');
    let cursor = from0; for (let i = li0; i <= lastChanged; i++) cursor += newLines[i].length + (i < lastChanged ? 1 : 0);
    return {
      ok: true, changed: true, action: paint ? 'paint' : 'erase',
      edit: { from: from0 + pre, to: from0 + oldRegion.length - suf, insert: newRegion.slice(pre, newRegion.length - suf) },
      cursor, text: full,
    };
  };

  /** 本文の中の、マーカーの位置の一覧：[{ from, to, text, color }]（from〜to は ==  と色の印を含む。コードブロックなどの中は数えない）。確認用 */
  K.marks = function (text) {
    text = String(text || '');
    const lines = text.split('\n'), skip = skipLines(lines, lines.length - 1), out = [];
    let o = 0;
    lines.forEach((l, i) => {
      if (!skip[i]) for (const m of analyze(l).marks) out.push({ from: o + m.a, to: o + m.b, text: l.slice(m.a + 2, m.b - 2 - m.suf), color: m.color });
      o += l.length + 1;
    });
    return out;
  };
  /** マーカーの記号（== と色の印）だけを取り除いた本文。確認用（マーカーを付けても、文字そのものは変わらないことを確かめる） */
  K.strip = function (text) {
    text = String(text || '');
    const lines = text.split('\n'), skip = skipLines(lines, lines.length - 1);
    return lines.map((l, i) => {
      if (skip[i]) return l;
      const { marks } = analyze(l); let out = '', p = 0;
      for (const m of marks) { out += l.slice(p, m.a) + l.slice(m.a + 2, m.b - 2 - m.suf); p = m.b; }
      return out + l.slice(p);
    }).join('\n');
  };
})(typeof window !== 'undefined' ? window : globalThis);
