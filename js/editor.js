/* ノートの「書く場所＝表示する場所」のエディタ（ライブプレビュー）。
 *
 * ・部品は CodeMirror 6（vendor/editor/cm.js。日本語の変換入力に強い）。ノートの保存形式は、今までと同じ「記号つきの文章」のまま。
 *   見た目だけを、書いたその場で変える（保存・同期・印刷・AI への影響なし）。
 * ・行の種類（見出し・箇条書き・一問一答・用語・表…）の見分け方は、プレビューと同じ規則（js/markdown.js の blocks()）を使う。
 *     見出し・箇条書き・引用・Q&A・用語・区切り線 … 行の見た目を、その場で変える。行の頭の記号（#・-・>・Q:）は、カーソルがその行にないときだけ隠す。
 *     ==重要== {{穴埋め}} **太字** `コード` $数式$ ![画像]() [リンク]() … 文字の見た目をその場で変える。記号は、カーソルがその部分にないときだけ隠す。
 *     表・数式ブロック・図解・コードブロック … カーソルがないときは、完成した見た目（プレビューと同じ描画）。カーソルが入ると、書き換えられる文章に戻る。
 * ・変換入力（IME）の途中は、見た目の組み替えを止める（途中の文字が壊れないように）。
 * ・window.CM が無い（読み込めなかった）ときは、LN.editor.available が false になり、従来の「枠が分かれた」エディタに戻る。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const CM = root.CM;
  const E = (LN.editor = { available: false });
  if (!CM || !CM.EditorView || !LN.md || !LN.md.RE) return;
  E.available = true;

  const { EditorState, EditorSelection, StateField, StateEffect, Prec, Transaction } = CM;
  const { EditorView, Decoration, ViewPlugin, WidgetType, keymap, drawSelection, placeholder } = CM;
  const { history, historyKeymap, defaultKeymap, insertNewline } = CM;
  const doc = root.document;
  const RE = LN.md.RE;

  /* ================= 見た目の部品（その場に差し込む小さな表示） ================= */
  class TextWidget extends WidgetType {
    constructor(text, cls) { super(); this.text = text; this.cls = cls; }
    eq(o) { return o.text === this.text && o.cls === this.cls; }
    toDOM() { const s = doc.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
    ignoreEvent() { return false; }
  }
  /** 数式（プレビューと同じ描画） */
  class MathWidget extends WidgetType {
    constructor(src) { super(); this.src = src; }
    eq(o) { return o.src === this.src; }
    toDOM() { const s = doc.createElement('span'); s.className = 'math'; s.innerHTML = LN.md.mathHtml(this.src); return s; }
    ignoreEvent() { return false; }
  }
  /** 画像（ノートの画像は img:ID。データは LN.images にある） */
  class ImgWidget extends WidgetType {
    constructor(src, alt) { super(); this.src = src; this.alt = alt; }
    eq(o) { return o.src === this.src && o.alt === this.alt; }
    toDOM() {
      let data = '';
      if (this.src.startsWith('img:')) data = (LN.images || {})[this.src.slice(4)] || '';
      else if (/^https?:\/\//.test(this.src)) data = this.src;
      if (!data) { const m = doc.createElement('span'); m.className = 'img-missing'; m.textContent = '［画像が見つかりません］'; return m; }
      const i = doc.createElement('img'); i.src = data; i.alt = this.alt || ''; i.className = 'ln-img'; i.draggable = false;
      return i;
    }
    ignoreEvent() { return false; }
  }
  class HrWidget extends WidgetType {
    eq() { return true; }
    toDOM() { const d = doc.createElement('span'); d.className = 'ln-hr'; return d; }
    ignoreEvent() { return false; }
  }
  /** 表・数式ブロック・図解・コードブロックを、完成した見た目で置く（プレビューと同じ HTML） */
  class BlockWidget extends WidgetType {
    constructor(html, kind) { super(); this.html = html; this.kind = kind; }
    eq(o) { return o.kind === this.kind && o.html === this.html; }
    toDOM(view) {
      const d = doc.createElement('div');
      d.className = 'md ln-blk ln-blk-' + this.kind;
      d.innerHTML = this.html;
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = view.posAtDOM(d);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
        view.focus();
      });
      return d;
    }
    ignoreEvent() { return true; }
  }

  /* ================= 文章の構造（行の種類）の解析 ================= */
  const BLOCK_KINDS = new Set(['table', 'math', 'figure', 'code']); // カーソルがないとき、完成した見た目で置き換える種類

  function parse(text) {
    const bs = LN.md.blocks(text);
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
    const n = starts.length;
    return bs.map((b) => {
      const to = Math.min(b.to, n);
      return { kind: b.kind, html: b.html, fromLine: b.from, toLine: to, from: starts[b.from], to: to < n ? starts[to] - 1 : text.length };
    });
  }
  const parsedField = StateField.define({
    create: (state) => parse(state.doc.toString()),
    update: (v, tr) => (tr.docChanged ? parse(tr.state.doc.toString()) : v),
  });

  const touches = (sel, a, b) => { for (const r of sel.ranges) if (r.from <= b && r.to >= a) return true; return false; };

  /* ノートを開いた直後や、別の場所を触っているあいだ（エディタにカーソルがないとき）は、どこも「書き換え中」にせず、全体を完成した見た目で出す */
  const focusEffect = StateEffect.define();
  const focusField = StateField.define({
    create: () => false,
    update(v, tr) { for (const e of tr.effects) if (e.is(focusEffect)) return e.value; return v; },
  });
  const NOSEL = { ranges: [] };
  const activeSel = (state) => (state.field(focusField) ? state.selection : NOSEL);

  /* 変換入力が終わったときに、見た目を組み直させる合図 */
  const refresh = StateEffect.define();

  /* ================= ブロック（表・数式・図解・コード）の置き換え ================= */
  function blockDecos(state) {
    const sel = activeSel(state), out = [];
    for (const b of state.field(parsedField)) {
      if (!BLOCK_KINDS.has(b.kind) || touches(sel, b.from, b.to)) continue;
      out.push(Decoration.replace({ widget: new BlockWidget(b.html, b.kind), block: true }).range(b.from, b.to));
    }
    return Decoration.set(out, true);
  }
  const blockField = StateField.define({
    create: (state) => blockDecos(state),
    update(v, tr) { return tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refresh) || e.is(focusEffect)) ? blockDecos(tr.state) : v; },
    provide: (f) => EditorView.decorations.from(f),
  });

  /* ================= 行・文字の見た目 ================= */
  const DIM = Decoration.mark({ class: 'ln-syn' });
  const HIDE = Decoration.replace({});
  const lineDeco = (cls, style) => Decoration.line(style ? { class: cls, attributes: { style } } : { class: cls });

  const RX = {
    code: /`([^`\n]+)`/g,
    math: /\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g,
    img: /!\[([^\]]*)\]\(([^)\s]+)\)/g,
    link: /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    bold: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g,
    em: /(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g,
    del: /~~(?=\S)([\s\S]+?)(?<=\S)~~/g,
    mark: /==(?=\S)([\s\S]+?)(?<=\S)==/g,
    cloze: /\{\{([\s\S]+?)\}\}/g,
  };
  const RE_TERM_POS = /^(\s*)([^\s`].{0,58}?)(\s+::\s+|\s*：：\s*)(\S.*)$/; // 用語行（RE_TERM と同じ規則で、位置も取る）
  const RE_BULLET = /^(\s*)([-*+]|\d+[.)])(\s+)/;
  const RE_QPRE = /^(\s*(?:Q|Ｑ|問)\s*[:：]\s*)/i;
  const RE_APRE = /^(\s*(?:A|Ａ|答)\s*[:：]\s*)/i;

  /** 文の中の記号（==重要== {{穴埋め}} など）を、その場で見た目に変える。プレビュー（LN.md.inline）と同じ順序・同じ規則 */
  function inlineDecos(out, text, base, sel) {
    if (!text) return;
    let s = text;
    const mask = (a, b) => { s = s.slice(0, a) + '\u0000'.repeat(b - a) + s.slice(b); };
    const find = (re) => { re.lastIndex = 0; const r = []; let m; while ((m = re.exec(s))) r.push(m); return r; };
    const touched = (a, b) => touches(sel, base + a, base + b);
    const syn = (a, b, t) => out.push((t ? DIM : HIDE).range(base + a, base + b));
    const wrap = (m, open, close, spec) => {
      const a = m.index, b = a + m[0].length, t = touched(a, b);
      out.push(Decoration.mark(spec).range(base + a + open, base + b - close));
      syn(a, a + open, t); syn(b - close, b, t);
      return [a, b];
    };

    find(RX.code).forEach((m) => { const [a, b] = wrap(m, 1, 1, { tagName: 'code' }); mask(a, b); });
    find(RX.math).forEach((m) => {
      const a = m.index, b = a + m[0].length;
      if (touched(a, b)) out.push(Decoration.mark({ class: 'ln-math-src' }).range(base + a, base + b));
      else out.push(Decoration.replace({ widget: new MathWidget(m[1]) }).range(base + a, base + b));
      mask(a, b);
    });
    find(RX.img).forEach((m) => {
      const a = m.index, b = a + m[0].length, src = m[2];
      if (src.startsWith('img:') || /^https?:\/\//.test(src)) {
        const w = new ImgWidget(src, m[1]);
        if (touched(a, b)) { out.push(Decoration.widget({ widget: w, side: -1 }).range(base + a)); out.push(DIM.range(base + a, base + b)); } // 書き換え中も、画像は見えたまま
        else out.push(Decoration.replace({ widget: w }).range(base + a, base + b));
      }
      mask(a, b);
    });
    find(RX.link).forEach((m) => {
      const a = m.index, b = a + m[0].length, t = touched(a, b), from = a + 1, to = from + m[1].length;
      out.push(Decoration.mark({ class: 'ln-link' }).range(base + from, base + to));
      syn(a, from, t); syn(to, b, t);
      mask(a, b);
    });
    const marks = [[RX.bold, 2, { tagName: 'strong' }], [RX.em, 1, { tagName: 'em' }], [RX.del, 2, { tagName: 'del' }], [RX.mark, 2, { tagName: 'mark' }], [RX.cloze, 2, { class: 'cloze' }]];
    for (const [re, n, spec] of marks) {
      find(re).forEach((m) => { const [a, b] = wrap(m, n, n, spec); mask(a, a + n); mask(b - n, b); });
    }
  }

  /** 用語行（用語 :: 説明）の見た目。text は、箇条書きの記号などを除いた本文、base はその文書内の位置 */
  function termDecos(out, text, base, sel, lnTouched) {
    const m = RE_TERM_POS.exec(text);
    if (!m) return false;
    const termFrom = m[1].length, termTo = termFrom + m[2].length, sepTo = termTo + m[3].length;
    out.push(Decoration.mark({ tagName: 'strong', class: 'term' }).range(base + termFrom, base + termTo));
    inlineDecos(out, m[2], base + termFrom, sel);
    out.push(lnTouched ? DIM.range(base + termTo, base + sepTo) : Decoration.replace({ widget: new TextWidget('：', 'term-sep') }).range(base + termTo, base + sepTo));
    inlineDecos(out, m[4], base + sepTo, sel);
    return true;
  }

  function buildLive(view) {
    const st = view.state, d = st.doc, sel = activeSel(st), blocks = st.field(parsedField);
    const out = [];
    const vis = view.visibleRanges;
    const inView = (a, b) => vis.some((r) => r.from <= b && r.to >= a);
    const lineTouched = (ln) => touches(sel, ln.from, ln.to);
    const widgetRange = (b) => BLOCK_KINDS.has(b.kind) && !touches(sel, b.from, b.to); // 完成した見た目に置き換え中の範囲

    // 空行を詰める（プレビューの段落の間隔に近づける）
    const covered = blocks.filter(widgetRange);
    for (const r of vis) {
      for (let n = d.lineAt(r.from).number, last = d.lineAt(r.to).number; n <= last; n++) {
        const ln = d.line(n);
        if (ln.text.trim() === '' && !covered.some((b) => b.from <= ln.from && b.to >= ln.to)) out.push(lineDeco('ln-blank').range(ln.from));
      }
    }

    for (const b of blocks) {
      if (!inView(b.from, b.to) || widgetRange(b)) continue;
      const line = (i) => d.line(i + 1); // i は 0 始まりの行番号

      if (b.kind === 'h') {
        const ln = line(b.fromLine), m = /^(#{1,6})(\s+)/.exec(ln.text);
        if (!m) continue;
        out.push(lineDeco('ln-h ln-h' + Math.min(m[1].length, 4)).range(ln.from));
        const pre = m[1].length + m[2].length;
        out.push((lineTouched(ln) ? DIM : HIDE).range(ln.from, ln.from + pre));
        inlineDecos(out, ln.text.slice(pre), ln.from + pre, sel);
      } else if (b.kind === 'p') {
        for (let i = b.fromLine; i < b.toLine; i++) out.push(lineDeco('ln-p').range(line(i).from));
        inlineDecos(out, d.sliceString(b.from, b.to), b.from, sel); // 段落は、複数行にまたがる記号も見た目に変える
      } else if (b.kind === 'list') {
        for (let i = b.fromLine; i < b.toLine; i++) {
          const ln = line(i), t = ln.text;
          if (!t.trim()) continue;
          const m = RE_BULLET.exec(t);
          if (!m) { out.push(lineDeco('ln-li ln-li-cont', '--ind:' + Math.min(6, Math.round(t.search(/\S/) / 2))).range(ln.from)); inlineDecos(out, t.replace(/\s+$/, ''), ln.from, sel); continue; }
          const ind = Math.min(6, Math.round(m[1].replace(/\t/g, '    ').length / 2)), pre = m[0].length, ordered = /\d/.test(m[2]), tl = lineTouched(ln);
          out.push(lineDeco('ln-li', '--ind:' + ind).range(ln.from));
          const mf = ln.from + m[1].length;
          if (ordered) out.push(Decoration.mark({ class: 'ln-num' }).range(mf, ln.from + pre));
          else if (tl) out.push(DIM.range(mf, ln.from + pre));
          else out.push(Decoration.replace({ widget: new TextWidget(ind ? '◦' : '•', 'ln-bullet') }).range(mf, ln.from + pre));
          const rest = t.slice(pre);
          if (!termDecos(out, rest, ln.from + pre, sel, tl)) inlineDecos(out, rest, ln.from + pre, sel);
        }
      } else if (b.kind === 'quote') {
        for (let i = b.fromLine; i < b.toLine; i++) {
          const ln = line(i), m = /^(\s*>\s?)/.exec(ln.text);
          if (!m) continue;
          out.push(lineDeco('ln-quote').range(ln.from));
          out.push((lineTouched(ln) ? DIM : HIDE).range(ln.from, ln.from + m[1].length));
          inlineDecos(out, ln.text.slice(m[1].length), ln.from + m[1].length, sel);
        }
      } else if (b.kind === 'qa') {
        let phase = 'q';
        for (let i = b.fromLine; i < b.toLine; i++) {
          const ln = line(i), t = ln.text, tl = lineTouched(ln);
          let cls = 'ln-qa ', pre = 0, tag = '';
          const mq = RE_QPRE.exec(t), ma = phase === 'q' ? RE_APRE.exec(t) : null;
          if (mq && phase === 'q') { tag = 'Q'; pre = mq[1].length; cls += 'ln-qa-q' + (i === b.fromLine ? ' ln-qa-top' : ''); }
          else if (ma) { phase = 'a'; tag = 'A'; pre = ma[1].length; cls += 'ln-qa-a ln-qa-a1'; }
          else cls += (phase === 'q' ? 'ln-qa-q' : 'ln-qa-a') + ' ln-qa-cont';
          if (i === b.toLine - 1) cls += ' ln-qa-bot';
          out.push(lineDeco(cls).range(ln.from));
          if (tag) out.push(tl ? Decoration.mark({ class: 'ln-syn ln-syn-tag' }).range(ln.from, ln.from + pre) : Decoration.replace({ widget: new TextWidget(tag, 'qa-tag ln-qtag ln-qtag-' + tag.toLowerCase()) }).range(ln.from, ln.from + pre));
          inlineDecos(out, t.slice(pre), ln.from + pre, sel);
        }
      } else if (b.kind === 'term') {
        const ln = line(b.fromLine);
        out.push(lineDeco('ln-termline').range(ln.from));
        termDecos(out, ln.text, ln.from, sel, lineTouched(ln));
      } else if (b.kind === 'hr') {
        const ln = line(b.fromLine);
        if (lineTouched(ln)) out.push(DIM.range(ln.from, ln.to));
        else if (ln.to > ln.from) out.push(Decoration.replace({ widget: new HrWidget() }).range(ln.from, ln.to));
      } else if (BLOCK_KINDS.has(b.kind)) { // カーソルが入っている表・数式・図解・コード：書き換えられる文章
        for (let i = b.fromLine; i < b.toLine; i++) out.push(lineDeco('ln-src ln-src-' + b.kind + (i === b.fromLine ? ' ln-src-top' : '') + (i === b.toLine - 1 ? ' ln-src-bot' : '')).range(line(i).from));
      }
    }
    return Decoration.set(out, true);
  }

  const livePlugin = ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildLive(view); }
    update(u) {
      const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
      if (u.view.composing && !forced) { // 変換入力の途中は、見た目を組み替えず、位置だけ追従させる（途中の文字が壊れないように）
        if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        return;
      }
      if (forced || u.docChanged || u.selectionSet || u.viewportChanged || u.focusChanged) this.decorations = buildLive(u.view);
    }
  }, { decorations: (v) => v.decorations });

  /* ================= エディタを作る ================= */
  const keysNoEnter = defaultKeymap.filter((k) => k.key !== 'Enter');

  /**
   * opts: { parent, doc, placeholder, onChange(text), onKeydown(event), onImageFile(file) }
   * 戻り値：<textarea> のように使える窓口（value / selectionStart / selectionEnd / setSelectionRange / focus）と、view
   */
  E.create = function (opts) {
    let silent = false;
    const handlers = EditorView.domEventHandlers({
      keydown(e) { if (opts.onKeydown) opts.onKeydown(e); return e.defaultPrevented; },
      paste(e) {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        const item = Array.from(items).find((i) => i.type.startsWith('image/'));
        if (item && opts.onImageFile) { e.preventDefault(); opts.onImageFile(item.getAsFile()); return true; }
        return false;
      },
      dragover(e) { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); return false; },
      drop(e) {
        const f = e.dataTransfer && Array.from(e.dataTransfer.files || []).find((x) => x.type.startsWith('image/'));
        if (f && opts.onImageFile) { e.preventDefault(); opts.onImageFile(f); return true; }
        return false;
      },
      compositionend(e, view) { root.setTimeout(() => { if (!view.composing) view.dispatch({ effects: refresh.of(null) }); }, 0); return false; },
    });
    const view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: String(opts.doc || ''),
        extensions: [
          history(), drawSelection(), EditorView.lineWrapping,
          focusField, EditorView.focusChangeEffect.of((state, focusing) => focusEffect.of(focusing)),
          parsedField, blockField, livePlugin,
          EditorView.contentAttributes.of({ spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off', 'aria-label': 'ノートの本文', class: 'md' }),
          Prec.high(handlers),
          keymap.of([{ key: 'Enter', run: insertNewline }, ...historyKeymap, ...keysNoEnter]),
          opts.placeholder ? placeholder(opts.placeholder) : [],
          EditorView.updateListener.of((u) => { if (u.docChanged && !silent && opts.onChange) opts.onChange(u.state.doc.toString()); }),
        ],
      }),
    });

    const sel = () => view.state.selection.main;
    const ed = {
      view,
      get value() { return view.state.doc.toString(); },
      set value(v) { silent = true; try { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(v) }, annotations: Transaction.addToHistory.of(false) }); } finally { silent = false; } },
      get selectionStart() { return sel().from; },
      get selectionEnd() { return sel().to; },
      setSelectionRange(a, b) { view.dispatch({ selection: EditorSelection.range(a, b === undefined ? a : b), scrollIntoView: true }); },
      focus() { view.focus(); },
      /** s〜e を text に置き換えて、カーソルを入れた文字の後ろに置く（1回の操作として、元に戻せる） */
      insertAt(text, s, e) { view.dispatch({ changes: { from: s, to: e, insert: text }, selection: { anchor: s + text.length }, scrollIntoView: true, userEvent: 'input' }); },
      destroy() { view.destroy(); },
    };
    return ed;
  };
})(typeof window !== 'undefined' ? window : globalThis);
