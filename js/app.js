/* 画面（UI）: 教科 / 単元 / ノート編集 / 考査対策（単元まとめ・プリント作成） */
(function () {
  'use strict';
  const LN = window.LN, md = LN.md, sh = LN.sheets, esc = md.esc;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const st = () => LN.state;
  const byOrder = (a, b) => (a.order || 0) - (b.order || 0);
  const COLORS = ['#e0574f', '#e58a3a', '#d1a624', '#5fa05f', '#2f9e8f', '#3d7fd6', '#6a5fd1', '#b45fb0'];

  const I = (p) => '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
  const ICON = {
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    edit: I('<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>'),
    trash: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
    chev: I('<path d="M9 6l6 6-6 6"/>'),
    up: I('<path d="M6 15l6-6 6 6"/>'),
    down: I('<path d="M6 9l6 6 6-6"/>'),
    print: I('<path d="M7 9V3h10v6"/><path d="M7 17H4v-7h16v7h-3"/><path d="M7 14h10v7H7z"/>'),
    book: I('<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z"/><path d="M9 9h6M9 13h6"/>'),
    exam: I('<path d="M9 4h6v3H9z"/><path d="M6 5h12v16H6z"/><path d="M9 14l2 2 4-4"/>'),
    backup: I('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
    help: I('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17.5v.01"/>'),
    image: I('<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M5 17l5-4 3 2 3-3 3 3"/>'),
    spark: I('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'),
    file: I('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>'),
    chart: I('<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/><path d="M10 7h3a3 3 0 0 1 3 3v4"/>'),
    feedback: I('<path d="M4 5h16v11H8l-4 4z"/>'),
    contrast: I('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
    menu: I('<path d="M5 7h14M5 12h14M5 17h14"/>'),
  };

  const mgo = (p) => { if (LN.mobile) LN.mobile.go(p); }; // スマホ用：見せる画面を変える（パソコン用では何も起きない）
  const ui = { view: 'notes', subjectId: null, noteId: null, examId: null, examTab: 'summary', search: '', mode: 'split', study: false, closed: {}, open: {}, zoom: 0.72 };

  /* ---------- 参照ヘルパー ---------- */
  const subj = (id) => st().subjects.find((s) => s.id === id) || null;
  const unitsOf = (sid) => st().units.filter((u) => u.subjectId === sid).sort(byOrder);
  const curSubject = () => subj(ui.subjectId);
  const curNote = () => st().notes.find((n) => n.id === ui.noteId) || null;
  const curExam = () => st().exams.find((e) => e.id === ui.examId) || null;
  const sheetOpts = () => st().settings.sheet;
  const aiOn = () => !!(LN.ai && LN.ai.enabled);
  const aiReady = () => aiOn() && LN.ai.ready === true;
  const desktopOn = () => !!(LN.desktop && LN.desktop.available);
  const feedbackOn = () => desktopOn() || !!(LN.feedback && LN.feedback.available);
  const sortNotes = (a) => a.slice().sort((x, y) => (x.date || '').localeCompare(y.date || '') || x.createdAt - y.createdAt);
  const fmtDate = (s) => (s ? s.replace(/-/g, '/') : '');

  function persistUi() {
    Object.assign(st().settings.ui, { view: ui.view, subjectId: ui.subjectId, noteId: ui.noteId, examId: ui.examId, examTab: ui.examTab });
    LN.save();
  }

  function ensureSelection() {
    const s = st();
    if (!curSubject()) ui.subjectId = (s.subjects.slice().sort(byOrder)[0] || {}).id || null;
    const n = curNote();
    if (!n || n.subjectId !== ui.subjectId) {
      const cand = s.notes.filter((x) => x.subjectId === ui.subjectId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
      ui.noteId = cand ? cand.id : null;
    }
    if (!curExam()) ui.examId = (s.exams[0] || {}).id || null;
  }

  function pruneKeys() {
    const valid = new Set(st().units.map((u) => u.id).concat(st().subjects.map((s) => sh.NONE + s.id)));
    st().exams.forEach((e) => { e.keys = e.keys.filter((k) => valid.has(k)); });
  }

  const daysLeft = (d) => {
    if (!d) return null;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((new Date(d + 'T00:00:00') - t) / 86400000);
  };
  function daysPill(e) {
    const n = daysLeft(e.date);
    if (n === null) return '';
    if (n < 0) return '<span class="pill done">終了</span>';
    if (n === 0) return '<span class="pill soon">本日</span>';
    return '<span class="pill' + (n <= 7 ? ' soon' : '') + '">あと' + n + '日</span>';
  }
  const needsBackup = () => st().notes.length > 0 && Date.now() - Math.max(st().settings.lastBackup || 0, st().settings.lastAutoBackup || 0) > 7 * 86400000;

  /* ---------- トースト / ダイアログ ---------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function fieldHtml(f) {
    if (f.type === 'checkbox') return '<label class="check dlg-field"><input type="checkbox" name="' + f.name + '"' + (f.value ? ' checked' : '') + '> ' + esc(f.label) + '</label>';
    if (f.type === 'color') {
      return '<div class="dlg-field"><label class="l">' + esc(f.label) + '</label><div class="swatches">' +
        COLORS.map((c) => '<label class="swatch"><input type="radio" name="' + f.name + '" value="' + c + '"' + (c === f.value ? ' checked' : '') + '><span style="background:' + c + '"></span></label>').join('') + '</div></div>';
    }
    if (f.type === 'select') {
      return '<div class="dlg-field"><label class="l">' + esc(f.label) + '</label><select name="' + f.name + '">' +
        (f.options || []).map((o) => '<option value="' + esc(o[0]) + '"' + (o[0] === f.value ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select></div>';
    }
    if (f.type === 'textarea') {
      return '<div class="dlg-field"><label class="l">' + esc(f.label) + '</label><textarea name="' + f.name + '" rows="' + (f.rows || 4) + '" placeholder="' +
        esc(f.placeholder || '') + '"' + (f.required ? ' required' : '') + '>' + esc(f.value || '') + '</textarea></div>';
    }
    return '<div class="dlg-field"><label class="l">' + esc(f.label) + '</label><input type="' + (f.type || 'text') + '" name="' + f.name + '" value="' + esc(f.value || '') +
      '" placeholder="' + esc(f.placeholder || '') + '"' + (f.required ? ' required' : '') + ' autocomplete="off"></div>';
  }

  function ask(cfg) {
    const dlg = $('#dlg');
    return new Promise((resolve) => {
      let settled = false;
      // 別のダイアログを続けて開いても、前のダイアログの close イベントで閉じられないよう、open 中は無視する
      const onClose = () => { if (!dlg.open) finish(null); };
      const finish = (v) => {
        if (settled) return;
        settled = true;
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(v);
      };
      dlg.addEventListener('close', onClose);
      dlg.className = cfg.wide ? 'wide' : '';
      dlg.innerHTML = '<form class="dlg-form" method="dialog"><h3>' + esc(cfg.title) + '</h3>' +
        (cfg.message ? '<p class="dlg-msg">' + cfg.message + '</p>' : '') + (cfg.body || '') + (cfg.fields || []).map(fieldHtml).join('') +
        '<div class="dlg-actions">' +
        (cfg.extra ? '<button type="button" class="btn ghost" data-dlg="extra" style="margin-right:auto;color:var(--danger)">' + esc(cfg.extra) + '</button>' : '') +
        (cfg.hideCancel ? '' : '<button type="button" class="btn" data-dlg="cancel">' + esc(cfg.cancelText || 'キャンセル') + '</button>') +
        (cfg.hideOk ? '' : '<button type="submit" class="btn ' + (cfg.danger ? 'danger' : 'primary') + '">' + esc(cfg.ok || 'OK') + '</button>') + '</div></form>';
      const form = dlg.firstElementChild;
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const data = {};
        for (const f of cfg.fields || []) { const el = form.elements[f.name]; data[f.name] = f.type === 'checkbox' ? el.checked : el.value.trim(); }
        finish(data);
      });
      form.addEventListener('click', (e) => {
        const b = e.target.closest('[data-dlg]');
        if (!b) return;
        finish(b.dataset.dlg === 'extra' ? { __extra: true } : null);
      });
      dlg.showModal();
      const first = form.querySelector('input[type=text],input[type=date]');
      if (first) { first.focus(); first.select && first.select(); }
      if (cfg.onOpen) cfg.onOpen(form, finish);
    });
  }

  /* ---------- 全体描画 ---------- */
  function render() {
    destroyEditor(); // これから画面を描き直す：書いていたエディタの後始末（残すと、見えない所で動き続ける）
    ensureSelection();
    renderSidebar();
    if (ui.view === 'notes') renderNotes(); else renderExam();
    if (LN.mobile) LN.mobile.sync();
  }

  function renderSidebar() {
    const s = st();
    const inNotes = ui.view === 'notes';
    let head, list;
    if (inNotes) {
      head = '教科';
      list = s.subjects.slice().sort(byOrder).map((x) =>
        '<li class="side-item' + (x.id === ui.subjectId ? ' on' : '') + '" data-act="subject-select" data-id="' + x.id + '" title="' + esc(x.name) + '"><span class="dot" style="background:' + x.color + '"></span>' +
        '<span class="nm">' + esc(x.name) + '</span><span class="sub">' + s.notes.filter((n) => n.subjectId === x.id).length + '</span>' +
        '<button class="icon-btn" data-act="subject-edit" data-id="' + x.id + '" title="教科を編集">' + ICON.edit + '</button></li>').join('');
    } else {
      head = '考査';
      list = s.exams.slice().sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).map((x) =>
        '<li class="side-item' + (x.id === ui.examId ? ' on' : '') + '" data-act="exam-select" data-id="' + x.id + '" title="' + esc(x.name) + '"><span class="dot" style="background:var(--accent)"></span><span class="nm">' + esc(x.name) + '</span>' + daysPill(x) + '</li>').join('');
    }
    $('#sidebar').innerHTML =
      '<div class="brand"><span class="brand-logo">' + ICON.book + '</span>講義ノート</div>' +
      '<nav class="nav"><button class="nav-btn' + (inNotes ? ' on' : '') + '" data-act="nav" data-view="notes">' + ICON.book + 'ノート</button>' +
      '<button class="nav-btn' + (!inNotes ? ' on' : '') + '" data-act="nav" data-view="exam">' + ICON.exam + '考査対策</button></nav>' +
      '<div class="side-head"><span>' + head + '</span><button class="icon-btn" data-act="' + (inNotes ? 'subject-add' : 'exam-new') + '" title="' + head + 'を追加">' + ICON.plus + '</button></div>' +
      '<ul class="side-list">' + (list || '<li class="empty-note">' + (inNotes ? '教科がまだありません' : '考査がまだありません') + '</li>') + '</ul>' +
      '<div class="side-foot">' + (LN.cloud ? LN.cloud.chipHtml() : '') +
      '<button class="btn ghost" data-act="m-menu" title="デザイン・ガイド・バックアップ・フィードバックなど">' + ICON.menu + 'メニュー' + (needsBackup() && !(LN.cloud && LN.cloud.enabled && LN.cloud.enabled()) ? '<span class="dotwarn" title="7日以上バックアップしていません"></span>' : '') + '</button></div>';
  }

  function welcomeHtml() {
    return '<div class="welcome"><h1>講義ノートへようこそ</h1><p>教科ごとに講義メモを書きためて、考査前には単元ごとにまとめ、<br>そのまま印刷できるプリントに変えられます。</p>' +
      '<div class="steps"><div class="step"><b>1. 教科をつくる</b><span>教科ごとに単元を分けて、講義ノートを書きます。</span></div>' +
      '<div class="step"><b>2. 印をつけて書く</b><span><code>==重要==</code> <code>{{穴埋め}}</code> <code>用語 :: 説明</code> <code>Q:</code>/<code>A:</code> を書くだけ。</span></div>' +
      '<div class="step"><b>3. 考査前に集める</b><span>範囲を選ぶと、まとめ・穴埋め・一問一答・用語テストのプリントができます。</span></div></div>' +
      '<div class="row"><button class="btn primary" data-act="subject-add">' + ICON.plus + '教科を追加</button><button class="btn" data-act="sample">サンプルで試す</button></div></div>';
  }

  /* ---------- ノート画面 ---------- */
  function renderNotes() {
    const main = $('#main');
    if (!st().subjects.length) { main.innerHTML = welcomeHtml(); return; }
    const sub = curSubject();
    main.innerHTML =
      '<section class="list-col"><div class="list-head"><div class="m-bar"><button type="button" class="m-back" data-act="m-back">‹ 教科</button></div><div class="list-title"><span class="dot" style="background:' + sub.color + '"></span><h2>' + esc(sub.name) + '</h2></div>' +
      '<div style="display:flex;gap:8px"><button class="btn primary" style="flex:1;justify-content:center" data-act="note-new">' + ICON.plus + '新しいノート</button>' +
      '<button class="btn" data-act="unit-add" title="単元を追加">' + ICON.plus + '単元</button></div>' +
      '<input type="search" id="search" placeholder="この教科のノートを検索…" value="' + esc(ui.search) + '"></div><div class="list-body" id="listBody"></div></section>' +
      '<section class="editor-col" id="editorCol"></section>';
    renderList();
    renderEditor();
  }

  function noteItemHtml(n) {
    return '<div class="note-item' + (n.id === ui.noteId ? ' on' : '') + '" data-act="note-select" data-id="' + n.id + '"><div class="ni-title">' + esc(n.title || '無題のノート') +
      '</div><div class="ni-meta"><span>' + fmtDate(n.date) + '</span>' + (n.star ? '<span class="stars">' + '★'.repeat(n.star) + '</span>' : '') + (n.source === 'ai' ? '<span class="ai-badge" title="AI が作った内容です。確認してください">AI</span>' : '') + (n.review ? '<span class="badge">要復習</span>' : '') + '</div></div>';
  }

  function renderList() {
    const body = $('#listBody');
    if (!body) return;
    const sub = curSubject();
    const q = ui.search.trim().toLowerCase();
    const all = st().notes.filter((n) => n.subjectId === sub.id);
    const shown = q ? all.filter((n) => (n.title + '\n' + n.body).toLowerCase().includes(q)) : all;
    const units = unitsOf(sub.id);
    let html = '';
    units.forEach((u, idx) => {
      const ns = sortNotes(shown.filter((n) => n.unitId === u.id));
      if (q && !ns.length) return;
      const closed = ui.closed[u.id];
      html += '<div class="unit-group' + (closed ? ' closed' : '') + '"><div class="unit-head" data-act="unit-toggle" data-id="' + u.id + '">' + ICON.chev + '<span class="nm">' + esc(u.name) + '</span><span class="cnt">' + ns.length + '</span>' +
        '<span class="acts"><button class="icon-btn" data-act="unit-up" data-id="' + u.id + '" title="上へ"' + (idx === 0 ? ' disabled' : '') + '>' + ICON.up + '</button>' +
        '<button class="icon-btn" data-act="unit-down" data-id="' + u.id + '" title="下へ"' + (idx === units.length - 1 ? ' disabled' : '') + '>' + ICON.down + '</button>' +
        '<button class="icon-btn" data-act="unit-rename" data-id="' + u.id + '" title="単元名を変更">' + ICON.edit + '</button>' +
        '<button class="icon-btn danger" data-act="unit-del" data-id="' + u.id + '" title="単元を削除">' + ICON.trash + '</button></span></div>' +
        '<div class="unit-notes">' + (ns.map(noteItemHtml).join('') || '<div class="empty-note" style="padding:6px 22px;text-align:left">ノートなし</div>') + '</div></div>';
    });
    const loose = sortNotes(shown.filter((n) => !n.unitId));
    if (loose.length) {
      html += '<div class="unit-group' + (ui.closed.none ? ' closed' : '') + '"><div class="unit-head" data-act="unit-toggle" data-id="none">' + ICON.chev + '<span class="nm">未分類</span><span class="cnt">' + loose.length + '</span></div>' +
        '<div class="unit-notes">' + loose.map(noteItemHtml).join('') + '</div></div>';
    }
    if (!html) html = '<div class="empty-note">' + (q ? '該当するノートがありません' : 'ノートがありません。<br>「新しいノート」から書き始めましょう。') + '</div>';
    body.innerHTML = html;
  }

  const modeSegHtml = (items, cls, id) => '<div class="seg modeSeg ' + (cls || '') + '"' + (id ? ' id="' + id + '"' : '') + '>' + items.map((m) => '<button type="button" data-act="mode" data-mode="' + m[0] + '" class="' + (ui.mode === m[0] ? 'on' : '') + '">' + m[1] + '</button>').join('') + '</div>';

  /* 書く場所＝表示する場所のエディタ（js/editor.js）。使えない環境・「従来の分割表示」を選んだときは、従来の textarea ＋ プレビュー */
  let edv = null;
  const EDITOR_HINT = 'ここに講義メモを書きます。\n\n==大事な語== ・ {{穴埋めにしたい語}} ・ 用語 :: 説明 ・ Q: 問い / A: 答え\n（ツールバーのボタン、または右上の「書き方ガイド」を参照）';
  const useLive = () => { if (!(LN.editor && LN.editor.available)) return false; try { return window.localStorage.getItem('ln.editor') !== 'classic'; } catch (e) { return true; } };
  function destroyEditor() { if (edv) { try { edv.destroy(); } catch (e) { /* 無視 */ } edv = null; } }

  function renderEditor() {
    destroyEditor();
    const col = $('#editorCol');
    if (!col) return;
    const n = curNote();
    if (!n) { col.innerHTML = '<div class="center-msg">ノートを選ぶか、<br>「新しいノート」を作成してください。</div>'; return; }
    const live = useLive();
    if (live && ui.mode === 'split') ui.mode = 'edit'; // その場で見た目が変わるエディタでは、「分割」はなくなる（書く場所＝表示する場所）
    if (LN.theme && LN.theme.isPhone() && ui.mode === 'split') ui.mode = 'edit'; // スマホ用は、編集と表示を切り替える方式
    const units = unitsOf(n.subjectId);
    const unitOpts = '<option value="">未分類</option>' + units.map((u) => '<option value="' + u.id + '"' + (u.id === n.unitId ? ' selected' : '') + '>' + esc(u.name) + '</option>').join('') + '<option value="__new">＋ 新しい単元を作る…</option>';
    col.innerHTML =
      '<div class="ed-head"><div class="m-bar"><button type="button" class="m-back" data-act="m-back">‹ 一覧</button><span class="grow"></span>' + modeSegHtml([['edit', '編集'], ['view', '表示']], 'm-seg') + '</div><input class="title-input" id="fTitle" type="text" placeholder="タイトル（例：第3回 光合成のしくみ）" value="' + esc(n.title) + '" autocomplete="off">' +
      '<div class="ed-meta"><label class="fld">日付<input type="date" id="fDate" value="' + esc(n.date || '') + '"></label>' +
      '<label class="fld">単元<select id="fUnit">' + unitOpts + '</select></label>' +
      '<span class="fld">重要度<span class="starbtn" id="fStars">' + [1, 2, 3].map((i) => '<button data-act="star" data-n="' + i + '" class="' + (n.star >= i ? 'on' : '') + '" title="重要度 ' + i + '">★</button>').join('') + '</span></span>' +
      '<button class="toggle' + (n.review ? ' on' : '') + '" id="fReview" data-act="review-toggle" title="あとで見直したいノートに">要復習</button></div></div>' +
      '<div class="ed-toolbar">' +
      '<button class="tb" data-act="fmt" data-fmt="h" title="見出し（押すたびに ## → ### → なし）"><b>H</b>見出し</button>' +
      '<button class="tb" data-act="fmt" data-fmt="bold" title="太字 (Ctrl+B)"><b>B</b></button>' +
      '<button class="tb hl" data-act="fmt" data-fmt="mark" title="重要マーク ==…== （Ctrl+E）— 考査対策の「重要ポイント」に集まります"><b>重要</b><span class="k">Ctrl+E</span></button>' +
      '<button class="tb" data-act="fmt" data-fmt="cloze" title="穴埋め {{…}} — 穴埋めプリントの空欄になります">［　］穴埋め</button>' +
      '<span class="tb-sep"></span>' +
      '<button class="tb" data-act="fmt" data-fmt="ul" title="箇条書き">・箇条書き</button>' +
      '<button class="tb" data-act="fmt" data-fmt="term" title="用語 :: 説明 — 用語集・用語テストになります">用語</button>' +
      '<button class="tb" data-act="fmt" data-fmt="qa" title="Q: / A: — 一問一答プリントになります">Q&amp;A</button>' +
      '<button class="tb" data-act="fmt" data-fmt="table" title="表">表</button>' +
      '<button class="tb" data-act="fmt" data-fmt="math" title="数式 $…$">数式</button>' +
      '<button class="tb" data-act="fmt" data-fmt="img" title="画像（Ctrl+V で貼り付けも可）">' + ICON.image + '画像</button>' +
      (aiOn() ? '<span class="tb-sep"></span><button class="tb ai" data-act="ai-diagram" title="AI が図解を作って、ここに挿入します">' + ICON.chart + '図解 <span class="k">AI</span></button>' +
        '<button class="tb ai" data-act="ai-materials-note" title="スライド・PDF・動画などの教材から、AI がノートを作ります">' + ICON.file + '教材から <span class="k">AI</span></button>' : '') +
      '<span class="tb-spacer"></span>' +
      '<button class="tb' + (ui.study ? ' hl' : '') + '" id="studyBtn" data-act="study" title="穴埋めと答えを隠して確認できます"><b>暗記モード</b></button>' +
      '<span class="tb-sep"></span>' +
      modeSegHtml(live ? [['edit', '編集'], ['view', '表示']] : [['edit', '編集'], ['split', '分割'], ['view', '表示']], '', 'modeSeg') + '</div>' +
      '<div class="study-hint" id="studyHint"' + (ui.study ? '' : ' hidden') + '>暗記モード：青い空欄と Q&amp;A の答えをクリックすると表示されます。</div>' +
      '<div class="ed-body m-' + ui.mode + (live ? ' live' : '') + '">' +
      (live ? '<div class="ln-ed" id="fBodyLive"></div>' : '<textarea id="fBody" spellcheck="false" placeholder="' + esc(EDITOR_HINT).replace(/\n/g, '&#10;') + '"></textarea>') +
      '<div class="preview md' + (ui.study ? ' study' : '') + '" id="preview"></div></div>' +
      '<div class="ed-foot"><span class="save-state" id="saveState">保存済み</span><span class="ed-stats" id="stats"></span><span class="grow"></span>' +
      '<button class="btn sm" data-act="note-print">' + ICON.print + '印刷</button><button class="btn sm ghost" data-act="note-del" style="color:var(--danger)">' + ICON.trash + '削除</button></div>';
    if (live) {
      edv = LN.editor.create({
        parent: $('#fBodyLive'), doc: n.body, placeholder: EDITOR_HINT,
        onChange(text) { const cur = curNote(); if (cur) { cur.body = text; touch(cur); scheduleStats(); } },
        onKeydown: onBodyKey, onImageFile: addImageFile,
      });
    } else $('#fBody').value = n.body;
    updatePreview();
    updateStats();
  }

  let pvTimer = null, stTimer = null;
  function schedulePreview() { clearTimeout(pvTimer); pvTimer = setTimeout(updatePreview, 90); }
  function scheduleStats() { clearTimeout(stTimer); stTimer = setTimeout(updateStats, 250); }
  function updatePreview() {
    const n = curNote(), pv = $('#preview');
    if (!n || !pv) return;
    if (edv && ui.mode === 'edit') return; // 編集中は、別の枠のプレビューを描かない（「表示」に切り替えたときに描く）
    pv.innerHTML = n.body.trim() ? md.render(n.body) : '<p class="placeholder">プレビューがここに表示されます。</p>';
    if (!edv) updateStats();
  }
  function updateStats() {
    const n = curNote(), el = $('#stats');
    if (!n || !el) return;
    const x = md.extract(n.body);
    el.innerHTML = '重要 <b>' + x.highlights.length + '</b> ・ 用語 <b>' + x.terms.length + '</b> ・ Q&amp;A <b>' + x.qas.length + '</b> ・ 穴埋め <b>' + x.cloze + '</b> ・ ' + n.body.length + '文字';
  }

  const touch = (n) => { n.updatedAt = Date.now(); LN.save(); };

  /* ---------- エディタの書式操作 ---------- */
  const taEl = () => edv || $('#fBody'); // 書く場所（その場表示のエディタ、または従来の textarea）。どちらも textarea と同じ使い方ができる
  function insertText(el, text, s, e) {
    if (el.insertAt) { el.insertAt(text, s, e); return; } // その場表示のエディタ
    el.focus(); el.setSelectionRange(s, e);
    if (!document.execCommand('insertText', false, text)) { el.setRangeText(text, s, e, 'end'); el.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function wrap(l, r, ph) {
    const el = taEl(), v = el.value, s = el.selectionStart, e = el.selectionEnd;
    if (s >= l.length && v.slice(s - l.length, s) === l && v.slice(e, e + r.length) === r) {
      insertText(el, v.slice(s, e), s - l.length, e + r.length);
      el.setSelectionRange(s - l.length, e - l.length);
      return;
    }
    const sel = v.slice(s, e) || ph;
    insertText(el, l + sel + r, s, e);
    el.setSelectionRange(s + l.length, s + l.length + sel.length);
  }
  function lineRange(el) {
    const v = el.value, s = el.selectionStart, e = el.selectionEnd;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e); if (le < 0) le = v.length;
    return [ls, le];
  }
  function prefixLines(prefix) {
    const el = taEl(), [ls, le] = lineRange(el);
    const lines = el.value.slice(ls, le).split('\n');
    const all = lines.every((l) => l.startsWith(prefix));
    const out = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
    insertText(el, out, ls, le);
    el.setSelectionRange(ls, ls + out.length);
  }
  function heading() {
    const el = taEl(), [ls, le] = lineRange(el), line = el.value.slice(ls, le);
    const m = /^(#{1,6})\s/.exec(line);
    const out = !m ? '## ' + line : m[1].length < 3 ? m[1] + '# ' + line.slice(m[0].length) : line.slice(m[0].length);
    insertText(el, out, ls, le);
    el.setSelectionRange(ls + out.length, ls + out.length);
  }
  function insertBlock(text, a, b) {
    const el = taEl(), v = el.value, [ls, le] = lineRange(el);
    const empty = !v.slice(ls, le).trim();
    const at = empty ? ls : le, pre = empty ? '' : '\n';
    insertText(el, pre + text, at, empty ? le : at);
    const base = at + pre.length;
    el.setSelectionRange(base + a, base + b);
  }
  function format(kind) {
    const el = taEl();
    if (!el) return;
    if (ui.mode === 'view') setMode(edv ? 'edit' : 'split');
    switch (kind) {
      case 'h': heading(); break;
      case 'bold': wrap('**', '**', '太字'); break;
      case 'mark': wrap('==', '==', '重要語'); break;
      case 'cloze': wrap('{{', '}}', '答え'); break;
      case 'ul': prefixLines('- '); break;
      case 'math': wrap('$', '$', 'x^2'); break;
      case 'term': {
        const s = el.selectionStart, e = el.selectionEnd, sel = el.value.slice(s, e);
        if (sel && !sel.includes('\n')) { insertText(el, sel + ' :: 説明', s, e); el.setSelectionRange(s + sel.length + 4, s + sel.length + 6); } else insertBlock('用語 :: 説明', 0, 2);
        break;
      }
      case 'qa': insertBlock('Q: \nA: ', 3, 3); break;
      case 'table': insertBlock('| 項目 | 内容 |\n|---|---|\n|  |  |\n|  |  |', 2, 4); break;
      case 'img': $('#fileImage').click(); break;
    }
  }

  async function addImageFile(file) {
    if (!file || !file.type.startsWith('image/') || !taEl()) return;
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    let data = url;
    if (file.size > 400 * 1024 || img.width > 1600) {
      const k = Math.min(1, 1600 / img.width), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      data = c.toDataURL('image/jpeg', 0.86);
    }
    const id = await LN.addImage(data);
    const el = taEl();
    insertText(el, '\n![](img:' + id + ')\n', el.selectionStart, el.selectionEnd);
    toast('画像を貼り付けました');
  }

  function setMode(m) {
    ui.mode = m;
    const b = $('.ed-body'); if (b) b.className = 'ed-body m-' + m + (edv ? ' live' : '');
    $$('.modeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.mode === m));
    if (m !== 'edit') updatePreview();
    if (edv && m === 'edit') { edv.view.requestMeasure(); edv.focus(); } // 「表示」から戻ったとき、書く場所の大きさを測り直して、続きから書ける
  }

  function onBodyKey(e) {
    const el = taEl();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey) {
      if (e.key === 'b') { e.preventDefault(); format('bold'); return; }
      if (e.key === 'e') { e.preventDefault(); format('mark'); return; }
      if (e.key === 'i') { e.preventDefault(); wrap('*', '*', '斜体'); return; }
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      const [ls, le] = lineRange(el);
      if (e.shiftKey) {
        const lines = el.value.slice(ls, le).split('\n').map((l) => l.replace(/^( {1,2}|\t)/, ''));
        insertText(el, lines.join('\n'), ls, le); el.setSelectionRange(ls, ls + lines.join('\n').length);
      } else if (el.selectionStart !== el.selectionEnd) prefixLines('  ');
      else insertText(el, '  ', el.selectionStart, el.selectionEnd);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      const s = el.selectionStart;
      if (s !== el.selectionEnd) return;
      const ls = el.value.lastIndexOf('\n', s - 1) + 1, line = el.value.slice(ls, s);
      const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (m) {
        e.preventDefault();
        if (!m[3].trim()) { insertText(el, '', ls, s); el.setSelectionRange(ls, ls); }
        else insertText(el, '\n' + m[1] + (/^\d/.test(m[2]) ? parseInt(m[2], 10) + 1 + m[2].slice(-1) : m[2]) + ' ', s, s);
        return;
      }
      const atEnd = el.value.slice(s, el.value.indexOf('\n', s) < 0 ? el.value.length : el.value.indexOf('\n', s)).trim() === '';
      if (/^\s*(?:Q|Ｑ|問)\s*[:：]\s*\S/i.test(line) && atEnd) { e.preventDefault(); insertText(el, '\nA: ', s, s); }
    }
  }

  /* ---------- 考査画面 ---------- */
  function renderExam() {
    const main = $('#main');
    if (!st().subjects.length) { main.innerHTML = welcomeHtml(); return; }
    const exam = curExam();
    if (!exam) {
      main.innerHTML = '<div class="welcome"><h1>考査を作成しましょう</h1><p>考査ごとに「範囲（単元）」を選ぶと、<br>単元まとめの整理と、プリントの作成ができます。</p>' +
        '<div class="row"><button class="btn primary" data-act="exam-new">' + ICON.plus + '考査を作成</button></div></div>';
      return;
    }
    main.innerHTML = '<section class="range-col" id="rangeCol"></section><section class="exam-col"><div class="tabs"><button type="button" class="m-back" data-act="m-back">‹ 範囲</button>' +
      '<button class="tab" data-act="exam-tab" data-tab="summary">単元まとめ</button><button class="tab" data-act="exam-tab" data-tab="print">プリント作成</button></div><div class="tab-body" id="tabBody"></div></section>';
    renderRange();
    renderTab();
  }

  const subjectKeys = (sid) => unitsOf(sid).map((u) => u.id).concat(st().notes.some((n) => n.subjectId === sid && !n.unitId) ? [sh.NONE + sid] : []);

  function renderRange() {
    const exam = curExam(), col = $('#rangeCol');
    if (!col) return;
    const keys = new Set(exam.keys);
    let body = '';
    for (const s of st().subjects.slice().sort(byOrder)) {
      const ks = subjectKeys(s.id);
      if (!ks.length) continue;
      const rows = unitsOf(s.id).map((u) => [u.id, u.name, st().notes.filter((n) => n.unitId === u.id).length]);
      if (ks.includes(sh.NONE + s.id)) rows.push([sh.NONE + s.id, '未分類', st().notes.filter((n) => n.subjectId === s.id && !n.unitId).length]);
      body += '<div class="r-subject"><label><input type="checkbox" data-sall="' + s.id + '"><span class="dot" style="background:' + s.color + '"></span>' + esc(s.name) + '</label>' +
        rows.map((r) => '<label class="r-unit"><input type="checkbox" data-key="' + r[0] + '"' + (keys.has(r[0]) ? ' checked' : '') + '><span class="nm">' + esc(r[1]) + '</span><span class="cnt">' + r[2] + '件</span></label>').join('') + '</div>';
    }
    col.innerHTML =
      '<div class="range-head"><div class="m-bar"><button type="button" class="m-back" data-act="m-back">‹ 考査</button><span class="grow"></span><button type="button" class="btn primary sm" data-act="m-next">まとめ・プリントへ ›</button></div><h2><span>' + esc(exam.name) + '</span><button class="icon-btn" data-act="exam-edit" title="名前・日付を編集">' + ICON.edit + '</button></h2>' +
      '<div class="meta">' + (exam.date ? fmtDate(exam.date) + ' ' + daysPill(exam) : '日付は未設定') + '</div></div>' +
      '<div class="range-body"><div class="range-tools"><b style="color:var(--text-2)">範囲（単元）</b><span class="grow"></span>' +
      '<button class="btn sm ghost" data-act="range-all">全選択</button><button class="btn sm ghost" data-act="range-none">全解除</button></div>' +
      (body || '<div class="empty-note">単元・ノートがまだありません。</div>') + '</div>' +
      '<div class="range-filter"><label for="fFilter">対象にするノート</label><select id="fFilter" data-opt="filter">' +
      [['all', 'すべてのノート'], ['star2', '重要度 ★★ 以上'], ['star3', '重要度 ★★★ のみ'], ['review', '「要復習」のみ']].map((o) => '<option value="' + o[0] + '"' + (sheetOpts().filter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>';
    $$('[data-sall]', col).forEach((cb) => {
      const ks = subjectKeys(cb.dataset.sall), c = ks.filter((k) => keys.has(k)).length;
      cb.checked = c > 0 && c === ks.length; cb.indeterminate = c > 0 && c < ks.length;
    });
  }

  function renderTab() {
    $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === ui.examTab));
    if (ui.examTab === 'summary') renderSummaryTab(); else renderPrintTab();
  }

  function setKeys(list, on) {
    const exam = curExam(), set = new Set(exam.keys);
    list.forEach((k) => (on ? set.add(k) : set.delete(k)));
    exam.keys = Array.from(set);
    LN.save();
    renderRange(); renderTab();
  }

  /* ----- 単元まとめタブ ----- */
  const unitPreviewHtml = (u) => {
    const manual = u.unit && u.unit.summary && u.unit.summary.trim();
    return manual ? md.render(u.unit.summary) : '<p class="placeholder" style="margin:0;color:var(--text-3)">まだ「まとめ」がありません。プリントには、ノートから自動で集めた内容が使われます。</p>';
  };

  function renderSummaryTab() {
    const exam = curExam(), body = $('#tabBody');
    const groups = sh.resolveRange(st(), exam.keys, sheetOpts().filter);
    const units = groups.flatMap((g) => g.units.map((u) => Object.assign({ subject: g.subject }, u)));
    if (!units.length) { body.innerHTML = '<div class="pad"><div class="center-msg">左の「範囲」で、まとめたい単元にチェックを入れてください。</div></div>'; return; }
    const tot = { notes: 0, hl: 0, terms: 0, qa: 0, cloze: 0 };
    const cards = units.map((u) => {
      const d = sh.unitData(u);
      tot.notes += u.notes.length; tot.hl += d.highlights.length; tot.terms += d.terms.length; tot.qa += d.qas.length; tot.cloze += d.cloze;
      const has = u.unit && u.unit.summary && u.unit.summary.trim();
      const open = ui.open[u.key];
      return '<div class="ucard' + (open ? ' open' : '') + '" data-key="' + u.key + '"><div class="ucard-head" data-act="ucard-toggle" data-key="' + u.key + '">' + ICON.chev +
        '<span class="dot" style="background:' + u.subject.color + '"></span><span class="sn">' + esc(u.subject.name) + '</span><span class="nm">' + esc(u.name) + '</span><span class="grow"></span>' +
        '<span class="chips"><span class="chip-s">ノート ' + u.notes.length + '</span><span class="chip-s">重要 ' + d.highlights.length + '</span><span class="chip-s">用語 ' + d.terms.length + '</span><span class="chip-s">Q&amp;A ' + d.qas.length + '</span><span class="chip-s">穴埋め ' + d.cloze + '</span>' +
        (has ? '<span class="chip-s ok">まとめ済み</span>' : '') + '</span></div>' +
        '<div class="ucard-body">' + (u.unit
          ? '<div class="ucard-tools"><span class="hint">自分の言葉でまとめを書きます。空のままなら、ノートの重要ポイントと用語が自動でプリントに載ります。</span>' +
            '<button class="btn sm" data-act="draft" data-key="' + u.key + '">ノートから下書きを作る</button>' +
            (aiOn() ? '<button class="btn sm ai" data-act="ai-materials" data-key="' + u.key + '">' + ICON.file + '教材から作る</button><button class="btn sm ai" data-act="ai-diagram-unit" data-key="' + u.key + '">' + ICON.chart + '図解を作る</button>' : '') +
            '<button class="btn sm ghost" data-act="goto-notes" data-key="' + u.key + '">ノートを開く</button></div>' +
            '<div class="usplit"><textarea data-usum="' + u.unit.id + '" spellcheck="false" placeholder="## 重要ポイント&#10;- ...&#10;&#10;## 用語&#10;- 用語 :: 説明"></textarea><div class="preview md" data-uprev="' + u.unit.id + '">' + unitPreviewHtml(u) + '</div></div>'
          : '<div class="ucard-tools"><span class="hint">単元に入っていないノートです。単元に入れると、まとめを書けるようになります。</span><button class="btn sm ghost" data-act="goto-notes" data-key="' + u.key + '">ノートを開く</button></div>') + '</div></div>';
    });
    const withUnit = units.filter((u) => u.unit), done = withUnit.filter((u) => u.unit.summary && u.unit.summary.trim()).length;
    body.innerHTML = '<div class="pad">' +
      '<div class="stat-row"><div class="stat"><b>' + units.length + '</b><span>単元</span></div><div class="stat"><b>' + tot.notes + '</b><span>ノート</span></div><div class="stat"><b>' + tot.hl + '</b><span>重要ポイント</span></div>' +
      '<div class="stat"><b>' + tot.terms + '</b><span>用語</span></div><div class="stat"><b>' + tot.qa + '</b><span>Q&amp;A</span></div><div class="stat"><b>' + tot.cloze + '</b><span>穴埋め</span></div></div>' +
      '<div class="progress"><div class="txt"><span id="progTxt">まとめ作成 ' + done + ' / ' + withUnit.length + ' 単元</span><button class="btn sm" data-act="draft-all">' + '空のまとめに下書きを一括作成</button></div><div class="bar"><i id="progBar" style="width:' + (withUnit.length ? Math.round(done / withUnit.length * 100) : 0) + '%"></i></div></div>' +
      cards.join('') + '</div>';
    $$('[data-usum]').forEach((t) => { const u = st().units.find((x) => x.id === t.dataset.usum); t.value = u.summary || ''; });
  }

  function updateProgress() {
    const exam = curExam(), groups = sh.resolveRange(st(), exam.keys, sheetOpts().filter);
    const wu = groups.flatMap((g) => g.units).filter((u) => u.unit), done = wu.filter((u) => u.unit.summary && u.unit.summary.trim()).length;
    const t = $('#progTxt'), b = $('#progBar');
    if (t) t.textContent = 'まとめ作成 ' + done + ' / ' + wu.length + ' 単元';
    if (b) b.style.width = (wu.length ? Math.round(done / wu.length * 100) : 0) + '%';
  }

  function unitFromKey(key) {
    const exam = curExam();
    return sh.resolveRange(st(), exam.keys, sheetOpts().filter).flatMap((g) => g.units).find((u) => u.key === key);
  }

  /* ----- プリント作成タブ ----- */
  const seg = (opt, items, cur) => '<div class="seg full">' + items.map((i) => '<button data-act="opt" data-opt="' + opt + '" data-val="' + i[0] + '" class="' + (String(cur) === String(i[0]) ? 'on' : '') + '">' + i[1] + '</button>').join('') + '</div>';
  const chk = (opt, label, cur) => '<label class="check"><input type="checkbox" data-opt="' + opt + '"' + (cur ? ' checked' : '') + '> ' + label + '</label>';

  function renderPrintTab() {
    const exam = curExam(), body = $('#tabBody'), o = sheetOpts();
    const keep = { a: ($('.opt-col') || {}).scrollTop || 0, b: ($('#pvScroll') || {}).scrollTop || 0 };
    const T = [['summary', 'まとめ', '単元ごとの要点'], ['cloze', '穴埋め問題', '{{ }} が空欄に'], ['qa', '一問一答', 'Q: / A:'], ['terms', '用語テスト', '用語 :: 説明']];
    const hasCustom = aiOn() || (st().aiSheets || []).length > 0;
    if (hasCustom) T.push(['custom', 'AIおまかせ', 'ほしいプリントを文章で依頼']);
    else if (o.type === 'custom') o.type = 'summary';
    const ans = seg('answerMode', [['blank', '問題のみ'], ['key', o.type === 'custom' ? '別ページに解答' : '巻末に解答'], ['filled', o.type === 'custom' ? '解答つき' : '答えも表示']], o.answerMode);
    let typeOpts = '';
    if (o.type === 'custom') {
      typeOpts = '<div id="aiCustom"></div><div class="opt-group"><div class="lbl">解答の出し方</div>' + ans + '</div>';
    } else if (o.type === 'summary') {
      typeOpts = '<div class="opt-group"><div class="lbl">載せる内容</div><div class="stack">' + chk('includeSummary', '単元まとめ（自作、なければ自動）', o.includeSummary) +
        chk('includeNotes', 'ノート全文', o.includeNotes) + chk('appendGlossary', '巻末に用語集（五十音順）', o.appendGlossary) + '</div></div>';
    } else if (o.type === 'cloze') {
      typeOpts = '<div class="opt-group"><div class="lbl">解答</div>' + ans + '</div><div class="opt-group"><div class="lbl">出題</div><div class="stack">' + chk('clozeExcerpt', '穴埋めのある段落だけ抜粋', o.clozeExcerpt) + '</div></div>';
    } else if (o.type === 'qa') {
      typeOpts = '<div class="opt-group"><div class="lbl">解答</div>' + ans + '</div><div class="opt-group"><div class="lbl">出題</div><div class="stack">' + chk('shuffle', '単元内で順番をシャッフル', o.shuffle) +
        (o.shuffle ? '<button class="btn sm" data-act="reshuffle">並べ替え直す</button>' : '') + '</div></div>';
    } else {
      typeOpts = '<div class="opt-group"><div class="lbl">出題形式</div>' + seg('termMode', [['hide-def', '説明を書く'], ['hide-term', '用語を書く']], o.termMode) + '</div>' +
        '<div class="opt-group"><div class="lbl">解答</div>' + ans + '</div><div class="opt-group"><div class="lbl">出題</div><div class="stack">' + chk('shuffle', '単元内で順番をシャッフル', o.shuffle) +
        (o.shuffle ? '<button class="btn sm" data-act="reshuffle">並べ替え直す</button>' : '') + '</div></div>';
    }
    body.innerHTML = '<div class="print-wrap"><div class="opt-col">' +
      '<div class="opt-group"><div class="lbl">プリントの種類</div><div class="type-grid">' + T.map((t) => '<button class="type-btn' + (o.type === t[0] ? ' on' : '') + '" data-act="opt" data-opt="type" data-val="' + t[0] + '">' + t[1] + '<small>' + t[2] + '</small></button>').join('') + '</div></div>' +
      (o.type === 'custom' ? '' : '<div class="opt-group"><div class="lbl">タイトル</div><input type="text" data-opt="title" placeholder="' + esc(sh.defaultTitle(o, exam.name)) + '" value="' + esc(o.title) + '"></div>') +
      typeOpts +
      '<div class="opt-group"><div class="lbl">レイアウト</div><div class="stack">' +
      '<div><div class="field-l">文字の大きさ</div>' + seg('fontSize', [['s', '小'], ['m', '中'], ['l', '大']], o.fontSize) + '</div>' +
      '<div><div class="field-l">段組み</div>' + seg('cols', [[1, '1段'], [2, '2段']], o.cols) + '</div>' +
      '<div class="row2"><div><div class="field-l">用紙</div><select data-opt="paper">' + ['A4', 'B5', 'A5'].map((p) => '<option' + (o.paper === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select></div>' +
      '<div><div class="field-l">改ページ</div><select data-opt="pageBreak">' + [['none', 'なし'], ['subject', '教科ごと'], ['unit', '単元ごと']].map((p) => '<option value="' + p[0] + '"' + (o.pageBreak === p[0] ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select></div></div>' +
      (o.type !== 'summary' ? chk('showName', '名前・日付・点数の欄', o.showName) : '') + '</div></div>' +
      '<div class="opt-group"><button class="btn primary block" data-act="sheet-print">' + ICON.print + '印刷 / PDFに保存</button>' +
      (desktopOn() ? '<button class="btn block" style="margin-top:6px" data-act="sheet-pdf">' + ICON.backup + 'PDFファイルに保存</button>' : '') +
      '<p class="opt-note" style="margin-top:8px">' + (desktopOn() ? '「PDFファイルに保存」は、そのままPDFを作ります。' : '印刷ダイアログの送信先で「PDFに保存」を選ぶとPDFになります。') + 'ページの区切りは印刷プレビューで確認できます。</p></div>' +
      '</div><div class="preview-col"><div class="pv-bar"><span class="grow" id="pvInfo"></span><span class="field-l" style="margin:0">表示</span><div class="seg" id="zoomSeg">' +
      [[0.5, '50%'], [0.72, '75%'], [1, '100%']].map((z) => '<button data-act="zoom" data-z="' + z[0] + '" class="' + (ui.zoom === z[0] ? 'on' : '') + '">' + z[1] + '</button>').join('') + '</div></div><div class="pv-scroll" id="pvScroll"></div></div></div>';
    if (o.type === 'custom' && LN.ai) LN.ai.mountCustomPanel($('#aiCustom'));
    refreshSheet();
    const oc = $('.opt-col'); if (oc) oc.scrollTop = keep.a;
    const pv = $('#pvScroll'); if (pv) pv.scrollTop = keep.b;
  }

  const UNIT_LABEL = { summary: '単元', cloze: '個の空欄', qa: '問', terms: '語', custom: '' };
  /** スマホ用：プリントの用紙が、画面の幅に収まる大きさで見えるようにする（パソコン用では何もしない） */
  function fitPaperToScreen(pv) {
    if (!pv || !(LN.theme && LN.theme.isPhone())) return;
    const z = $('.paper-zoomer', pv), p = $('.paper', pv);
    if (!z || !p) return;
    z.style.zoom = 1;
    z.style.zoom = Math.min(ui.zoom, Math.max(0.2, (pv.clientWidth - 24) / p.offsetWidth));
  }

  function currentSheet() {
    const exam = curExam();
    return sh.build(st(), Object.assign({}, sheetOpts(), { keys: exam.keys }), exam.name);
  }
  function refreshSheet() {
    const pv = $('#pvScroll');
    if (!pv) return;
    const o = sheetOpts(), r = currentSheet();
    pv.innerHTML = '<div class="paper-zoomer" style="zoom:' + ui.zoom + '"><div class="paper" data-paper="' + o.paper + '">' + r.html + '</div></div>';
    fitPaperToScreen(pv);
    $('#pvInfo').textContent = r.count && UNIT_LABEL[o.type] ? r.count + ' ' + UNIT_LABEL[o.type] : '';
  }

  function doPrint(html, paper) {
    $('#print-root').innerHTML = html;
    $('#page-style').textContent = '@page { size: ' + (paper || 'A4') + '; margin: 14mm; }';
    window.print();
  }

  function setOpt(k, v) {
    sheetOpts()[k] = v;
    LN.save();
    if (k === 'filter') { renderTab(); return; }
    if (ui.examTab === 'print') renderPrintTab();
  }

  /* ---------- アクション ---------- */
  const A = {
    nav(el) { ui.view = el.dataset.view; mgo('root'); persistUi(); render(); },
    help() { openHelp(); },
    backup() { openBackup(); },
    'backup-export'() { LN.exportBackup(); const d = $('#dlg'); if (d.open) d.close(); toast('バックアップを保存しました'); renderSidebar(); },
    'backup-import'() { $('#fileImport').click(); },
    sample() { loadSample(); },

    async 'subject-add'() {
      const r = await ask({ title: '教科を追加', fields: [{ name: 'name', label: '教科名', placeholder: '例：生物学', required: true }, { name: 'color', label: '色', type: 'color', value: COLORS[st().subjects.length % COLORS.length] }], ok: '追加' });
      if (!r) return;
      const s = { id: LN.uid(), name: r.name, color: r.color, order: Math.max(0, ...st().subjects.map((x) => x.order || 0)) + 1 };
      st().subjects.push(s);
      ui.view = 'notes'; ui.subjectId = s.id; ui.noteId = null; ui.search = '';
      mgo('mid'); persistUi(); render();
    },
    'subject-select'(el) { ui.subjectId = el.dataset.id; ui.noteId = null; ui.search = ''; mgo('mid'); persistUi(); render(); },
    async 'subject-edit'(el) {
      const s = subj(el.dataset.id);
      const r = await ask({ title: '教科を編集', fields: [{ name: 'name', label: '教科名', value: s.name, required: true }, { name: 'color', label: '色', type: 'color', value: s.color }], ok: '保存', extra: 'この教科を削除' });
      if (!r) return;
      if (r.__extra) {
        const cnt = st().notes.filter((n) => n.subjectId === s.id).length;
        if (!(await ask({ title: '教科を削除', message: '「' + esc(s.name) + '」と、その単元・ノート（' + cnt + '件）をすべて削除します。<br>この操作は取り消せません。', ok: '削除する', danger: true }))) return;
        st().notes = st().notes.filter((n) => n.subjectId !== s.id);
        st().units = st().units.filter((u) => u.subjectId !== s.id);
        st().subjects = st().subjects.filter((x) => x.id !== s.id);
        pruneKeys(); persistUi(); render(); toast('教科を削除しました');
        return;
      }
      s.name = r.name; s.color = r.color; LN.save(); render();
    },

    async 'note-new'() {
      const sub = curSubject(), cur = curNote();
      const units = unitsOf(sub.id);
      const unitId = cur && cur.subjectId === sub.id ? cur.unitId : (units[units.length - 1] || {}).id || null;
      const n = { id: LN.uid(), subjectId: sub.id, unitId: unitId || null, title: '', date: LN.today(), body: '', star: 0, review: false, createdAt: Date.now(), updatedAt: Date.now() };
      st().notes.push(n);
      ui.noteId = n.id; ui.search = '';
      mgo('detail'); persistUi(); render();
      const t = $('#fTitle'); if (t) t.focus();
    },
    'note-select'(el) { ui.noteId = el.dataset.id; mgo('detail'); persistUi(); renderList(); renderEditor(); if (LN.mobile) LN.mobile.sync(); },
    async 'note-del'() {
      const n = curNote();
      if (!(await ask({ title: 'ノートを削除', message: '「' + esc(n.title || '無題のノート') + '」を削除します。この操作は取り消せません。', ok: '削除する', danger: true }))) return;
      st().notes = st().notes.filter((x) => x.id !== n.id);
      ui.noteId = null; mgo('mid'); persistUi(); render(); toast('ノートを削除しました');
    },
    'note-print'() { doPrint(sh.buildNote(st(), ui.noteId).html, 'A4'); },
    star(el) {
      const n = curNote(), i = +el.dataset.n;
      n.star = n.star === i ? i - 1 : i; touch(n);
      $$('#fStars button').forEach((b) => b.classList.toggle('on', n.star >= +b.dataset.n));
      renderList();
    },
    'review-toggle'(el) { const n = curNote(); n.review = !n.review; touch(n); el.classList.toggle('on', n.review); renderList(); },
    fmt(el) { format(el.dataset.fmt); },
    mode(el) { setMode(el.dataset.mode); },
    study() {
      ui.study = !ui.study;
      $('#studyBtn').classList.toggle('hl', ui.study);
      $('#preview').classList.toggle('study', ui.study);
      $('#studyHint').hidden = !ui.study;
      if (ui.study && ui.mode === 'edit') setMode(edv ? 'view' : 'split'); // 暗記モードは、読む画面（表示）で、空欄を隠す
    },

    async 'unit-add'() {
      const sub = curSubject();
      const r = await ask({ title: '単元を追加', message: '「' + esc(sub.name) + '」に単元（章・テーマなどのまとまり）を追加します。', fields: [{ name: 'name', label: '単元名', placeholder: '例：光合成', required: true }], ok: '追加' });
      if (!r) return;
      st().units.push({ id: LN.uid(), subjectId: sub.id, name: r.name, order: Math.max(0, ...unitsOf(sub.id).map((u) => u.order || 0)) + 1, summary: '' });
      LN.save(); renderList(); renderEditor();
    },
    'unit-toggle'(el) { ui.closed[el.dataset.id] = !ui.closed[el.dataset.id]; renderList(); },
    async 'unit-rename'(el) {
      const u = st().units.find((x) => x.id === el.dataset.id);
      const r = await ask({ title: '単元名を変更', fields: [{ name: 'name', label: '単元名', value: u.name, required: true }], ok: '保存' });
      if (!r) return;
      u.name = r.name; LN.save(); renderList(); renderEditor();
    },
    'unit-up'(el) { moveUnit(el.dataset.id, -1); },
    'unit-down'(el) { moveUnit(el.dataset.id, 1); },
    async 'unit-del'(el) {
      const u = st().units.find((x) => x.id === el.dataset.id);
      const cnt = st().notes.filter((n) => n.unitId === u.id).length;
      if (!(await ask({ title: '単元を削除', message: '単元「' + esc(u.name) + '」を削除します。<br>含まれる ' + cnt + ' 件のノートは消えず、「未分類」に移ります。' + (u.summary ? '<br>この単元の「まとめ」は削除されます。' : ''), ok: '削除する', danger: true }))) return;
      st().notes.forEach((n) => { if (n.unitId === u.id) n.unitId = null; });
      st().units = st().units.filter((x) => x.id !== u.id);
      pruneKeys(); LN.save(); renderList(); renderEditor();
    },

    async 'exam-new'() {
      const r = await ask({ title: '考査を作成', fields: [{ name: 'name', label: '考査名', placeholder: '例：前期中間考査', required: true }, { name: 'date', label: '日付（任意）', type: 'date' },
        { name: 'all', label: 'すべての単元を範囲に含める', type: 'checkbox', value: true }], ok: '作成' });
      if (!r) return;
      const keys = r.all ? st().subjects.flatMap((s) => subjectKeys(s.id)) : [];
      const e = { id: LN.uid(), name: r.name, date: r.date || '', keys };
      st().exams.push(e);
      ui.view = 'exam'; ui.examId = e.id; mgo('mid'); persistUi(); render();
    },
    'exam-select'(el) { ui.examId = el.dataset.id; mgo('mid'); persistUi(); render(); },
    async 'exam-edit'() {
      const e = curExam();
      const r = await ask({ title: '考査を編集', fields: [{ name: 'name', label: '考査名', value: e.name, required: true }, { name: 'date', label: '日付（任意）', type: 'date', value: e.date }], ok: '保存', extra: 'この考査を削除' });
      if (!r) return;
      if (r.__extra) {
        if (!(await ask({ title: '考査を削除', message: '考査「' + esc(e.name) + '」を削除します。ノートや単元まとめは消えません。', ok: '削除する', danger: true }))) return;
        st().exams = st().exams.filter((x) => x.id !== e.id);
        st().aiSheets = (st().aiSheets || []).filter((x) => x.examId !== e.id);
        ui.examId = null; mgo('root'); persistUi(); render();
        return;
      }
      e.name = r.name; e.date = r.date; LN.save(); renderSidebar(); renderRange(); if (ui.examTab === 'print') renderPrintTab();
    },
    'exam-tab'(el) { ui.examTab = el.dataset.tab; persistUi(); renderTab(); },
    'range-all'() { setKeys(st().subjects.flatMap((s) => subjectKeys(s.id)), true); },
    'range-none'() { setKeys(curExam().keys.slice(), false); },

    'ucard-toggle'(el) {
      const k = el.dataset.key; ui.open[k] = !ui.open[k];
      el.closest('.ucard').classList.toggle('open', ui.open[k]);
    },
    draft(el) {
      const u = unitFromKey(el.dataset.key);
      if (!u || !u.unit) return;
      const text = sh.draftSummary(u);
      if (!text) { toast('重要マーク（==…==）や用語（用語 :: 説明）が見つかりませんでした'); return; }
      (async () => {
        if (u.unit.summary.trim() && !(await ask({ title: '下書きを追加', message: 'いまの「まとめ」の末尾に、ノートから集めた下書きを追加します。', ok: '追加する' }))) return;
        u.unit.summary = u.unit.summary.trim() ? u.unit.summary.replace(/\s+$/, '') + '\n\n' + text : text;
        LN.save();
        const t = $('[data-usum="' + u.unit.id + '"]'); t.value = u.unit.summary;
        $('[data-uprev="' + u.unit.id + '"]').innerHTML = unitPreviewHtml(u);
        updateProgress(); toast('下書きを作成しました');
      })();
    },
    'draft-all'() {
      const exam = curExam();
      const units = sh.resolveRange(st(), exam.keys, sheetOpts().filter).flatMap((g) => g.units).filter((u) => u.unit && !u.unit.summary.trim());
      let n = 0;
      units.forEach((u) => { const t = sh.draftSummary(u); if (t) { u.unit.summary = t; n++; } });
      LN.save(); renderSummaryTab();
      toast(n ? n + ' 単元に下書きを作成しました' : '下書きを作れる単元がありませんでした');
    },
    'goto-notes'(el) {
      const u = unitFromKey(el.dataset.key);
      if (!u) return;
      const sid = u.unit ? u.unit.subjectId : el.dataset.key.slice(sh.NONE.length);
      ui.view = 'notes'; ui.subjectId = sid; ui.search = '';
      ui.noteId = u.notes.length ? u.notes[0].id : null;
      mgo(ui.noteId ? 'detail' : 'mid'); persistUi(); render();
    },

    opt(el) {
      const k = el.dataset.opt; let v = el.dataset.val;
      if (k === 'cols') v = Number(v);
      setOpt(k, v);
    },
    reshuffle() { sheetOpts().seed = (sheetOpts().seed || 1) + 1; LN.save(); refreshSheet(); },
    zoom(el) {
      ui.zoom = Number(el.dataset.z);
      $$('#zoomSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.z) === ui.zoom));
      const z = $('.paper-zoomer'); if (z) z.style.zoom = ui.zoom;
      fitPaperToScreen($('#pvScroll'));
    },
    'sheet-print'() { const r = currentSheet(); doPrint(r.html, sheetOpts().paper); },
  };

  function moveUnit(id, dir) {
    const sub = curSubject(), list = unitsOf(sub.id), i = list.findIndex((u) => u.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    list.forEach((u, k) => { u.order = k + 1; });
    const t = list[i].order; list[i].order = list[j].order; list[j].order = t;
    LN.save(); renderList();
  }

  /* ---------- ダイアログ（ガイド / バックアップ） ---------- */
  function openHelp() {
    const rows = [
      ['<code>==重要な語==</code>', '<mark>重要な語</mark>', '「重要ポイント」に自動で集まる'],
      ['<code>{{答え}}</code>', '答え（点線）', '穴埋めプリントの空欄 (1)(2)… に'],
      ['<code>用語 :: 説明</code>', '<b>用語</b>：説明', '用語集・用語テストに'],
      ['<code>Q: 問い\nA: 答え</code>', 'Q / A のカード', '一問一答プリントに'],
      ['<code>## 見出し</code>　<code>- 箇条書き</code>　<code>**太字**</code>', '通常の書式', 'ノート全文・まとめに'],
      ['<code>| 項目 | 内容 |\n|---|---|\n| A | B |</code>', '表', ''],
      ['<code>$x^2$</code>　<code>$\\frac{a}{b}$</code>　<code>$\\sqrt{x}$</code>　<code>$\\alpha$</code>　<code>$x_i$</code>', '数式（簡易表示）', '分数・累乗・添字・ギリシャ文字など'],
      ['画像を <code>Ctrl+V</code> で貼り付け', '画像', 'スクリーンショットもOK'],
    ];
    ask({
      title: '書き方ガイド', wide: true, ok: '閉じる', hideCancel: true,
      body: '<table class="help-tbl"><thead><tr><th>書き方</th><th>表示</th><th>考査対策での使われ方</th></tr></thead><tbody>' +
        rows.map((r) => '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('') + '</tbody></table>' +
        '<div class="help-sec"><b>使い方の流れ</b><br>① 教科を作り、必要なら単元を作る　② ノートを書く（上の印をつけるだけ）　③「考査対策」で考査を作り、範囲の単元にチェック　' +
        '④「単元まとめ」で下書き→自分の言葉に整える　⑤「プリント作成」で印刷 / PDF保存。</div>' +
        '<div class="help-sec"><b>書いたその場で、見た目になります</b><br>「==重要==」「{{穴埋め}}」「**太字**」「## 見出し」などは、書き終えた瞬間に、完成した見た目に変わります。<b>カーソルがある行・部分だけ、記号が見えます</b>（書き直しやすくするためです）。表・数式・図解は、カーソルを外すと完成した見た目になり、クリックすると書き直せます。</div>' +
        '<div class="help-sec"><b>入力のコツ</b><br>リスト行で Enter → 次の「- 」を自動入力（空の行で Enter → 終了）／ <code>Q:</code> の行で Enter → 次の行に <code>A:</code> を自動入力 ／ Ctrl+B 太字・Ctrl+E 重要マーク ／ Tab でインデント ／ 「暗記モード」で穴埋めと答えを隠して確認。</div>',
    });
  }

  /** バックアップの内容で、今のデータを置き換える。少ない内容への置き換えは強く警告し、
   *  デスクトップ版では置き換える前に「今の状態」を必ず一枚残す（誤って上書きしても、一つ前に戻せるように）。 */
  async function restoreFromBackup(jsonText, opts = {}) {
    let data;
    try { data = JSON.parse(jsonText); }
    catch (e) { toast('バックアップの読み込みに失敗しました'); return false; }
    if (data.app !== 'lecture-notes' || !data.state || !Array.isArray(data.state.notes)) { toast('このファイルは講義ノートのバックアップではありません'); return false; }

    const curSubs = st().subjects.length, curNotes = st().notes.length;
    const newSubs = (data.state.subjects || []).length, newNotes = data.state.notes.length;
    const smaller = (curSubs + curNotes) > 0 && (newSubs < curSubs || newNotes < curNotes);
    if (!opts.skipConfirm) {
      const message = (opts.message || 'このバックアップの内容で、今のデータを置き換えます。') +
        (smaller ? '<br><br><b style="color:var(--danger)">今のデータ（' + curSubs + '教科・' + curNotes + 'ノート）より少ない内容（' +
          newSubs + '教科・' + newNotes + 'ノート）です。今のデータは失われます。</b>' : '');
      if (!(await ask({ title: opts.title || 'バックアップを読み込む', message, ok: '読み込む', danger: true }))) return false;
    }

    if (desktopOn()) { try { await LN.desktop.snapshotNow(); } catch (e) { /* 失敗しても復元は続ける */ } }
    try {
      await LN.importBackup(new Blob([jsonText]));
      afterLoad(); ui.noteId = null; ui.examId = null; persistUi(); render();
      toast('バックアップを読み込みました');
      return true;
    } catch (err) { toast('読み込みに失敗しました：' + err.message); return false; }
  }

  function openBackup() {
    const last = st().settings.lastBackup;
    ask({
      title: 'バックアップ', ok: '閉じる', hideCancel: true,
      body: '<div class="bk-box' + (needsBackup() ? ' warn' : '') + '">ノートは、このブラウザの中に保存されています。ブラウザの閲覧データ（サイトデータ）を消去すると失われるため、定期的にファイルへバックアップしてください。<br>最終バックアップ：<b>' +
        (last ? new Date(last).toLocaleString('ja-JP') : 'まだありません') + '</b></div>' +
        (desktopOn() ? LN.desktop.backupNote() : '') +
        '<div style="display:flex;gap:8px"><button type="button" class="btn primary" data-act="backup-export">' + ICON.backup + 'ファイルに書き出す</button><button type="button" class="btn" data-act="backup-import">ファイルから読み込む</button></div>' +
        '<div class="help-sec">読み込むと、いまのデータはバックアップの内容に置き換わります。</div>',
    });
  }

  /* ---------- サンプルデータ ---------- */
  function loadSample() {
    const s = st(), now = Date.now(), daysAgo = (n) => LN.dateStr(new Date(now - n * 86400000));
    const sid = (name, color, order) => { const x = { id: LN.uid(), name, color, order }; s.subjects.push(x); return x.id; };
    const uid2 = (subjectId, name, order) => { const x = { id: LN.uid(), subjectId, name, order, summary: '' }; s.units.push(x); return x.id; };
    const note = (subjectId, unitId, title, date, star, review, body) => s.notes.push({ id: LN.uid(), subjectId, unitId, title, date, body, star, review, createdAt: now + s.notes.length, updatedAt: now + s.notes.length });
    const bio = sid('生物学', COLORS[3], 1), eco = sid('経済学入門', COLORS[5], 2);
    const u1 = uid2(bio, '細胞のつくり', 1), u2 = uid2(bio, '光合成', 2), u3 = uid2(eco, '需要と供給', 1);
    note(bio, u1, '第1回 細胞の構造', daysAgo(21), 2, false,
      '# 第1回 細胞の構造\n\n## 細胞の基本\nすべての生物は ==細胞== からできている。細胞は大きく {{原核細胞}} と {{真核細胞}} に分けられる。\n\n| 種類 | 核 | 例 |\n|---|---|---|\n| 原核細胞 | なし | 大腸菌・シアノバクテリア |\n| 真核細胞 | あり | 動物・植物・菌類 |\n\n## おもな細胞小器官\n核 :: 遺伝情報（DNA）を保持する。二重の核膜で囲まれる\nミトコンドリア :: 呼吸によって ==ATP== を合成する細胞小器官\nリボソーム :: タンパク質を合成する。{{rRNA}} とタンパク質でできている\n\nQ: 動物細胞にはなく、植物細胞にある構造を3つ答えよ\nA: 細胞壁・葉緑体・大きな液胞\n\n> 先生：原核と真核の違いは必ず出る');
    note(bio, u2, '第2回 光合成のしくみ', daysAgo(14), 3, true,
      '# 第2回 光合成のしくみ\n\n==光合成== は、光エネルギーを使って二酸化炭素と水から有機物を合成する反応。\n場所は葉緑体で、明反応は {{チラコイド膜}}、カルビン回路は {{ストロマ}} で起こる。\n\n## 反応の全体像\n6CO₂ + 12H₂O → C₆H₁₂O₆ + 6O₂ + 6H₂O\n\n## 2つの段階\n| 段階 | 場所 | 主な内容 |\n|---|---|---|\n| 明反応 | チラコイド膜 | 光で ATP と NADPH を作り、水を分解して {{酸素}} を出す |\n| カルビン回路 | ストロマ | CO₂ を固定して糖を合成する |\n\nクロロフィル :: 光を吸収する緑色の色素。==赤色光と青色光== をよく吸収する\nカルビン回路 :: ATP と NADPH を使い、CO₂ から糖を作る反応系\n\nQ: 光合成で発生する酸素は、何の分解に由来するか\nA: 水\n\nQ: カルビン回路で CO₂ を固定する酵素は何か\nA: ルビスコ（RuBisCO）');
    note(eco, u3, '第1回 需要曲線と均衡', daysAgo(7), 2, true,
      '# 第1回 需要と供給\n\n## 需要曲線\n価格が上がると需要量は ==減る==（右下がり）。需要量を $Q_d$、価格を $P$ とすると\n$$ Q_d = a - bP $$\n\n## 均衡\n==均衡価格== は {{需要量}} と {{供給量}} が一致する価格。\n\n均衡価格 :: 需要量と供給量が等しくなる価格\n価格弾力性 :: 価格が 1% 変化したとき、需要量が何 % 変化するか。$e = -\\frac{\\Delta Q / Q}{\\Delta P / P}$\n\nQ: 価格弾力性が 1 より大きい財のことを何というか\nA: 弾力的な財（価格の変化に敏感）');
    s.exams.push({ id: LN.uid(), name: 'サンプル考査', date: LN.dateStr(new Date(now + 14 * 86400000)), keys: [u1, u2, u3] });
    ui.view = 'notes'; ui.subjectId = bio; ui.noteId = null;
    ensureSelection(); ui.examId = s.exams[0].id;
    persistUi(); render();
    toast('サンプルを読み込みました。不要になったら教科ごと削除できます');
  }

  /* ---------- イベント ---------- */
  document.addEventListener('click', (e) => {
    const pv = e.target.closest('#preview.study');
    if (pv) {
      const c = e.target.closest('.cloze, .qa-a');
      if (c) c.classList.toggle('revealed');
    }
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.act];
    if (fn) fn(el, e);
  });
  document.addEventListener('mousedown', (e) => { if (e.target.closest('.ed-toolbar .tb')) e.preventDefault(); });

  document.addEventListener('input', (e) => {
    const t = e.target, n = curNote();
    if (t.id === 'fTitle' && n) { n.title = t.value; touch(n); renderList(); }
    else if (t.id === 'fDate' && n) { n.date = t.value; touch(n); renderList(); }
    else if (t.id === 'fBody' && n) { n.body = t.value; touch(n); schedulePreview(); }
    else if (t.id === 'search') { ui.search = t.value; renderList(); }
    else if (t.dataset.usum) {
      const u = st().units.find((x) => x.id === t.dataset.usum);
      u.summary = t.value; LN.save();
      const card = t.closest('.ucard'), key = card.dataset.key, g = unitFromKey(key);
      $('[data-uprev="' + u.id + '"]', card).innerHTML = unitPreviewHtml(g || { unit: u });
      card.querySelector('.chips').innerHTML = card.querySelector('.chips').innerHTML.replace(/<span class="chip-s ok">.*?<\/span>/, '') + (u.summary.trim() ? '<span class="chip-s ok">まとめ済み</span>' : '');
      updateProgress();
    } else if (t.dataset.opt === 'title') { sheetOpts().title = t.value; LN.save(); refreshSheet(); }
  });

  document.addEventListener('change', async (e) => {
    const t = e.target, n = curNote();
    if (t.id === 'fUnit' && n) {
      if (t.value === '__new') {
        const r = await ask({ title: '単元を追加', fields: [{ name: 'name', label: '単元名', placeholder: '例：光合成', required: true }], ok: '追加して設定' });
        if (r) {
          const u = { id: LN.uid(), subjectId: n.subjectId, name: r.name, order: Math.max(0, ...unitsOf(n.subjectId).map((x) => x.order || 0)) + 1, summary: '' };
          st().units.push(u); n.unitId = u.id; touch(n);
        }
        renderList(); renderEditor();
        return;
      }
      n.unitId = t.value || null; touch(n); renderList();
    } else if (t.dataset.key !== undefined && t.type === 'checkbox') setKeys([t.dataset.key], t.checked);
    else if (t.dataset.sall) setKeys(subjectKeys(t.dataset.sall), t.checked);
    else if (t.dataset.opt && t.dataset.opt !== 'title') setOpt(t.dataset.opt, t.type === 'checkbox' ? t.checked : t.value);
    else if (t.id === 'fileImage') { const f = t.files[0]; t.value = ''; if (f) addImageFile(f); }
    else if (t.id === 'fileImport') {
      const f = t.files[0]; t.value = '';
      if (!f) return;
      const d = $('#dlg'); if (d.open) d.close();
      await restoreFromBackup(await f.text(), { title: 'バックアップを読み込む', message: '「' + esc(f.name) + '」を読み込みます。' });
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'fBody') onBodyKey(e);
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); LN.save(); LN.flush().then(() => toast('保存しました')); }
  });

  document.addEventListener('paste', (e) => {
    if (e.target.id !== 'fBody') return;
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); addImageFile(item.getAsFile()); }
  });
  document.addEventListener('dragover', (e) => { if (e.target.id === 'fBody') e.preventDefault(); });
  document.addEventListener('drop', (e) => {
    if (e.target.id !== 'fBody') return;
    const f = Array.from(e.dataTransfer.files).find((x) => x.type.startsWith('image/'));
    if (f) { e.preventDefault(); addImageFile(f); }
  });

  window.addEventListener('beforeprint', () => {
    const root = $('#print-root');
    if (root.innerHTML.trim()) return;
    if (ui.view === 'exam' && ui.examTab === 'print' && curExam()) root.innerHTML = currentSheet().html;
    else if (ui.view === 'notes' && curNote()) root.innerHTML = sh.buildNote(st(), ui.noteId).html;
  });
  window.addEventListener('afterprint', () => { $('#print-root').innerHTML = ''; });

  LN.onSaveState = (s, err) => {
    const el = $('#saveState');
    if (!el) return;
    el.classList.toggle('err', s === 'error');
    el.textContent = s === 'saving' ? '保存中…' : s === 'error' ? '保存に失敗しました（バックアップを書き出してください）' : '保存済み';
  };

  function afterLoad() {
    const s = st();
    s.settings.sheet = Object.assign(sh.defaultOpts(), s.settings.sheet);
    delete s.settings.sheet.keys;
    const u = s.settings.ui || {};
    ui.view = u.view || 'notes'; ui.subjectId = u.subjectId || null; ui.noteId = u.noteId || null; ui.examId = u.examId || null; ui.examTab = u.examTab || 'summary';
  }

  // AI・デスクトップ機能（ai.js / desktop.js）から使う内部 API
  LN.ui = {
    $, $$, esc, ask, toast, ICON, st, ui, actions: A, render, renderSidebar, renderList, renderEditor, renderTab, renderPrintTab, refreshSheet, currentSheet,
    curNote, curExam, curSubject, unitFromKey, unitPreviewHtml, persistUi, sheetOpts, taEl, insertText, doPrint, updatePreview, updateProgress, renderSummaryTab, unitsOf, sortNotes,
    restoreFromBackup, needsBackup,
    /** ドライブからの取り込みなど、データが外から入れ替わったあとの再描画（今の選択はできるだけ保つ） */
    reload: () => { ensureSelection(); render(); },
  };

  (async function init() {
    try { await LN.load(); }
    catch (err) { toast('この環境ではデータを保存できません：' + err.message); }
    afterLoad();
    LN.requestPersist(); // 待たない（結果は LN.persisted に入る）
    if (LN.desktop) LN.desktop.init(LN.ui);
    if (LN.feedback) LN.feedback.init(LN.ui);
    if (LN.ai) LN.ai.init(LN.ui);
    if (LN.cloud) LN.cloud.init(LN.ui);
    if (LN.display) LN.display.init(LN.ui);
    if (LN.mobile) LN.mobile.init(LN.ui);
    if (LN.theme) LN.theme.onLayoutChange = () => render(); // パソコン用⇔スマホ用が切り替わったら、描き直す
    render();
    if (LN.cloud) LN.cloud.start(); // 初回のごあいさつ・再接続など（画面を描いたあとで行う）
  })();
})();
