/* 考査対策: 範囲の解決・単元まとめの下書き・プリント（HTML）の組み立て */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const md = LN.md;
  const esc = md.esc;

  const NONE = 'none:'; // 単元に属さないノートの範囲キー（none:<教科ID>）
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

  const passes = (n, f) => (f === 'star2' ? n.star >= 2 : f === 'star3' ? n.star >= 3 : f === 'review' ? !!n.review : true);

  function notesOf(state, subjectId, unitId, filter) {
    return state.notes
      .filter((n) => n.subjectId === subjectId && (n.unitId || null) === unitId && passes(n, filter))
      .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt);
  }

  /** 範囲キー → [{subject, units:[{key, unit, name, notes}]}]（教科・単元の並び順どおり） */
  function resolveRange(state, keys, filter) {
    const set = new Set(keys || []);
    const groups = [];
    for (const sub of state.subjects.slice().sort(byOrder)) {
      const g = { subject: sub, units: [] };
      for (const u of state.units.filter((x) => x.subjectId === sub.id).sort(byOrder)) {
        if (set.has(u.id)) g.units.push({ key: u.id, unit: u, name: u.name, notes: notesOf(state, sub.id, u.id, filter) });
      }
      if (set.has(NONE + sub.id)) g.units.push({ key: NONE + sub.id, unit: null, name: '未分類', notes: notesOf(state, sub.id, null, filter) });
      if (g.units.length) groups.push(g);
    }
    return groups;
  }

  /** 単元（ノート群）の抽出結果を合算 */
  function unitData(u) {
    const d = { highlights: [], terms: [], qas: [], cloze: 0 };
    for (const n of u.notes) {
      const x = md.extract(n.body);
      d.highlights.push(...x.highlights);
      d.terms.push(...x.terms);
      d.qas.push(...x.qas);
      d.cloze += x.cloze;
    }
    const seen = new Set();
    d.highlights = d.highlights.filter((h) => !seen.has(h.text) && seen.add(h.text));
    return d;
  }

  const unCloze = (s) => String(s).replace(/\{\{([\s\S]+?)\}\}/g, '$1');
  const unList = (s) => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');

  /** ノートから「単元まとめ」の下書き（Markdown）を作る */
  function draftSummary(u) {
    const d = unitData(u);
    const parts = [];
    if (d.highlights.length) parts.push('## 重要ポイント\n' + d.highlights.map((h) => '- ' + unCloze(unList(h.text))).join('\n'));
    if (d.terms.length) {
      const seen = new Set();
      const terms = d.terms.filter((t) => !seen.has(t.term) && seen.add(t.term));
      parts.push('## 用語\n' + terms.map((t) => '- ' + t.term + ' :: ' + unCloze(t.def)).join('\n'));
    }
    return parts.join('\n\n');
  }

  /** 先頭の見出しがノート名と同じなら除く（プリントで二重表示になるため） */
  function noteBlocks(n, offset) {
    const bs = md.blocks(n.body, { headingOffset: offset });
    if (bs.length && bs[0].kind === 'h' && (bs[0].meta.text || '').trim() === (n.title || '').trim()) bs.shift();
    return bs;
  }

  const fmtDate = (s) => (s ? s.replace(/-/g, '/') : '');

  /* ---------- 共通パーツ ---------- */
  const glossaryTable = (terms) =>
    '<table class="s-table"><thead><tr><th class="c-term">用語</th><th>説明</th></tr></thead><tbody>' +
    terms.map((t) => '<tr><td class="c-term">' + md.inline(t.term) + '</td><td>' + md.inline(t.def) + '</td></tr>').join('') + '</tbody></table>';

  function autoSummaryHtml(d) {
    if (!d.highlights.length && !d.terms.length) return '<p class="s-empty">（重要マーク ==…== や 用語 :: 説明 が見つかりませんでした）</p>';
    let h = '';
    if (d.highlights.length) {
      h += '<h4 class="s-sub">重要ポイント</h4><ul class="s-points">' +
        d.highlights.map((p) => '<li>' + md.inline(unCloze(unList(p.text))) + '</li>').join('') + '</ul>';
    }
    if (d.terms.length) h += '<h4 class="s-sub">用語</h4>' + glossaryTable(d.terms.map((t) => ({ term: t.term, def: unCloze(t.def) })));
    return h;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffled(arr, seed) {
    const a = arr.slice(), rnd = mulberry32(seed || 1);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  function excerpt(bs) {
    const out = [];
    let pending = null;
    for (const b of bs) {
      if (b.kind === 'h' && !b.cloze) { pending = b; continue; }
      if (b.cloze) { if (pending) { out.push(pending); pending = null; } out.push(b); }
    }
    return out;
  }

  const noteHead = (n) => '<h4 class="s-note-title">' + esc(n.title || '無題') + (n.date ? '<small>' + fmtDate(n.date) + '</small>' : '') + '</h4>';

  /* ---------- 種類別の本文 ---------- */
  const TYPE_LABEL = { summary: 'まとめ', cloze: '穴埋め問題', qa: '一問一答', terms: '用語テスト', custom: 'オリジナル' };
  const ANSWER_MARK = /^\s*={3,}\s*解答[^\n=]*={3,}\s*$/m;

  /** AI が作ったプリント本文を「問題部分」と「解答部分」に分ける */
  function splitAnswers(markdown) {
    const m = ANSWER_MARK.exec(markdown || '');
    if (!m) return { q: String(markdown || '').trim(), a: '' };
    return { q: markdown.slice(0, m.index).trim(), a: markdown.slice(m.index + m[0].length).trim() };
  }

  function bodyCustom(state, o) {
    const s = (state.aiSheets || []).find((x) => x.id === o.customId);
    if (!s || !s.markdown.trim()) return { html: '', count: 0 };
    const { q, a } = splitAnswers(s.markdown);
    const bs = md.blocks(q, { headingOffset: 0 });
    const clozes = [].concat(...bs.map((b) => b.answers));
    let html = '<div class="s-content-custom s-md md">' + bs.map((b) => b.html).join('\n') + '</div>';
    if (o.answerMode !== 'blank' && (a || clozes.length)) {
      const filled = o.answerMode === 'filled';
      html += '<section class="s-key' + (filled ? ' s-key-inline' : '') + '"><h2 class="s-subject-title">解答</h2>';
      if (clozes.length) html += '<h4 class="s-sub">穴埋め</h4><ol class="key-list cloze-key">' + clozes.map((c) => '<li>' + c + '</li>').join('') + '</ol>';
      if (a) html += '<div class="s-md md">' + md.render(a, { headingOffset: 1 }) + '</div>';
      html += '</section>';
    }
    return { html, count: bs.length ? 1 : 0, cloze: clozes.length };
  }

  /** 選択した範囲のノート・まとめを、AI に渡す文脈テキストにする */
  function rangeContext(state, keys, filter) {
    const parts = [];
    for (const g of resolveRange(state, keys, filter)) {
      for (const u of g.units) {
        parts.push('# 教科：' + g.subject.name + ' ／ 単元：' + u.name);
        if (u.unit && u.unit.summary && u.unit.summary.trim()) parts.push('## 単元まとめ（学生が作成）\n' + u.unit.summary.trim());
        for (const n of u.notes) parts.push('## ノート：' + (n.title || '無題') + (n.date ? '（' + n.date + '）' : '') + '\n' + String(n.body || '').replace(/!\[[^\]]*\]\(img:[a-z0-9]+\)/g, '（画像）').trim());
      }
    }
    return parts.join('\n\n');
  }

  function bodySummary(u, o) {
    let h = '';
    const manual = u.unit && u.unit.summary && u.unit.summary.trim();
    if (o.includeSummary) h += manual ? '<div class="s-md md">' + md.render(u.unit.summary, { headingOffset: 2 }) + '</div>' : autoSummaryHtml(unitData(u));
    if (o.includeNotes) {
      for (const n of u.notes) h += '<div class="s-note">' + noteHead(n) + '<div class="s-md md">' + noteBlocks(n, 4).map((b) => b.html).join('\n') + '</div></div>';
    }
    return h;
  }

  function buildBody(groups, o) {
    const ctx = { qaNo: 0, answers: [], keyItems: [], count: 0, allTerms: [] };
    const filled = o.answerMode === 'filled';
    let html = '';

    for (const g of groups) {
      let gh = '';
      for (const u of g.units) {
        let uh = '';
        if (o.type === 'summary') {
          uh = bodySummary(u, o);
          if (o.appendGlossary) ctx.allTerms.push(...unitData(u).terms);
          if (uh) ctx.count++;
        } else if (o.type === 'cloze') {
          for (const n of u.notes) {
            const bs = noteBlocks(n, 4);
            if (!bs.some((b) => b.cloze)) continue;
            const keep = o.clozeExcerpt ? excerpt(bs) : bs;
            uh += '<div class="s-note">' + noteHead(n) + '<div class="s-md md">' + keep.map((b) => b.html).join('\n') + '</div></div>';
            keep.forEach((b) => ctx.answers.push(...b.answers));
            ctx.count += keep.reduce((s, b) => s + b.cloze, 0);
          }
        } else if (o.type === 'qa') {
          let pairs = unitData(u).qas.filter((p) => p.a !== null && p.a !== '');
          if (o.shuffle) pairs = shuffled(pairs, (o.seed || 1) + pairs.length);
          if (pairs.length) {
            uh = '<ol class="qa-list" start="' + (ctx.qaNo + 1) + '">' + pairs.map((p) => {
              ctx.qaNo++; ctx.count++;
              ctx.keyItems.push(md.render(p.a));
              return '<li class="qa-item"><div class="qa-question">' + md.inline(p.q) + '</div>' +
                (filled ? '<div class="qa-answer">' + md.render(p.a) + '</div>' : '<div class="qa-space"></div>') + '</li>';
            }).join('') + '</ol>';
          }
        } else if (o.type === 'terms') {
          let terms = unitData(u).terms;
          const seen = new Set();
          terms = terms.filter((t) => !seen.has(t.term) && seen.add(t.term));
          if (o.shuffle) terms = shuffled(terms, (o.seed || 1) + terms.length);
          if (terms.length) {
            const mode = filled ? 'filled' : o.termMode;
            uh = '<table class="s-table terms-test"><thead><tr><th class="c-no">No.</th><th class="c-term">用語</th><th>説明</th></tr></thead><tbody>' +
              terms.map((t) => {
                ctx.qaNo++; ctx.count++;
                ctx.keyItems.push('<strong>' + md.inline(t.term) + '</strong>：' + md.inline(t.def));
                const term = mode === 'hide-term' ? '<td class="c-term c-blank"></td>' : '<td class="c-term">' + md.inline(t.term) + '</td>';
                const def = mode === 'hide-def' ? '<td class="c-blank"></td>' : '<td>' + md.inline(t.def) + '</td>';
                return '<tr><td class="c-no">' + ctx.qaNo + '</td>' + term + def + '</tr>';
              }).join('') + '</tbody></table>';
          }
        }
        if (!uh) continue;
        gh += '<section class="s-unit"><h3 class="s-unit-title">' + esc(u.name) + '</h3><div class="s-unit-body">' + uh + '</div></section>';
      }
      if (gh) {
        html += '<section class="s-subject"><h2 class="s-subject-title"><span class="chip" style="--c:' + g.subject.color + '"></span>' + esc(g.subject.name) + '</h2>' + gh + '</section>';
      }
    }

    if (o.type === 'summary' && o.appendGlossary && ctx.allTerms.length) {
      const seen = new Set();
      const terms = ctx.allTerms.filter((t) => !seen.has(t.term + '\u0000' + t.def) && seen.add(t.term + '\u0000' + t.def))
        .sort((a, b) => a.term.localeCompare(b.term, 'ja'));
      html += '<section class="s-subject s-glossary"><h2 class="s-subject-title">用語集（五十音順）</h2>' + glossaryTable(terms) + '</section>';
    }

    if (o.type !== 'summary' && o.answerMode === 'key') {
      const items = o.type === 'cloze' ? ctx.answers : ctx.keyItems;
      if (items.length) {
        html += '<section class="s-key"><h2 class="s-subject-title">解答</h2><ol class="key-list">' + items.map((a) => '<li>' + a + '</li>').join('') + '</ol></section>';
      }
    }
    return { html, count: ctx.count };
  }

  function rangeText(groups) {
    return groups.map((g) => g.subject.name + '（' + g.units.map((u) => u.name).join('・') + '）').join('　');
  }

  const PAPER = { A4: '210mm', B5: '182mm', A5: '148mm' };

  function defaultOpts() {
    return {
      type: 'summary', title: '', filter: 'all',
      includeSummary: true, includeNotes: false, appendGlossary: true, // まとめ
      clozeExcerpt: true, answerMode: 'key',                            // 穴埋め / 一問一答 / 用語テスト（blank | key | filled）
      termMode: 'hide-def', shuffle: false, seed: 1, customId: null,
      fontSize: 'm', cols: 1, paper: 'A4', pageBreak: 'unit', showName: true,
    };
  }

  function defaultTitle(o, examName) {
    return (examName ? examName + ' ' : '') + TYPE_LABEL[o.type];
  }

  /** 考査対策プリント全体（HTML）を組み立てる */
  function build(state, o, examName) {
    o = Object.assign(defaultOpts(), o);
    const groups = resolveRange(state, o.keys, o.filter);
    const body = o.type === 'custom' ? bodyCustom(state, o) : buildBody(groups, o);
    const cls = ['sheet', 'fs-' + o.fontSize, 'cols-' + o.cols, 'pb-' + o.pageBreak, 't-' + o.type];
    if (o.type === 'cloze' || (o.type === 'custom' && body.cloze)) cls.push(o.answerMode === 'filled' ? 'answers' : 'blank');
    const aiSheet = o.type === 'custom' && (state.aiSheets || []).find((x) => x.id === o.customId);
    const title = aiSheet ? aiSheet.title : o.title && o.title.trim() ? o.title.trim() : defaultTitle(o, examName);
    let html = '<div class="' + cls.join(' ') + '" data-paper="' + o.paper + '"><header class="s-head"><div class="s-head-row"><h1 class="s-title">' + esc(title) +
      '</h1><span class="s-date">' + fmtDate(LN.today()) + ' 作成</span></div>';
    if (groups.length) html += '<div class="s-range">範囲：' + esc(rangeText(groups)) + '</div>';
    if (o.showName && o.type !== 'summary') {
      html += '<div class="s-fields"><span>名前<i></i></span><span>日付<i></i></span><span class="score">点数<i></i>／<i></i></span></div>';
    }
    html += '</header>';
    if (body.html) html += '<div class="s-content">' + body.html + '</div>';
    else html += '<p class="s-empty big">' + emptyMessage(o, groups) + '</p>';
    return { html: html + '</div>', count: body.count, groups };
  }

  function emptyMessage(o, groups) {
    if (o.type === 'custom') return 'ここに、AI が作ったプリントが表示されます。左の欄に「どんなプリントがほしいか」を入力して、「作成する」を押してください。';
    if (!groups.length) return '左の「範囲」で、まとめたい単元にチェックを入れてください。';
    if (o.type === 'cloze') return '穴埋めにしたい語を <b>{{ }}</b> で囲むと、ここに問題として集まります。（例：{{光合成}}）';
    if (o.type === 'qa') return '<b>Q:</b> 問い と <b>A:</b> 答え の行を書くと、ここに一問一答として集まります。';
    if (o.type === 'terms') return '<b>用語 :: 説明</b> の形で書くと、ここに用語テストとして集まります。';
    return '選んだ範囲に、まとめる内容（ノート）がありません。';
  }

  /** ノート1件の印刷用 */
  function buildNote(state, noteId) {
    const n = state.notes.find((x) => x.id === noteId);
    if (!n) return { html: '' };
    const sub = state.subjects.find((s) => s.id === n.subjectId);
    const unit = state.units.find((u) => u.id === n.unitId);
    let html = '<div class="sheet fs-m cols-1 pb-none t-summary" data-paper="A4"><header class="s-head"><div class="s-head-row"><h1 class="s-title">' + esc(n.title || '無題') + '</h1><span class="s-date">' + fmtDate(n.date) + '</span></div>' +
      '<div class="s-range">' + esc((sub ? sub.name : '') + (unit ? ' / ' + unit.name : '')) + '</div></header>' +
      '<div class="s-content"><div class="s-md md">' + noteBlocks(n, 1).map((b) => b.html).join('\n') + '</div></div></div>';
    return { html };
  }

  LN.sheets = { NONE, PAPER, TYPE_LABEL, resolveRange, unitData, draftSummary, build, buildNote, defaultOpts, defaultTitle, notesOf, splitAnswers, rangeContext };
})(window);
