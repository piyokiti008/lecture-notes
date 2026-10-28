/* 棚の画面（shelf.html）：段階1＝アカウント・ログイン・棚の一覧・棚を作る・招待コードで参加・棚の入口。段階2＝フォルダ（作る・名前を変える・消す・たどる）。
 * 段階3＝投稿の一覧と、投稿を開く画面（Google のプレビュー・ダウンロード）・投稿の削除（目次から）。投稿そのものは index.html（js/shelf/post.js）で行う。
 *  - 画面は、URL の # 以降で切り替える（#/ ホーム・#/signup・#/new・#/join/コード・#/s/棚のID・#/s/棚のID/f/フォルダのID・…/p/投稿のID）。
 *  - 利用者が決めた文字（表示名・棚の名前・ルール・フォルダの名前）は信用できないので、画面には必ず textContent で入れる（HTML として解釈しない）。
 *  - 画面の中に、インラインのスクリプトや style 属性は置かない（CSP で禁止している）。window.confirm / prompt は使わない（LINE の中のブラウザで出ないことがあるため。確認は画面の中に出す）。
 *  - LINE の中のブラウザを第一に考える：見る・管理はここで。投稿（段階3）は、ノートの本体がある Safari / Chrome で行う。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = LN.shelf, M = S.model, AU = S.auth, A = S.api, D = S.drive, V = S.view, N = S.notefmt, C = S.cols;
  const doc = root.document;
  const U = (S.ui = { cfg: { appUrl: 'index.html', appExternal: '?openExternalBrowser=1' } });  // appExternal：LINE の中のブラウザから、外の標準ブラウザで開かせる印（効くかは実機で確認）
  const app = doc.getElementById('app');
  const $ = (id) => doc.getElementById(id);

  let me = null;      // { uid, nick, shelfCount }（ログイン中の自分）
  let pending = '';   // ログインのあとで開く場所（#/…）
  let view = 0;       // 画面の入れ替え番号（遅れて返った通信で、古い画面を描かないため）
  let sortMode = 'new';
  const nav = () => ++view;
  const TTL = 120000;                         // 棚の文書・自分のメンバー文書を、画面を開いている間だけ覚えておく時間
  const cache = { shelf: {}, folders: {} };   // folders[sid][fid] = { at, v }（フォルダの文書。列の画面は、ここまでの階層ぶん、フォルダの文書を読むので、覚えておく）
  const joinedNames = {};                     // 参加一覧にある棚の名前の写し（sid → 名前）。棚の名前が変わっていたら、棚を開いたときに直す
  let flash = '';                             // 次に開く画面（棚の一覧）に出す、短いお知らせ
  const FOLD_KEY = 'ln.shelf.fold.v1';
  const fold = { side: false };               // 左の棚の一覧をしまっているか（この端末に覚える）
  try { fold.side = JSON.parse(root.localStorage.getItem(FOLD_KEY) || '{}').side === true; } catch (e) { /* 覚えられなくても動く */ }
  const saveFold = () => { try { root.localStorage.setItem(FOLD_KEY, JSON.stringify(fold)); } catch (e) { /* この回だけ */ } };
  const pins = { open: [], closed: [] };      // 利用者が選んだ、列の「ひらく／しまう」（フォルダの ID。画面を開いている間だけ覚える）
  let shelves = null;                         // 参加中の棚の一覧 [{ sid, name, joined }]（左の一覧に出す）
  let pinAt = '';                             // 「ひらく／しまう」を選んだときの、いまのフォルダ（別のフォルダへ移ったら、選んだ状態は捨てる）
  let cur = null;                             // いま開いている画面（棚・フォルダ・投稿）のデータ。列だけの描き直しに使う
  const icon = C.icon;
  const phone = () => !!(LN.theme && LN.theme.isPhone && LN.theme.isPhone());

  /* ---------- 小さな道具 ---------- */
  function h(tag, props) {
    const el = doc.createElement(tag);
    Object.keys(props || {}).forEach((k) => {
      const v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    });
    Array.prototype.slice.call(arguments, 2).forEach(function add(c) {
      if (c == null || c === false) return;
      if (Array.isArray(c)) return c.forEach(add);
      el.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    });
    return el;
  }
  function say(el, msg, ok) { el.textContent = msg || ''; el.hidden = !msg; el.classList.toggle('ok', !!ok); }
  const msgBox = (id) => h('p', { id: id || 'shMsg', class: 'sh-msg', hidden: true, role: 'alert' });
  function fld(id, label, attrs, hint) {
    return h('div', { class: 'sh-field' }, h('label', { for: id, text: label }),
      h('input', Object.assign({ id, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' }, attrs)),
      hint ? h('p', { class: 'sh-hint', text: hint }) : null);
  }
  const note = (text, warn, id) => h('p', { id, class: 'sh-note' + (warn ? ' warn' : ''), text });
  const linkTo = (href, text, id) => h('a', { id, class: 'sh-link', href, text });
  function busy(btn, on, label) { btn.disabled = !!on; if (label) btn.textContent = label; }

  function go(hash) {
    if (root.location.hash === hash) route(); else root.location.hash = hash;
  }
  function head() {
    return h('header', { class: 'sh-head' },
      h('a', { class: 'sh-title', href: '#/', text: '講義ノート 棚' }),
      me ? h('div', { class: 'sh-me' }, h('span', { id: 'shMe', class: 'sh-menick', text: me.nick }),
        h('button', { id: 'shLogout', class: 'sh-btn sm', type: 'button', onclick: logout, text: 'ログアウト' })) : null);
  }
  function page() {
    app.textContent = ''; app.className = 'sh-app'; cur = null; closePop();
    app.appendChild(head());
    Array.prototype.slice.call(arguments).forEach(function add(n) { if (!n) return; if (Array.isArray(n)) return n.forEach(add); app.appendChild(n); });
    app.appendChild(h('p', { class: 'sh-foot' }, h('a', { id: 'shTermsLink', class: 'sh-link', href: 'terms.html', target: '_blank', rel: 'noopener', text: '利用規約・プライバシー' }),
      me ? ['　', h('a', { id: 'shAccountLink', class: 'sh-link', href: '#/account', text: 'アカウントを削除する' })] : null));
  }
  async function copy(text, btn) {
    let done = false;
    try { if (root.navigator.clipboard && root.navigator.clipboard.writeText) { await root.navigator.clipboard.writeText(text); done = true; } } catch (e) { /* 次の方法へ */ }
    if (!done) {
      const ta = h('textarea', { class: 'sh-off', 'aria-hidden': 'true', readonly: true }); ta.value = text; doc.body.appendChild(ta); ta.select();
      try { done = doc.execCommand('copy'); } catch (e) { done = false; }
      doc.body.removeChild(ta);
    }
    if (btn) { const old = btn.dataset.label || btn.textContent; btn.dataset.label = old; btn.textContent = done ? 'コピーしました' : 'コピーできませんでした（長押しでコピーしてください）'; setTimeout(() => { btn.textContent = old; }, 2200); }
  }
  /** ログインが切れていたら、ログイン画面に戻す。戻したら true */
  function expired(r) {
    if (r && !r.ok && r.code === 'login') { pending = root.location.hash; AU.signOut(); me = null; go('#/'); return true; }
    return false;
  }

  /* ---------- 起動・道筋 ---------- */
  async function route() {
    const r = M.parseRoute(root.location.hash);
    const t = nav();
    closeDlg(true);   // 開いていたダイアログは、画面が変わるので閉じる（new・join は、このあと開き直す）
    if (!AU.uid()) {
      if (r.name === 'signup') return showSignup();
      if (r.name === 'join' || r.name === 'shelf' || r.name === 'folder' || r.name === 'post' || r.name === 'admin') pending = root.location.hash;
      return showLogin(r);
    }
    if (!me) { await loadMe(); if (!me || t !== view) return; }
    if (r.name === 'new') { showList(t); return openNew(); }       // 棚を作る・参加は、ダイアログ（リンクで開いたときは、後ろに、棚の一覧）
    if (r.name === 'join') { showList(t); return openJoin(r); }
    if (r.name === 'shelf') return showShelf(r.sid, 'root', t);
    if (r.name === 'folder') return showShelf(r.sid, r.fid, t);
    if (r.name === 'post') return showShelf(r.sid, r.fid, t, false, r.pid);
    if (r.name === 'admin') return showAdmin(r.sid, t);
    if (r.name === 'account') return showAccount(t);
    return showList(t);
  }

  async function loadMe() {
    page(h('p', { class: 'sh-loading', text: '読み込んでいます…' }));
    const r = await A.getProfile(AU.uid());
    if (expired(r)) return;
    if (!r.ok) return showFatal(r.message, route);
    if (!r.exists) return showProfileSetup('');
    if (r.banned) { me = null; return showBanned(); }
    me = { uid: AU.uid(), nick: r.nick, shelfCount: r.shelfCount };
  }
  function showFatal(text, retry) {
    page(h('h1', { class: 'sh-h', text: '読み込めませんでした' }), h('p', { id: 'shMsg', class: 'sh-msg', role: 'alert', text }),
      h('button', { id: 'shRetry', class: 'sh-btn primary block', type: 'button', onclick: retry, text: 'もう一度試す' }));
  }
  function showBanned() {
    page(h('h1', { class: 'sh-h', text: 'このアカウントは、利用停止中です' }), note('不正な使い方があったため、運営が利用を止めています。心当たりがない場合は、アプリのフィードバックからお知らせください。'),
      h('button', { id: 'shLogout', class: 'sh-btn block', type: 'button', onclick: logout, text: 'ログアウト' }));
  }
  function logout() { AU.signOut(); me = null; pending = ''; cache.shelf = {}; cache.folders = {}; shelves = null; pins.open = []; pins.closed = []; go('#/'); }

  async function afterLogin() {
    me = null;
    await loadMe();
    if (!me) return;
    const to = pending || '#/'; pending = '';
    go(to);
  }

  /* ---------- ホーム（ログイン）・アカウント作成 ---------- */
  function appCard() {
    return h('div', { class: 'sh-card' }, h('h2', { text: '初めての方へ' }),
      h('p', { class: 'sh-sub', text: 'ノートを書く・棚に投稿するには、Google を使うため、Safari または Chrome で開いてください。' }),
      h('a', { id: 'shAppLink', class: 'sh-btn block', href: U.cfg.appUrl, target: '_blank', rel: 'noopener', text: '講義ノート（アプリ）を開く' }),
      h('p', { class: 'sh-sub' }, h('a', { id: 'shGuideLink', href: 'guide.html#shelf', target: '_blank', rel: 'noopener', text: '画像つきの使い方を見る' })));
  }
  function showLogin(r) {
    const msg = msgBox();
    const notice = flash; flash = '';
    const form = h('form', { id: 'shLoginForm', novalidate: true },
      fld('shLoginId', 'ログインID', { autocomplete: 'username' }),
      fld('shLoginPw', 'パスワード', { type: 'password', autocomplete: 'current-password' }),
      h('label', { class: 'sh-check' }, h('input', { id: 'shRemember', type: 'checkbox', checked: true }), h('span', { text: 'この端末でログインを保つ' })),
      msg,
      h('button', { id: 'shLoginGo', class: 'sh-btn primary block', type: 'submit', text: 'ログイン' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = M.checkLoginId($('shLoginId').value); if (!c.ok) return say(msg, c.error);
      const pw = $('shLoginPw').value; if (!pw) return say(msg, 'パスワードを入力してください。');
      const btn = $('shLoginGo'); busy(btn, true, 'ログインしています…'); say(msg, '');
      const res = await AU.signIn(c.id, pw, $('shRemember').checked);
      if (!res.ok) { busy(btn, false, 'ログイン'); return say(msg, res.error); }
      await afterLogin();
    });
    page(
      h('h1', { class: 'sh-h', text: 'ログイン' }),
      notice ? h('p', { id: 'shFlash', class: 'sh-note ok', text: notice }) : null,
      r && (r.name === 'join' || r.name === 'shelf' || r.name === 'folder' || r.name === 'post' || r.name === 'admin') ? note('招待を受けた棚を開くには、ログインするか、アカウントを作ってください。') : h('p', { class: 'sh-lead', text: '友達と、単元ごとにノートを整理して共有する場所です。' }),
      h('div', { class: 'sh-card' }, form),
      h('p', { class: 'sh-lead' }, 'はじめての方は ', linkTo('#/signup', 'アカウントを作る', 'shGoSignup')),
      appCard());
  }

  function showSignup() {
    const msg = msgBox();
    const form = h('form', { id: 'shSignupForm', novalidate: true },
      fld('shSuId', 'ログインID', { autocomplete: 'username' }, '半角の英数字・「_」・「-」の3〜20文字。あとから変えられません。'),
      fld('shSuNick', '表示名', { autocomplete: 'nickname' }, '棚で、ほかの人に見える名前です。本名でなくてかまいません。'),
      fld('shSuPw', 'パスワード', { type: 'password', autocomplete: 'new-password' }, '8文字以上。ほかのサービスと同じものは避けてください。'),
      note('パスワードを忘れると、復旧できません（メールを使わないため）。ノートはあなたのドライブにあるので消えません。失うのは、棚の投稿を直す権利です。', true),
      h('label', { class: 'sh-check' }, h('input', { id: 'shRemember', type: 'checkbox', checked: true }), h('span', { text: 'この端末でログインを保つ' })),
      h('p', { id: 'shSuTerms', class: 'sh-sub' }, 'アカウントを作ると、', h('a', { class: 'sh-link', href: 'terms.html', target: '_blank', rel: 'noopener', text: '利用規約・プライバシー' }), 'に同意したことになります。'),
      msg,
      h('button', { id: 'shSuGo', class: 'sh-btn primary block', type: 'submit', text: 'アカウントを作る' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const c = M.checkLoginId($('shSuId').value); if (!c.ok) return say(msg, c.error);
      const n = M.checkNick($('shSuNick').value); if (!n.ok) return say(msg, n.error);
      const p = M.checkPassword($('shSuPw').value, c.id); if (!p.ok) return say(msg, p.error);
      const btn = $('shSuGo'); busy(btn, true, '作っています…'); say(msg, '');
      const res = await AU.signUp(c.id, p.password, $('shRemember').checked);
      if (!res.ok) { busy(btn, false, 'アカウントを作る'); return say(msg, res.error); }
      const pr = await A.createProfile(res.uid, n.nick);
      if (!pr.ok) return showProfileSetup('アカウントはできましたが、表示名の登録に失敗しました：' + pr.message, n.nick);
      await afterLogin();
    });
    page(h('h1', { class: 'sh-h', text: 'アカウントを作る' }), h('div', { class: 'sh-card' }, form),
      h('p', { class: 'sh-lead' }, 'すでにアカウントがある方は ', linkTo('#/', 'ログイン', 'shGoLogin')));
  }

  /** アカウントはあるが、プロフィール（表示名）がない場合 */
  function showProfileSetup(error, nick) {
    const msg = msgBox(); if (error) say(msg, error);
    const form = h('form', { id: 'shProfileForm', novalidate: true },
      fld('shPfNick', '表示名', { value: nick || '' }, '棚で、ほかの人に見える名前です。'), msg,
      h('button', { id: 'shPfGo', class: 'sh-btn primary block', type: 'submit', text: '決める' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = M.checkNick($('shPfNick').value); if (!n.ok) return say(msg, n.error);
      busy($('shPfGo'), true, '登録しています…');
      const r = await A.createProfile(AU.uid(), n.nick);
      if (expired(r)) return;
      if (!r.ok && r.code !== 'exists') { busy($('shPfGo'), false, '決める'); return say(msg, r.message); }
      await afterLogin();
    });
    page(h('h1', { class: 'sh-h', text: '表示名を決めてください' }), h('div', { class: 'sh-card' }, form));
  }

  /* ---------- 画面の枠（左＝棚の一覧｜列｜右＝表示）。ログイン後の、棚を見る画面で使う ---------- */
  let shelvesErr = '';
  function shellFrame() {
    if (!(app.classList.contains('app') && $('sidebar') && $('main') && $('mNav'))) {
      closePop(); app.textContent = ''; app.className = 'app';
      app.appendChild(h('aside', { class: 'sidebar', id: 'sidebar' }));
      app.appendChild(h('main', { class: 'main', id: 'main' }));
      app.appendChild(h('nav', { id: 'mNav', class: 'm-nav', 'aria-label': '移動' },   // スマホだけに出る（phone.css）。ノートアプリの下の切り替えと同じ
        h('a', { class: 'on', href: '#/' }, icon('book'), h('span', { text: '棚' })),
        h('a', { id: 'shMNavApp', href: U.cfg.appUrl, target: '_blank', rel: 'noopener' }, icon('edit'), h('span', { text: 'ノート' })),
        h('button', { id: 'shMNavMenu', type: 'button', onclick: openMenu }, icon('menu'), h('span', { text: 'メニュー' }))));
    }
    app.classList.toggle('fold-side', fold.side && !phone());
  }
  async function loadShelves(fresh) {
    if (!fresh && shelves) return { ok: true };
    const r = await A.myShelves(me.uid);
    shelvesErr = r.ok ? '' : r.message || '読み込めませんでした。';
    if (r.ok) { shelves = r.shelves; r.shelves.forEach((s) => { joinedNames[s.sid] = s.name; }); }
    return r;
  }
  /** 棚の枠（左の一覧つき）の中に、管理者の画面・アカウントの画面を出す。o.sid＝左の一覧で選ぶ棚（なければ null）・o.name＝その棚の名前・o.back＝スマホの戻るバー { href, text }・o.crumbs＝パンくず [{ href, text }]（href なし＝いまの場所）・o.title / o.titleId＝見出し */
  function inShell(o, nodes) {
    cur = null; closePop();
    shellFrame(); app.dataset.mpane = 'detail';
    drawSidebar(o.sid || null, o.name);
    setMain(h('section', { class: 'editor-col sh-view' },
      h('div', { class: 'ed-head' },
        h('div', { class: 'm-bar' }, h('a', { class: 'm-back', href: o.back.href, text: '‹ ' + o.back.text })),
        o.crumbs && o.crumbs.length ? h('p', { class: 'sh-crumbs' }, o.crumbs.map((c, i) => [i ? ' › ' : null, c.href ? h('a', { class: 'sh-link sh-crumb-link', href: c.href, text: c.text }) : h('span', { class: 'sh-crumb-cur', text: c.text })])) : null,
        h('div', { class: 'hbar' }, h('h1', { id: o.titleId, text: o.title }))),
      h('div', { class: 'sh-viewbody' }, nodes)));
  }
  function setMain(nodes) { const m = $('main'); m.textContent = ''; [].concat(nodes).forEach((n) => { if (n) m.appendChild(n); }); }

  /** 左の棚の一覧。active＝いま開いている棚の ID（なければ null）、name＝その棚の、いまの名前 */
  function drawSidebar(active, name) {
    const sb = $('sidebar'); if (!sb) return;
    const toggleSide = () => { fold.side = !fold.side; saveFold(); app.classList.toggle('fold-side', fold.side && !phone()); paintCols(); };
    const items = (shelves || []).map((s) => {
      const nm = s.sid === active && name ? name : s.name;
      return h('li', { class: 'side-item' + (s.sid === active ? ' on' : '') },
        h('a', { class: 'side-link', href: '#/s/' + s.sid, 'data-sid': s.sid, title: nm }, h('span', { class: 'dot ' + C.colorClass(s.sid) }), h('span', { class: 'nm', text: nm })));
    });
    sb.textContent = '';
    sb.appendChild(h('div', { class: 'brand' }, h('span', { class: 'brand-logo' }, icon('book')), '講義ノート 棚', C.foldBtn(h, { open: true, title: 'しまう：棚の一覧', onclick: toggleSide })));
    sb.appendChild(h('nav', { class: 'nav' },
      h('a', { class: 'nav-btn on', href: '#/' }, icon('book'), '棚'),
      h('a', { id: 'shNavApp', class: 'nav-btn', href: U.cfg.appUrl, target: '_blank', rel: 'noopener' }, icon('edit'), 'ノートを開く')));
    sb.appendChild(h('div', { class: 'side-rail' }, C.foldBtn(h, { open: false, title: 'ひらく：棚の一覧', onclick: toggleSide }),
      h('a', { class: 'nav-btn on', href: '#/', title: '棚', 'aria-label': '棚' }, icon('book')),
      h('a', { class: 'nav-btn', href: U.cfg.appUrl, target: '_blank', rel: 'noopener', title: 'ノートを開く', 'aria-label': 'ノートを開く' }, icon('edit')),
      h('button', { class: 'nav-btn rail-menu', type: 'button', title: 'メニュー', 'aria-label': 'メニュー', onclick: openMenu }, icon('menu'))));
    sb.appendChild(h('div', { class: 'side-head' }, h('span', { text: '棚' }),
      h('button', { id: 'shSideNew', class: 'icon-btn', type: 'button', title: '棚を作る', 'aria-label': '棚を作る', onclick: openNew }, icon('plus'))));
    sb.appendChild(h('ul', { id: 'shShelves', class: 'side-list' }, items.length ? items
      : h('li', { id: shelves ? 'shEmpty' : 'shListState', class: 'empty-note', text: shelves ? 'まだ、参加している棚がありません。招待コードで参加するか、棚を作りましょう。' : (shelvesErr ? '棚の一覧を読み込めませんでした。' : '読み込んでいます…') })));
    sb.appendChild(h('div', { class: 'sh-listjoin' }, h('button', { id: 'shListJoin', class: 'btn block', type: 'button', onclick: () => openJoin({}) }, icon('plus'), '招待コードで参加')));   // スマホの棚の一覧に出す
    sb.appendChild(h('div', { class: 'side-foot' },
      h('button', { id: 'shFootMenu', class: 'btn ghost sh-foot-menu', type: 'button', title: 'メニュー', onclick: openMenu }, icon('menu'), 'メニュー'),   // 狭いパソコン画面だけに出す（ログアウトなどは、ここから）
      h('div', { class: 'sh-me' }, h('span', { id: 'shMe', class: 'sh-menick', text: me.nick }), h('button', { id: 'shLogout', class: 'btn sm', type: 'button', onclick: logout, text: 'ログアウト' })),
      h('button', { id: 'shSideJoin', class: 'btn ghost', type: 'button', onclick: () => openJoin({}) }, icon('plus'), '招待コードで参加'),
      h('p', { class: 'sh-foot-links' },
        h('a', { id: 'shTermsLink', href: 'terms.html', target: '_blank', rel: 'noopener', text: '利用規約・プライバシー' }),
        h('a', { id: 'shAccountLink', href: '#/account', text: 'アカウントを削除する' }),
        h('a', { class: 'm-only', href: U.cfg.appUrl, target: '_blank', rel: 'noopener', text: 'ノートを開く' }))));
  }

  /* ---------- ホーム（棚を選ぶ前）：左に棚の一覧、右に案内 ---------- */
  function welcomeEl(notice, error) {
    const step = (t, d) => h('div', { class: 'step' }, h('b', { text: t }), h('span', { text: d }));
    return h('section', { class: 'editor-col' }, h('div', { class: 'welcome' },
      notice ? h('p', { id: 'shFlash', class: 'sh-note ok', text: notice }) : null,
      h('h1', { text: '棚へようこそ' }),
      h('p', { text: '友達と、授業ごとにノートを整理して共有します。左の「棚」を選ぶと、フォルダが右に開きます。' }),
      error ? h('p', { id: 'shMsg', class: 'sh-msg', role: 'alert', text: error }) : null,
      h('div', { class: 'steps' }, step('1. 棚を選ぶ', '左の一覧から、開きたい棚を選びます。'), step('2. フォルダを開く', 'フォルダの中のフォルダも、右へ、開いていきます。'), step('3. 開く・投稿する', 'ファイルを開くと、ここに、そのままの見た目で出ます。')),
      note('見る・管理は、ここ（LINE の中でも）でできます。投稿は、Safari または Chrome で開いて行います。'),
      h('div', { class: 'row' },
        h('button', { id: 'shGoNew', class: 'btn primary', type: 'button', onclick: openNew }, icon('plus'), '棚を作る'),
        h('button', { id: 'shGoJoin', class: 'btn', type: 'button', onclick: () => openJoin({}), text: '招待コードで参加' })),
      h('p', { id: 'shLeft', class: 'sh-lead', text: '作れる棚は、あと ' + M.shelvesLeft(me.shelfCount) + ' つです（1人5つまで）。' }),
      h('p', { class: 'welcome-help' }, h('a', { id: 'shGuideLink', href: 'guide.html#shelf', target: '_blank', rel: 'noopener', text: '画像つきの使い方を見る' }))));
  }
  async function showList(t) {
    const notice = flash; flash = '';
    shellFrame(); app.dataset.mpane = 'root'; cur = null; closePop();
    drawSidebar(null); setMain(welcomeEl(notice, ''));
    const r = await loadShelves(true);
    if (t !== view || expired(r)) return;
    drawSidebar(null); setMain(welcomeEl(notice, r.ok ? '' : r.message));
  }

  /* ---------- ダイアログ（ノートアプリの「教科を追加」と同じ作り：css/app.css の dialog・.dlg-form・.dlg-field・.dlg-actions。スマホでは、下から出るシート） ---------- */
  const dlgState = { onClose: null };
  /** ダイアログを出す（開いていれば、中身を入れ替える）。o.id＝フォームの ID／o.onClose＝閉じたとき（×・Esc・閉じるボタンのどれでも）に1回だけ呼ぶ（入れ替えるとき、渡さなければ、そのまま） */
  function showDlg(title, nodes, o) {
    o = o || {};
    const d = $('dlg');
    d.className = ''; d.textContent = '';
    const form = h('form', { id: o.id, class: 'dlg-form', method: 'dialog', novalidate: true }, h('h3', { text: title }), nodes);
    form.addEventListener('submit', (e) => e.preventDefault());   // Enter で、何もせずに閉じてしまわないように（送る処理は、各ダイアログが付ける）
    d.appendChild(form);
    if ('onClose' in o) dlgState.onClose = o.onClose;
    if (!d.open) d.showModal();
    return form;
  }
  function closeDlg(quiet) {
    const d = $('dlg');
    if (quiet) dlgState.onClose = null;
    if (d && d.open) { d.close(); d.textContent = ''; }   // 中身は、すぐ捨てる（閉じたあとの close イベントは、少し遅れて届く）
  }
  const dlgField = (label, el) => h('div', { class: 'dlg-field' }, h('label', { class: 'l', for: el.id, text: label }), el);
  const dlgActions = (...btns) => h('div', { class: 'dlg-actions' }, btns);
  const cancelBtn = (text) => h('button', { class: 'btn', type: 'button', onclick: () => closeDlg(), text: text || 'キャンセル' });
  /** 「#/new」「#/join…」のリンクで開いたダイアログを閉じたら、ホームに戻る（ボタンで開いたときは、いまの画面のまま） */
  const leaveDeepLink = () => { if (/^#\/(new|join)/.test(root.location.hash)) go('#/'); };
  /** メニュー（スマホの下の切り替え・狭いパソコン画面・しまった左の一覧から開く）：ログイン中の名前・棚を作る・参加・使い方・規約・アカウントの削除・ログアウト */
  function openMenu() {
    if (!me) return;
    const item = (id, ic, text, on) => h('button', { id, class: 'm-item', type: 'button', onclick: () => { closeDlg(true); on(); } }, icon(ic), text);
    const link = (id, ic, text, href, ext) => h('a', Object.assign({ id, class: 'm-item', href, onclick: () => closeDlg(true) }, ext ? { target: '_blank', rel: 'noopener' } : {}), icon(ic), text);
    showDlg('メニュー', [
      h('p', { class: 'dlg-msg' }, 'ログイン中：', h('b', { id: 'shMenuMe', text: me.nick })),
      h('div', { class: 'm-menu' },
        item('shMenuNew', 'plus', '棚を作る', openNew),
        item('shMenuJoin', 'plus', '招待コードで参加', () => openJoin({})),
        link('shMenuApp', 'edit', 'ノートを開く', U.cfg.appUrl, true),
        link('shMenuGuide', 'book', '画像つきの使い方', 'guide.html#shelf', true),
        link('shMenuTerms', 'menu', '利用規約・プライバシー', 'terms.html', true),
        link('shMenuAccount', 'info', 'アカウントを削除する', '#/account'),
        item('shMenuLogout', 'menu', 'ログアウト', logout)),
      dlgActions(cancelBtn('閉じる'))], { id: 'shMenuForm', onClose: null });
  }
  const shelfTitle = (sid, id, name) => h('div', { class: 'sh-created' }, h('span', { class: 'dot sh-dotlg ' + C.colorClass(sid) }), h('b', { id, text: name }));

  /* ---------- 棚を作る ---------- */
  const DEFAULT_RULES = '・講義資料や過去問を、無断で転載しない\n・他の人の個人情報を載せない\n・「編集しないで」の投稿は、勝手に直さない\n・違反があった場合は、管理者が対応します';
  function openNew() {
    if (!me) return;
    if (!M.shelvesLeft(me.shelfCount)) {
      showDlg('棚を作る', [note('これ以上、棚を作れません（1人5つまでです）。', true, 'shNewLimit'), dlgActions(cancelBtn('閉じる'))], { onClose: leaveDeepLink });
      return;
    }
    const msg = msgBox();
    const nameIn = h('input', { id: 'shNewName', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: '例：統計学 2班、経済学ゼミ' });
    const ta = h('textarea', { id: 'shNewRules', rows: 8 }); ta.value = DEFAULT_RULES;
    const goBtn = h('button', { id: 'shNewGo', class: 'btn primary', type: 'submit', text: '棚を作る' });
    const form = showDlg('棚を作る', [
      dlgField('棚の名前', nameIn), dlgField('棚のルール', ta),
      h('p', { class: 'dlg-msg', text: 'ルールは、参加するとき、全員に表示されます。強制力はありませんが、違反があれば、管理者（あなた）が対応します。' }),
      msg, dlgActions(cancelBtn(), goBtn)], { id: 'shNewForm', onClose: leaveDeepLink });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = M.checkShelfName(nameIn.value); if (!n.ok) return say(msg, n.error);
      const ru = M.checkRulesText(ta.value); if (!ru.ok) return say(msg, ru.error);
      busy(goBtn, true, '作っています…'); say(msg, '');
      const r = await A.createShelf({ uid: me.uid, nick: me.nick, name: n.name, rules: ru.rules });
      if (expired(r)) return;
      if (!r.ok) { busy(goBtn, false, '棚を作る'); return say(msg, r.code === 'denied' ? '棚を作れませんでした。作れる棚は5つまでです（利用停止中の場合も作れません）。' : r.message); }
      me.shelfCount += 1; shelves = null;
      showCreated(r.sid, r.code, n.name);
    });
    nameIn.focus();
  }
  function inviteBlock(name, code) {
    const link = M.joinLink(root.location.href, code);
    return [
      h('span', { id: 'shCode', class: 'sh-code', text: M.formatCode(code) }),
      h('div', { class: 'sh-row' },
        h('button', { id: 'shCopyCode', class: 'sh-btn', type: 'button', onclick: (e) => copy(M.formatCode(code), e.currentTarget), text: 'コードをコピー' }),
        h('button', { id: 'shCopyMsg', class: 'sh-btn', type: 'button', onclick: (e) => copy(M.shareText(name, code, link), e.currentTarget), text: 'LINE に貼る文面をコピー' })),
    ];
  }
  /** 棚ができた：招待コード。閉じる（×・Esc・「棚を開く」）と、その棚を開く */
  function showCreated(sid, code, name) {
    showDlg('棚を作りました', [
      shelfTitle(sid, 'shCreatedName', name),
      h('p', { class: 'dlg-msg', text: '友達を、この招待コードで誘ってください。LINE のグループに貼れば、そこから参加できます。' }),
      inviteBlock(name, code),
      dlgActions(h('button', { id: 'shOpenShelf', class: 'btn primary', type: 'button', onclick: () => closeDlg(), text: '棚を開く' }))],
      { onClose: () => go('#/s/' + sid) });
  }

  /* ---------- 招待コードで参加 ---------- */
  function openJoin(r) {
    if (!me) return;
    r = r || {};
    const msg = msgBox();
    const code = h('input', { id: 'shJoinCode', type: 'text', class: 'sh-input-code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'XXXX-XXXX-XXXX' });
    if (r.code) code.value = M.formatCode(r.code);
    const next = h('button', { id: 'shJoinNext', class: 'btn primary', type: 'submit', text: '次へ' });
    const form = showDlg('棚に参加する', [
      dlgField('招待コード', code), h('p', { class: 'dlg-msg', text: '管理者から LINE で届いた12文字のコードです。' }),
      msg, dlgActions(cancelBtn(), next)], { id: 'shJoinForm', onClose: leaveDeepLink });
    async function lookup(c) {
      busy(next, true, '確かめています…'); say(msg, '');
      const inv = await A.lookupInvite(c);
      if (expired(inv)) return;
      if (!inv.ok || !inv.exists) { busy(next, false, '次へ'); return say(msg, inv.ok ? 'そのコードの棚は、見つかりませんでした。コードが古いか、入力が違っている可能性があります。' : inv.message); }
      const [sh, mem] = await Promise.all([A.getShelf(inv.sid), A.getMember(inv.sid, me.uid)]);
      if (expired(sh) || expired(mem)) return;
      if (!sh.ok || !sh.exists) { busy(next, false, '次へ'); return say(msg, sh.ok ? 'その棚は、見つかりませんでした。' : sh.message); }
      if (mem.ok && mem.exists) {
        if (mem.banned) { busy(next, false, '次へ'); return say(msg, 'この棚には、参加できません。'); }
        closeDlg(true); return go('#/s/' + inv.sid);
      }
      showConsent(inv.sid, c, sh);
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const c = M.parseCode(code.value);
      if (!c) return say(msg, '招待コードは、12文字です（英字と数字。I・O・0・1 は使いません）。入力を確かめてください。');
      lookup(c);
    });
    if (r.code) lookup(r.code);
    else if (r.raw) say(msg, 'リンクのコードが正しくありません。入力し直してください。');
    else code.focus();
  }
  /** ルールを読んで、同意して参加する */
  function showConsent(sid, code, sh) {
    const msg = msgBox();
    const agree = h('input', { id: 'shJoinAgree', type: 'checkbox' });
    const goBtn = h('button', { id: 'shJoinGo', class: 'btn primary', type: 'button', text: '同意して参加' });
    showDlg('棚に参加する', [
      shelfTitle(sid, 'shJoinName', sh.name),
      h('p', { class: 'dlg-msg', text: 'メンバー ' + sh.memberCount + '人' }),
      h('div', { class: 'dlg-field' }, h('label', { class: 'l', text: 'この棚のルール' }), h('p', { id: 'shJoinRules', class: 'sh-rules', text: sh.rules || '（管理者は、ルールを書いていません）' })),
      h('p', { class: 'dlg-msg', text: 'ルールに強制力はありませんが、違反があった場合は、管理者が対応します。' }),
      h('p', { id: 'shJoinLikeNote', class: 'dlg-msg', text: LIKE_NOTE }),
      h('label', { class: 'sh-check' }, agree, h('span', { text: 'ルールを読み、同意する' })),
      msg,
      dlgActions(h('button', { class: 'btn', type: 'button', onclick: () => openJoin({}), text: '別のコードを入力する' }), goBtn)], { id: 'shJoinConsentForm' });
    goBtn.addEventListener('click', async () => {
      if (!agree.checked) return say(msg, 'ルールに同意すると、参加できます。');
      busy(goBtn, true, '参加しています…'); say(msg, '');
      const r = await A.joinShelf({ sid, code, uid: me.uid, nick: me.nick, shelfName: sh.name });
      if (expired(r)) return;
      if (!r.ok) { busy(goBtn, false, '同意して参加'); return say(msg, r.code === 'denied' ? '参加できませんでした。コードが古いか、この棚に入れない状態です。' : r.code === 'exists' ? 'すでに参加しています。' : r.message); }
      delete cache.shelf[sid]; shelves = null;
      closeDlg(true); go('#/s/' + sid);
    });
  }

  /* ---------- 棚の中（フォルダの列） ---------- */
  async function loadShelf(sid, fresh) {
    const c = cache.shelf[sid];
    if (!fresh && c && Date.now() - c.at < TTL) return c.v;
    const [sh, mem, lk] = await Promise.all([A.getShelf(sid), A.getMember(sid, me.uid), A.getMyLikes(sid, me.uid)]);
    const v = { sh, mem, lk: lk.ok ? lk : { ok: true, exists: false, nids: {} } };   // 自分のいいね（読めなかったときは、空として扱う）
    if (sh.ok && mem.ok) cache.shelf[sid] = { at: Date.now(), v };
    return v;
  }
  /** フォルダの文書を読む（画面を開いている間は、覚えておく）。列の画面は、最上位から、いま開いているフォルダまでの、全部の文書を使う */
  async function folderDoc(sid, fid, fresh) {
    const m = (cache.folders[sid] = cache.folders[sid] || {});
    const c = m[fid];
    if (!fresh && c && Date.now() - c.at < TTL) return c.v;
    const r = await A.getFolder(sid, fid);
    if (r.ok && r.exists) m[fid] = { at: Date.now(), v: r };
    return r;
  }
  /** 最上位 → fid までの、フォルダの文書の並び。first＝fid の文書（読み込みずみ）。読めない文書があれば { err } */
  async function chainOf(sid, fid, first, fresh) {
    const docs = []; let d = first, at = fid;
    for (let i = 0; i <= M.MAX_DEPTH + 1; i++) {
      if (!d.ok || !d.exists) return { err: d };
      docs.unshift(d);
      if (at === 'root') return { docs };
      at = d.parent || 'root';
      d = await folderDoc(sid, at, fresh);
    }
    return { err: { ok: true, exists: false } };   // 深すぎる（想定外）
  }
  /** パンくず：[{ fid, name }]（最上位 → いまのフォルダ）。フォルダの名前は、1つ上のフォルダの文書にある */
  const crumbsOf = (docs, rootName) => docs.map((d, i) => ({ fid: d.fid, name: i === 0 ? rootName : ((docs[i - 1].children.find((c) => c.id === d.fid && c.type === 'folder') || {}).name || '（名前なし）') }));
  const folderHref = (sid, fid) => '#/s/' + sid + (fid === 'root' ? '' : '/f/' + fid);
  const postHref = (sid, fid, pid) => '#/s/' + sid + (fid === 'root' ? '' : '/f/' + fid) + '/p/' + pid;

  /** 棚・自分のメンバー情報・フォルダの文書（最上位から、いまのフォルダまで）を読む。問題があれば、その説明の画面を出して null を返す。問題なければ { sid, fid, sh, mem, docs, fo, crumbs, lk } */
  async function openView(sid, fid, t, fresh) {
    if (!app.classList.contains('app')) page(h('p', { class: 'sh-loading', text: '読み込んでいます…' }));
    if (fresh) delete cache.folders[sid];
    const [base, first] = await Promise.all([loadShelf(sid, fresh), folderDoc(sid, fid, fresh), loadShelves(false)]);
    if (t !== view) return null;
    const sh = base.sh, mem = base.mem;
    if (expired(sh) || expired(mem) || expired(first)) return null;
    if (!sh.ok) { showFatal(sh.message, route); return null; }
    if (!sh.exists) {
      page(h('h1', { id: 'shNoShelf', class: 'sh-h', text: 'この棚は、見つかりません' }), note('棚が削除されたか、リンクが違っている可能性があります。'),
        h('button', { id: 'shDropJoined', class: 'sh-btn block', type: 'button', text: 'この棚を、参加中の一覧から外す', onclick: async () => { const r = await A.dropJoined(me.uid, sid); if (expired(r)) return; delete joinedNames[sid]; shelves = null; go('#/'); } }),
        h('p', { class: 'sh-lead' }, linkTo('#/', '棚の一覧に戻る')));
      return null;
    }
    if (joinedNames[sid] !== undefined && joinedNames[sid] !== sh.name && mem.ok && mem.exists) { joinedNames[sid] = sh.name; A.syncJoinedName(me.uid, sid, sh.name); }   // 棚の名前が変わっていたら、自分の参加一覧の写しも直す（待たない）
    if (!mem.ok) { showFatal(mem.message, route); return null; }
    if (!mem.exists || mem.banned) {
      page(h('h1', { id: 'shNotMember', class: 'sh-h', text: sh.name }), note(mem.banned ? 'この棚には、参加できません。' : 'この棚のメンバーではありません。招待コードで参加してください。', true),
        h('p', { class: 'sh-lead' }, linkTo('#/join', '招待コードで参加する'), '　', linkTo('#/', '棚の一覧に戻る')));
      return null;
    }
    if (!first.ok) { showFatal(first.message, route); return null; }
    const ch = await chainOf(sid, fid, first, fresh);
    if (t !== view) return null;
    if (ch.err) {
      if (expired(ch.err)) return null;
      if (!ch.err.ok) { showFatal(ch.err.message, route); return null; }
      page(h('h1', { id: 'shNoFolder', class: 'sh-h', text: 'このフォルダは、見つかりません' }), note('フォルダが削除されたか、リンクが違っている可能性があります。'), h('p', { class: 'sh-lead' }, linkTo('#/s/' + sid, '棚の最上位に戻る')));
      return null;
    }
    return { sid, fid, sh, mem, docs: ch.docs, fo: ch.docs[ch.docs.length - 1], crumbs: crumbsOf(ch.docs, sh.name), lk: base.lk };
  }

  /** 棚・フォルダ・投稿を開く（pid があれば、その投稿を右に表示）。左の棚の一覧・列・右の表示を描く */
  async function showShelf(sid, fid, t, fresh, pid) {
    const o = await openView(sid, fid, t, fresh);
    if (!o || !me) return;   // 読み込み中にログアウトされていたら、描かない（描くと、ログアウト後に me が無く、エラーになる）
    o.pid = pid || '';
    if (pid) o.post = o.fo.children.find((c) => c.id === pid && c.type === 'post');
    // 覚えていた文書が古いのかもしれない（ほかの人が足した投稿・フォルダへのリンクを開いたとき）：1回だけ、読み直す
    if (!fresh && ((pid && !o.post) || o.crumbs.some((c) => c.name === '（名前なし）'))) return showShelf(sid, fid, t, true, pid);
    if (pid) {
      if (!o.post) {
        return page(h('h1', { id: 'shNoPost', class: 'sh-h', text: 'この投稿は、見つかりません' }), note('削除されたか、リンクが違っている可能性があります。'),
          h('p', { class: 'sh-lead' }, linkTo(folderHref(sid, fid), 'フォルダに戻る', 'shBack')));
      }
    }
    cur = o;
    shellFrame();
    Array.from($('main').children).forEach((c) => { if (!c.classList.contains('sh-cols') && !c.classList.contains('sh-view')) c.remove(); });   // ホーム（案内）から来たときの、残りを片づける
    if (pinAt !== sid + '/' + o.fid) { pinAt = sid + '/' + o.fid; pins.open = []; pins.closed = []; }   // 別のフォルダへ移ったら、列は自動の並びに戻す（いま開いているフォルダの列は、いつも開く）
    app.dataset.mpane = pid ? 'detail' : 'mid';
    drawSidebar(sid, o.sh.name);
    paintCols(); paintView(t);
  }

  /* ---------- いいね（段階4）：数は、週に1回、管理者の端末が集計する ---------- */
  const likeCount = (fo, pid) => Number((fo.likes || {})[pid]) || 0;
  const derivedLabel = (fo, e) => { const orig = fo.children.find((c) => c.id === e.derivedFrom); return orig ? (orig.authorNick || '') + ' さんの「' + orig.name + '」の版が元' : '派生版（元の投稿は削除されました）'; };
  const rankedText = (sh) => (sh.rankedAt ? '最終集計：' + M.fmtDay(sh.rankedAt) : 'まだ集計されていません');
  const LIKE_NOTE = 'いいねの数は、1週間に1回、管理者の端末で集計されます（自分の投稿への分は数えません）。誰が何にいいねしたかは、管理者に見えます。';
  let lastTally = '';

  /* ---------- 上の階層の一覧（しまった列の「…」・パンくずの「…」を押すと出る） ---------- */
  let pop = null;
  function popKey(e) { if (e.key === 'Escape') closePop(); }
  function closePop() {
    if (!pop) return;
    pop.remove(); pop = null;
    doc.removeEventListener('click', closePop); doc.removeEventListener('keydown', popKey);
  }
  /** items＝[{ fid, name, depth }]（浅い順）。押すと、そのフォルダへ戻る */
  function showPop(anchor, items) {
    closePop();
    const sid = cur.sid, r = anchor.getBoundingClientRect();
    pop = h('div', { id: 'shPop', class: 'sh-pop', role: 'menu' }, h('h6', { text: '上の階層（押すと、そこへ戻ります）' }),
      items.map((it) => h('a', { class: 'd' + Math.min(it.depth, 10), href: folderHref(sid, it.fid), 'data-fid': it.fid, role: 'menuitem', onclick: closePop },
        it.depth === 0 ? h('span', { class: 'dot ' + C.colorClass(sid) }) : icon('folder'), h('span', { text: it.name }))));
    const tall = r.height > 120;   // しまった列の帯のように縦に長いものは、その右に出す（下に出すと、画面の外になる）
    pop.style.left = Math.max(8, Math.min(tall ? r.right + 4 : r.left, (root.innerWidth || 800) - 270)) + 'px';
    pop.style.top = Math.max(8, tall ? r.top + 8 : r.bottom + 4) + 'px';
    doc.body.appendChild(pop);
    root.setTimeout(() => { if (pop) { doc.addEventListener('click', closePop); doc.addEventListener('keydown', popKey); } }, 0);
  }

  /* ---------- 列（フォルダごと）。いちばん奥が、いま開いているフォルダ ---------- */
  const openCol = (id) => { pins.closed = pins.closed.filter((x) => x !== id); pins.open = pins.open.filter((x) => x !== id).concat(id); paintCols(); };
  const closeCol = (id) => { pins.open = pins.open.filter((x) => x !== id); if (!pins.closed.includes(id)) pins.closed.push(id); paintCols(); };

  /** 列を描き直す（画面の幅・しまう／ひらく・並び順が変わったとき。通信はしない）。列ごとの上下の位置は、そのまま残す */
  function paintCols() {
    const o = cur, main = $('main');
    if (!o || !main) return;
    closePop();
    const oldWrap = main.querySelector('.sh-cols');
    const memo = {};
    if (oldWrap) oldWrap.querySelectorAll('.list-body[data-fid]').forEach((b) => { memo[b.dataset.fid] = b.scrollTop; });
    const ids = o.docs.map((d) => d.fid);
    const segs = phone() ? [{ kind: 'col', id: ids[ids.length - 1] }] : C.plan(ids, { width: main.clientWidth || root.innerWidth || 0, open: pins.open, closed: pins.closed });
    const wrap = h('div', { class: 'sh-cols' });
    segs.forEach((s) => {
      if (s.kind === 'col') return wrap.appendChild(columnEl(o, ids.indexOf(s.id)));
      if (s.kind === 'strip') return wrap.appendChild(C.strip(h, { id: s.id, label: o.crumbs[ids.indexOf(s.id)].name, onclick: () => openCol(s.id) }));
      wrap.appendChild(C.strip(h, { id: s.ids[0], merged: true, label: '… 上の' + s.ids.length + 'つの階層',
        onclick: (e) => showPop(e.currentTarget, s.ids.map((id) => ({ fid: id, name: o.crumbs[ids.indexOf(id)].name, depth: ids.indexOf(id) }))) }));
    });
    if (oldWrap) oldWrap.replaceWith(wrap); else main.insertBefore(wrap, main.firstChild);
    wrap.querySelectorAll('.list-body[data-fid]').forEach((b) => { if (memo[b.dataset.fid]) b.scrollTop = memo[b.dataset.fid]; });
  }

  /** 列1本：フォルダ1つの中身（フォルダ → 投稿）。i＝何本目（0＝最上位）。同じ画面に同じ ID が並ばないよう、ID は、いちばん奥の列だけにつける */
  function columnEl(o, i) {
    const { sid, sh, mem, docs, lk } = o;
    const fo = docs[i], fid = fo.fid, deepest = i === docs.length - 1, isRoot = fid === 'root';
    const colName = o.crumbs[i].name;
    const sel = deepest ? o.pid : docs[i + 1].fid;
    const admin = mem.role === 'admin', canCreate = admin || sh.open;
    const full = fo.children.length >= M.MAX_CHILDREN, tooDeep = fo.depth + 1 > M.MAX_DEPTH;
    const uid = (base) => (deepest ? base : base + '-' + fid);
    const refresh = () => { if (cache.folders[sid]) delete cache.folders[sid][fid]; showShelf(sid, o.fid, nav(), false, o.pid); };
    const msg = h('p', { id: uid('shFolderMsg'), class: 'sh-msg', hidden: true, role: 'alert' });
    /** 消したあと：いま開いている道筋・投稿を消したときは、1つ上へ戻る */
    function afterRemove(removedId) {
      if (cache.folders[sid]) { delete cache.folders[sid][fid]; delete cache.folders[sid][removedId]; }
      if (docs.some((d) => d.fid === removedId)) return go(folderHref(sid, fid));
      if (o.pid === removedId) return go(folderHref(sid, o.fid));
      showShelf(sid, o.fid, nav(), false, o.pid);
    }

    /* 項目の1行 */
    function rowView(e) {
      const li = h('li', { 'data-fid': e.id, 'data-type': e.type });
      const isPost = e.type === 'post';
      const mine = e.createdBy === me.uid;
      const canRename = admin || mine;
      const canDelete = isPost ? (admin || mine) : admin;   // 投稿は、投稿した人と管理者。フォルダは、管理者だけ
      const on = e.id === sel, n = likeCount(fo, e.id);
      const link = () => (isPost
        ? h('a', { class: 'note-item sh-post' + (on ? ' on' : ''), href: postHref(sid, fid, e.id), title: e.name },
          h('div', { class: 'ni-title' }, h('span', { class: 'sh-fname', text: e.name })),
          h('div', { class: 'ni-meta sh-meta' }, h('span', { class: 'sh-kind k-' + e.kind, text: M.kindLabel(e.kind) }), h('span', { text: e.authorNick || '' }),
            n || lk.nids[e.id] ? h('span', { class: 'sh-likes' + (lk.nids[e.id] ? ' mine' : ''), text: '♥ ' + n }) : null,
            M.isPopular(n, sh.memberCount) ? h('span', { class: 'sh-tag sh-popular', text: '人気' }) : null),
          e.derivedFrom ? h('div', { class: 'sh-derived', text: derivedLabel(fo, e) }) : null)
        : h('a', { class: 'note-item sh-folder' + (on ? ' on' : ''), href: folderHref(sid, e.id), title: e.name },
          h('div', { class: 'ni-title' }, icon('folder'), h('span', { class: 'sh-fname', text: e.name }), h('span', { class: 'sh-chev' }, icon('chev'))),
          h('div', { class: 'ni-meta' }, h('span', { text: M.fmtDay(e.created) }), h('span', { text: e.authorNick || '' }))));
      const show = () => {
        li.textContent = ''; li.className = on ? 'on' : '';
        li.appendChild(link());
        if (canRename || canDelete) {
          li.appendChild(h('div', { class: 'sh-actions' },
            canRename ? h('button', { class: 'sh-btn sm sh-rename', type: 'button', onclick: renameForm, text: isPost ? 'タイトルを変える' : '名前を変える' }) : null,
            canDelete ? h('button', { class: 'sh-btn sm sh-delete', type: 'button', onclick: isPost ? askDeletePost : askDelete, text: '削除' }) : null));
        }
      };
      function renameForm() {
        li.textContent = '';
        const inp = h('input', { type: 'text', class: 'sh-rename-input', autocomplete: 'off', value: e.name });
        const m2 = h('p', { class: 'sh-msg sh-rename-msg', hidden: true, role: 'alert' });
        const f = h('form', { class: 'sh-inline', novalidate: true }, inp, m2,
          h('div', { class: 'sh-row' }, h('button', { class: 'sh-btn sm primary sh-rename-go', type: 'submit', text: '変える' }), h('button', { class: 'sh-btn sm', type: 'button', onclick: show, text: 'やめる' })));
        f.addEventListener('submit', async (ev) => {
          ev.preventDefault();
          const nm = isPost ? M.checkPostTitle(inp.value) : M.checkFolderName(inp.value); if (!nm.ok) return say(m2, nm.error);
          const newName = isPost ? nm.title : nm.name;
          if (newName === e.name) return show();
          const r = await A.renameEntry({ sid, parent: fid, id: e.id, name: newName });
          if (expired(r)) return;
          if (!r.ok) return say(m2, r.code === 'denied' ? '名前を変える権限がありません（作った人と管理者だけが変えられます）。' : r.message);
          refresh();
        });
        li.appendChild(f); inp.focus();
      }
      /* 投稿の削除：目次から外す。ドライブのファイルは、投稿者のものなので、ここでは消せない（LINE の中では Google にログインできないため） */
      function askDeletePost() {
        li.textContent = '';
        const m2 = h('p', { class: 'sh-msg sh-delete-msg', hidden: true, role: 'alert' });
        li.appendChild(h('div', { class: 'sh-confirm' },
          h('p', { class: 'sh-sub sh-confirm-text', text: '「' + e.name + '」を、この棚の一覧から消します。元に戻せません。' }),
          mine
            ? h('p', { class: 'sh-note sh-confirm-drive' }, 'あなたのドライブにあるファイル自体は、残ります（リンクを知っている人は、開けるままです）。ファイルも消して、公開を止めるには、Safari または Chrome で、', h('a', { class: 'sh-link', id: uid('shManageLink'), href: M.manageLink(U.cfg.appUrl + U.cfg.appExternal), target: '_blank', rel: 'noopener', text: '「自分の投稿の管理」' }), 'を開いてください。')
            : h('p', { class: 'sh-note sh-confirm-drive', text: '管理者が消すのは、一覧からだけです。ファイル自体は、投稿者のドライブに残ります。' }),
          m2,
          h('div', { class: 'sh-row' },
            h('button', { class: 'sh-btn sm danger sh-delete-go', type: 'button', text: '一覧から消す', onclick: async (ev) => {
              const goBtn = ev.currentTarget;
              busy(goBtn, true, '消しています…');
              const r = await A.removeEntry({ sid, parent: fid, id: e.id });
              if (expired(r)) return;
              if (!r.ok) { busy(goBtn, false, '一覧から消す'); return say(m2, r.code === 'denied' ? '消す権限がありません（投稿した人と管理者だけが消せます）。' : r.message); }
              afterRemove(e.id);
            } }),
            h('button', { class: 'sh-btn sm', type: 'button', onclick: show, text: 'やめる' }))));
      }
      async function askDelete() {
        li.textContent = '';
        li.appendChild(h('p', { class: 'sh-sub', text: '中を調べています…' }));
        const sc = await A.scanTree(sid, e.id);
        if (expired(sc)) return;
        li.textContent = '';
        if (!sc.ok) { li.appendChild(h('p', { class: 'sh-msg', role: 'alert', text: sc.message })); li.appendChild(h('button', { class: 'sh-btn sm', type: 'button', onclick: show, text: '戻る' })); return; }
        const m2 = h('p', { class: 'sh-msg sh-delete-msg', hidden: true, role: 'alert' });
        li.appendChild(h('div', { class: 'sh-confirm' },
          h('p', { class: 'sh-sub sh-confirm-text', text: '「' + e.name + '」と、その中の' + sc.items + '件を消します。元に戻せません。' }), m2,
          h('div', { class: 'sh-row' },
            h('button', { class: 'sh-btn sm danger sh-delete-go', type: 'button', text: '消す', onclick: async (ev) => {
              const goBtn = ev.currentTarget;
              busy(goBtn, true, '消しています…');
              const r = await A.removeFolder({ sid, parent: fid, fid: e.id, ids: sc.ids });
              if (expired(r)) return;
              if (!r.ok) { busy(goBtn, false, '消す'); return say(m2, r.code === 'denied' ? '消す権限がありません（フォルダを消せるのは、管理者だけです）。' : r.message); }
              afterRemove(e.id);
            } }),
            h('button', { class: 'sh-btn sm', type: 'button', onclick: show, text: 'やめる' }))));
      }
      show();
      return li;
    }
    const list = h('ul', { id: uid('shFolderList'), class: 'sh-rows' });
    M.sortEntries(fo.children, sortMode, fo.likes).forEach((e) => { if (e.type === 'folder' || e.type === 'post') list.appendChild(rowView(e)); });

    /* 新しいフォルダ */
    const nfName = h('input', { id: uid('shNewFolderName'), type: 'text', maxlength: 200, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const nfGo = h('button', { id: uid('shNewFolderGo'), class: 'sh-btn primary sm', type: 'submit', text: '作る' });
    const nf = h('form', { id: uid('shNewFolderForm'), class: 'sh-inline', novalidate: true, hidden: true },
      h('div', { class: 'sh-field' }, h('label', { for: uid('shNewFolderName'), text: '新しいフォルダの名前' }), nfName, h('p', { class: 'sh-hint', text: '例：第3回 回帰分析、過去問' })),
      h('div', { class: 'sh-row' }, nfGo, h('button', { id: uid('shNewFolderCancel'), class: 'sh-btn sm', type: 'button', onclick: () => { nf.hidden = true; say(msg, ''); }, text: 'やめる' })));
    nf.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const n = M.checkFolderName(nfName.value); if (!n.ok) return say(msg, n.error);
      busy(nfGo, true, '作っています…'); say(msg, '');
      const r = await A.addFolder({ sid, parent: fid, parentDepth: fo.depth, uid: me.uid, nick: me.nick, name: n.name });
      if (expired(r)) return;
      if (!r.ok) { busy(nfGo, false, '作る'); return say(msg, r.code === 'denied' ? 'フォルダを作れませんでした。この棚では、管理者だけがフォルダを作れる設定かもしれません（1フォルダ300件・深さ10段までの上限もあります）。' : r.message); }
      refresh();
    });
    const newBtn = h('button', { id: uid('shNewFolderBtn'), class: 'btn', type: 'button', title: 'この中にフォルダを作る', onclick: () => {
      if (tooDeep) return say(msg, 'これより深いフォルダは、作れません（' + M.MAX_DEPTH + '段までです）。');
      if (full) return say(msg, 'このフォルダは、いっぱいです（' + M.MAX_CHILDREN + '件までです）。');
      say(msg, ''); nf.hidden = false; nfName.focus();
    } }, icon('plus'), 'フォルダ');

    const sortSel = h('select', { id: uid('shSort'), 'aria-label': '並び順' }, h('option', { value: 'new', text: '新着順' }), h('option', { value: 'name', text: '名前順' }), h('option', { value: 'likes', text: 'いいね順' }));
    sortSel.value = sortMode;
    sortSel.addEventListener('change', () => { sortMode = sortSel.value; paintCols(); });

    const back = i === 0 ? h('a', { class: 'm-back', href: '#/', text: '‹ 棚' }) : h('a', { class: 'm-back', href: folderHref(sid, docs[i - 1].fid), text: '‹ ' + o.crumbs[i - 1].name });
    const head = h('div', { class: 'list-head' },
      h('div', { class: 'm-bar' }, back, h('span', { class: 'grow' }),
        isRoot ? h('button', { id: 'shInfoBtn', class: 'btn sm m-only', type: 'button', onclick: () => { app.dataset.mpane = 'detail'; }, text: '棚の情報' }) : null),
      h('div', { class: 'list-title' }, isRoot ? h('span', { class: 'dot ' + C.colorClass(sid) }) : icon('folder'), h('h2', { text: colName, title: colName }),
        C.foldBtn(h, { open: true, title: 'しまう：' + colName, onclick: () => closeCol(fid) })),
      i > 0 ? h('p', { class: 'sh-pathline', text: o.crumbs.slice(0, i).map((c) => c.name).join(' › ') }) : null,   // スマホ：いまの場所（上の階層）
      h('div', { class: 'sh-colbtns' },
        full ? null : h('a', { id: uid('shPostLink'), class: 'btn primary', href: M.postToLink(U.cfg.appUrl + U.cfg.appExternal, sid, fid), target: '_blank', rel: 'noopener', title: 'ここに投稿する（Safari / Chrome で開く）' }, icon('plus'), '投稿する'),
        canCreate ? newBtn : null),
      full ? h('p', { id: uid('shPostFull'), class: 'sh-note warn', text: 'このフォルダは、いっぱいです（' + M.MAX_CHILDREN + '件まで）。別のフォルダに投稿してください。' }) : null,
      h('div', { class: 'sh-colbar' }, h('span', { id: uid('shCount'), text: fo.children.length + '件' }), sortSel,
        h('button', { id: uid('shReload'), class: 'btn sm', type: 'button', title: '最新の状態に更新する', onclick: () => showShelf(sid, o.fid, nav(), true, o.pid), text: '更新' })),
      nf, msg);
    const body = h('div', { class: 'list-body', 'data-fid': fid },
      fo.children.length ? list : h('p', { id: uid('shFolderEmpty'), class: 'empty-note', text: canCreate ? 'まだ、何もありません。「フォルダ」で単元などのフォルダを作ったり、「投稿する」でファイルを投稿したりできます。' : 'まだ、何もありません。（この棚では、管理者がフォルダを作ります。ファイルは、投稿できます）' }));
    /* スマホ：右下の「＋」→「この中にフォルダを作る」「ここに投稿する」（パソコンでは、列の上のボタン。css で出し分ける） */
    const hasFab = canCreate || !full;
    const fabMenu = h('div', { class: 'sh-fabmenu', hidden: true },
      canCreate ? h('button', { id: uid('shFabFolder'), class: 'btn', type: 'button', onclick: () => { setFab(false); newBtn.click(); } }, icon('folder'), 'この中にフォルダを作る') : null,
      full ? null : h('a', { id: uid('shFabPost'), class: 'btn primary', href: M.postToLink(U.cfg.appUrl + U.cfg.appExternal, sid, fid), target: '_blank', rel: 'noopener', onclick: () => setFab(false) }, icon('plus'), 'ここに投稿する'));
    const fab = h('button', { id: uid('shFab'), class: 'sh-fab', type: 'button', 'aria-label': '追加する', 'aria-expanded': 'false', onclick: () => setFab(fabMenu.hidden) }, icon('plus'));
    function setFab(on) { fabMenu.hidden = !on; fab.setAttribute('aria-expanded', String(!!on)); }
    return h('section', { class: 'list-col', 'data-fid': fid }, head, body, hasFab ? [fabMenu, fab] : null);
  }

  /* ---------- 右の表示：棚のホーム（最上位）・フォルダ・投稿 ---------- */
  function paintView(t) {
    const o = cur, main = $('main');
    if (!o || !main) return;
    const v = o.post ? viewPost(o, t) : (o.fid === 'root' ? viewHome(o) : viewFolder(o));
    const old = main.querySelector('.sh-view');
    if (old) old.replaceWith(v); else main.appendChild(v);
  }
  /** パンくず（最上位 → いまのフォルダ）。tail があれば、その名前（開いている投稿）を、最後に付ける。長いときは、途中を「…」にまとめる */
  function crumbsEl(o, tail) {
    const cs = o.crumbs, sid = o.sid, long = cs.length > 5;
    const parts = [];
    cs.forEach((c, i) => {
      if (long && i >= 1 && i < cs.length - 3) {
        if (i === 1) parts.push(h('button', { type: 'button', class: 'sh-crumb-more', title: '上の階層を見る', text: '…',
          onclick: (e) => { e.stopPropagation(); showPop(e.currentTarget, cs.slice(1, cs.length - 3).map((x, k) => ({ fid: x.fid, name: x.name, depth: k + 1 }))); } }));
        return;
      }
      parts.push(i === cs.length - 1 && !tail ? h('span', { class: 'sh-crumb-cur', text: c.name }) : h('a', { class: 'sh-link sh-crumb-link', href: folderHref(sid, c.fid), text: c.name }));
    });
    if (tail) parts.push(h('span', { class: 'sh-crumb-cur', text: tail }));
    return h('p', { id: 'shCrumb', class: 'sh-crumbs' }, parts.map((p, i) => [i ? ' › ' : null, p]));
  }

  /** 棚のホーム：招待コード・ルール・設定・集計・（メンバーは）抜ける */
  function viewHome(o) {
    const { sid, sh, mem } = o, admin = mem.role === 'admin';
    const redrawAll = (fresh) => showShelf(sid, o.fid, nav(), fresh, o.pid);
    return h('section', { class: 'editor-col sh-view', 'data-fid': 'root' },
      h('div', { class: 'ed-head' },
        h('div', { class: 'm-bar' }, h('button', { class: 'm-back', type: 'button', onclick: () => { app.dataset.mpane = 'mid'; }, text: '‹ 中身' })),
        h('div', { class: 'hbar' }, h('span', { class: 'dot sh-dotlg ' + C.colorClass(sid) }), h('h1', { id: 'shTitle', text: sh.name }),
          h('span', { id: 'shRole', class: 'sh-pill' + (admin ? ' accent' : ''), text: admin ? '管理者' : 'メンバー' }), h('span', { class: 'sh-pill', text: 'メンバー ' + sh.memberCount + '人' }),
          admin ? h('div', { class: 'hr-r' }, h('a', { id: 'shAdminLink', class: 'btn sm', href: adminHref(sid), text: '管理者の画面' })) : null)),
      h('div', { class: 'sh-viewbody' },
        admin && mem.code ? h('div', { id: 'shInviteCard', class: 'sh-card' }, h('h2', { text: '招待コード' }), h('p', { class: 'sh-sub', text: '友達に伝えて、参加してもらいます。' }), inviteBlock(sh.name, mem.code)) : null,
        h('div', { class: 'sh-card' }, h('h2', { text: 'この棚のルール' }), h('p', { id: 'shRules', class: 'sh-rules', text: sh.rules || '（管理者は、ルールを書いていません）' }), h('p', { class: 'sh-sub', text: LIKE_NOTE })),
        admin ? settingsCard(sid, sh) : null,
        admin ? tallyCard(sid, sh, redrawAll) : null,
        admin ? null : leaveCard(sid, sh),
        o.fo.children.some((c) => c.type === 'post') ? h('p', { id: 'shRanked', class: 'sh-hint-line', text: 'いいねの数は、毎週更新されます（' + rankedText(sh) + '）。' }) : null,
        h('p', { class: 'sh-hint-line', text: '左の列で、フォルダや投稿を選んでください。' })));
  }

  /** フォルダ（投稿を選んでいないとき）：ここに投稿する・数 */
  function viewFolder(o) {
    const { sid, sh, fo } = o;
    const posts = fo.children.filter((c) => c.type === 'post').length, subs = fo.children.filter((c) => c.type === 'folder').length;
    const hearts = Object.keys(fo.likes || {}).reduce((s, k) => s + (Number(fo.likes[k]) || 0), 0);
    const full = fo.children.length >= M.MAX_CHILDREN;
    const sum = (n, label) => h('div', { class: 'sh-sum' }, h('b', { text: String(n) }), h('span', { text: label }));
    return h('section', { class: 'editor-col sh-view', 'data-fid': o.fid },
      h('div', { class: 'ed-head' }, crumbsEl(o, ''),
        h('div', { class: 'hbar' }, icon('folder'), h('h1', { id: 'shTitle', text: o.crumbs[o.crumbs.length - 1].name }), h('span', { class: 'sh-pill', text: '投稿 ' + posts + '件' }), hearts ? h('span', { class: 'sh-pill heart', text: '♥ ' + hearts }) : null)),
      h('div', { class: 'sh-viewbody' },
        full
          ? h('p', { class: 'sh-note warn', text: 'このフォルダは、いっぱいです（' + M.MAX_CHILDREN + '件まで）。別のフォルダに投稿してください。' })
          : h('div', { id: 'shPostHere', class: 'sh-cta' }, h('h3', { text: 'ここに投稿する' }),
            h('p', { text: 'Word・Excel・PowerPoint・PDF を、20MB まで。ファイルは、あなたの Google ドライブに置かれ、この棚のリンクから見られます。' }),
            h('div', { class: 'sh-kinds' }, Object.keys(M.KINDS).map((k) => h('span', { class: 'sh-kind k-' + k, text: M.kindLabel(k) }))),
            h('a', { id: 'shPostLinkBig', class: 'btn primary', href: M.postToLink(U.cfg.appUrl + U.cfg.appExternal, sid, o.fid), target: '_blank', rel: 'noopener' }, icon('plus'), 'ここに投稿する（Safari / Chrome で開く）')),
        h('div', { class: 'sh-sums' }, sum(posts, 'このフォルダの投稿'), sum(hearts, 'いいね（合計）'), sum(subs, 'サブフォルダ')),
        posts ? h('p', { id: 'shRanked', class: 'sh-hint-line', text: 'いいねの数は、毎週更新されます（' + rankedText(sh) + '）。' }) : null,
        h('p', { class: 'sh-hint-line', text: '左の列から投稿を選ぶと、ここに、ノートやファイルがそのままの見た目で開きます。' })));
  }

  /** 投稿：ファイルの確認 → プレビュー（ノートは自前の表示）・取り込み・いいね・通報 */
  function viewPost(o, t) {
    const { sid, fid, post: e } = o;
    const box = h('div', { id: 'shPostState' }, h('p', { class: 'sh-loading', text: 'ファイルを確かめています…' }));
    const v = h('section', { class: 'editor-col sh-view', 'data-pid': e.id },
      h('div', { class: 'ed-head' },
        h('div', { class: 'm-bar' }, h('a', { class: 'm-back', href: folderHref(sid, fid), text: '‹ ' + o.crumbs[o.crumbs.length - 1].name })),
        crumbsEl(o, e.name),
        h('div', { class: 'hbar' }, h('span', { id: 'shPostKind', class: 'sh-kind k-' + e.kind, text: M.kindLabel(e.kind) }), h('h1', { id: 'shPostTitle', text: e.name })),
        h('div', { class: 'ed-meta' }, h('span', { id: 'shPostMeta', class: 'fld', text: V.meta(e, true) }), h('span', { id: 'shPostEdit', class: 'sh-tag ' + (e.edit === 'ok' ? 'edit-ok' : 'edit-no'), text: M.editLabel(e.edit) }))),
      h('div', { class: 'sh-viewbody' }, box, noteExtras(sid, fid, e, o), likeBoxFor(sid, e, o), V.editNotice(h, e), reportBoxFor(sid, fid, e),
        h('p', { class: 'sh-lead m-only' }, linkTo(folderHref(sid, fid), 'フォルダに戻る', 'shBack'))));
    checkPost(e, box, t);
    return v;
  }

  /** ノートの投稿：取り込み（自分のノートに入れる。Safari / Chrome で開く）・元の投稿・派生版の一覧 */
  function noteExtras(sid, fid, e, o) {
    const out = [];
    if (e.kind === 'note') {
      out.push(h('a', { id: 'shImport', class: 'sh-btn', href: M.importLink(U.cfg.appUrl + U.cfg.appExternal, sid, fid, e.id), target: '_blank', rel: 'noopener', text: '自分のノートに取り込む（Safari / Chrome で開く）' }));
    }
    if (e.derivedFrom) {
      const orig = o.fo.children.find((c) => c.id === e.derivedFrom && c.type === 'post');
      out.push(orig
        ? h('p', { id: 'shDerivedFrom', class: 'sh-note' }, 'これは、', linkTo(postHref(sid, fid, orig.id), '「' + orig.name + '」', 'shOrigLink'), '（' + (orig.authorNick || '') + ' さん）の派生版です。')
        : h('p', { id: 'shDerivedFrom', class: 'sh-note', text: 'これは、ある投稿の派生版です（元の投稿は、削除されました）。' }));
    }
    const kids = M.sortEntries(o.fo.children.filter((c) => c.type === 'post' && c.derivedFrom === e.id), 'new');
    if (kids.length) {
      out.push(h('div', { id: 'shDerivs', class: 'sh-card' }, h('h2', { text: 'この投稿の派生版（' + kids.length + '件）' }),
        h('ul', { class: 'sh-list' }, kids.map((k) => h('li', null, h('a', { class: 'sh-item sh-deriv', href: postHref(sid, fid, k.id) },
          h('span', null, h('b', { class: 'sh-fname', text: k.name }), h('small', { class: 'sh-meta', text: (k.authorNick || '') + '　' + M.fmtDay(k.created) + (likeCount(o.fo, k.id) ? '　♥ ' + likeCount(o.fo, k.id) : '') })),
          h('span', { class: 'sh-tag', text: '開く' })))))));
    }
    return out;
  }

  /** 投稿を通報する（自分の投稿以外）。理由は200文字まで。管理者の画面に届く */
  function reportBoxFor(sid, fid, e) {
    if (e.createdBy === me.uid) return null;
    const wrap = h('div', { id: 'shReportBox', class: 'sh-reportbox' });
    const msg = msgBox('shReportMsg');
    function show() {
      wrap.textContent = '';
      wrap.appendChild(h('button', { id: 'shReportOpen', class: 'sh-btn sm', type: 'button', text: 'この投稿を通報する', onclick: form }));
      wrap.appendChild(msg);
    }
    function form() {
      wrap.textContent = '';
      const inp = h('textarea', { id: 'shReportReason', rows: 3, maxlength: 400, placeholder: '例：講義資料の無断転載にあたると思います' });
      wrap.appendChild(h('div', { class: 'sh-field' }, h('label', { for: 'shReportReason', text: '通報の理由（200文字まで。管理者に届きます）' }), inp));
      wrap.appendChild(msg);
      wrap.appendChild(h('div', { class: 'sh-row' },
        h('button', { id: 'shReportGo', class: 'sh-btn sm danger', type: 'button', text: '通報する', onclick: async (ev) => {
          const c = M.checkReason(inp.value); if (!c.ok) return say(msg, c.error);
          const b = ev.currentTarget; busy(b, true, '送っています…'); say(msg, '');
          const r = await A.report({ sid, uid: me.uid, pid: e.id, fid, name: e.name, reason: c.reason });
          if (expired(r)) return;
          if (!r.ok) { busy(b, false, '通報する'); return say(msg, r.code === 'exists' ? 'この投稿は、すでに通報ずみです。' : r.code === 'denied' ? '通報できませんでした（この棚のメンバーでなくなった可能性があります）。' : r.message); }
          wrap.textContent = '';
          wrap.appendChild(h('p', { id: 'shReportDone', class: 'sh-note ok', text: '通報しました。管理者が確認します。（ルール違反への対応は、管理者が行います）' }));
        } }),
        h('button', { class: 'sh-btn sm', type: 'button', text: 'やめる', onclick: show })));
    }
    show();
    return wrap;
  }

  /** 投稿のページの「いいね」。押した直後に、自分の分は画面に反映する（数は、次の集計で変わる） */
  function likeBoxFor(sid, e, o) {
    const lk = o.lk, mine = e.createdBy === me.uid, n = likeCount(o.fo, e.id);
    const wrap = h('div', { id: 'shLikeBox', class: 'sh-likebox' });
    const msg = h('p', { id: 'shLikeMsg', class: 'sh-msg', hidden: true, role: 'alert' });
    function paint() {
      const liked = !!lk.nids[e.id];
      wrap.textContent = '';
      wrap.appendChild(h('div', { class: 'sh-row sh-likerow' },
        h('span', { id: 'shLikeCount', class: 'sh-likes' + (liked ? ' mine' : ''), text: '♥ ' + n }),
        M.isPopular(n, o.sh.memberCount) ? h('span', { id: 'shPopular', class: 'sh-tag sh-popular', text: '人気' }) : null,
        mine
          ? h('button', { id: 'shLike', class: 'sh-btn', type: 'button', disabled: true, text: 'あなたの投稿です（いいねは数えません）' })
          : h('button', { id: 'shLike', class: 'sh-btn' + (liked ? ' primary' : ''), type: 'button', text: liked ? '♥ いいね済み（押すと取り消し）' : '♡ いいね', onclick: toggle })));
      wrap.appendChild(msg);
      wrap.appendChild(h('p', { id: 'shLikeNote', class: 'sh-sub', text: rankedText(o.sh) + '。' + LIKE_NOTE }));
    }
    async function toggle(ev) {
      const b = ev.currentTarget; b.disabled = true; say(msg, '');
      const on = !lk.nids[e.id];
      const r = await A.setLike({ sid, uid: me.uid, pid: e.id, on, exists: lk.exists });
      if (expired(r)) return;
      if (!r.ok) { paint(); return say(msg, r.code === 'denied' ? 'いいねできませんでした（この棚のメンバーでなくなった可能性があります）。' : r.message); }
      if (on) lk.nids[e.id] = true; else delete lk.nids[e.id];
      lk.exists = true;
      paint();
    }
    paint();
    return wrap;
  }
  /** ノート形式の投稿：中身（JSON）を読み、検査して、自前の表示で出す（Google のプレビューは使わない） */
  async function showNote(e, box, t) {
    const r = await D.readText(e.driveId, M.MAX_POST_BYTES);
    if (t !== view) return;
    box.textContent = '';
    const note = r.ok ? M.parseNoteDoc(r.text) : null;
    if (!note || !note.ok) {
      box.appendChild(h('p', { id: 'shPostProblem', class: 'sh-msg', role: 'alert', text: r.ok ? note.error : V.problem('read') }));
      box.appendChild(h('button', { id: 'shPostRetry', class: 'sh-btn', type: 'button', text: 'もう一度読み込む', onclick: () => { box.textContent = ''; box.appendChild(h('p', { class: 'sh-loading', text: 'ノートを読み込んでいます…' })); showNote(e, box, t); } }));
      return;
    }
    box.appendChild(h('div', { id: 'shNoteWrap', class: 'sh-card sh-notecard' }, N.render(note)));
  }

  /** ドライブの実際のファイル情報を確かめ、合っていればプレビューを出す（合わなければ理由を出す） */
  async function checkPost(e, box, t) {
    const r = await D.inspect(e.driveId);
    if (t !== view) return;
    box.textContent = '';
    const st = !r.ok ? 'error' : (M.checkDriveMeta(e, r.meta).reason || 'ok');
    if (st === 'ok' && e.kind === 'note') return showNote(e, box, t);
    if (st === 'ok') {
      box.appendChild(V.previewFrame(h, e));
      box.appendChild(h('p', { class: 'sh-sub', text: 'プレビューが出ないとき・表示が崩れるときは、ダウンロードで開いてください。' }));
      box.appendChild(V.links(h, e));
      return;
    }
    box.appendChild(h('p', { id: 'shPostProblem', class: 'sh-msg', role: 'alert', text: V.problem(st) }));
    if (st === 'error') {
      box.appendChild(h('button', { id: 'shPostRetry', class: 'sh-btn', type: 'button', text: 'もう一度確かめる', onclick: () => { box.textContent = ''; box.appendChild(h('p', { class: 'sh-loading', text: 'ファイルを確かめています…' })); checkPost(e, box, t); } }));
    }
  }

  /** いいねの集計（管理者）：棚を開いたとき、前回から7日以上たっていれば自動で行う。「今すぐ集計」でいつでも */
  const autoTallied = {};
  function tallyCard(sid, sh, redraw) {
    const msg = h('p', { id: 'shTallyMsg', class: 'sh-msg', hidden: true, role: 'alert' });
    if (lastTally) { say(msg, lastTally, true); lastTally = ''; }
    const btn = h('button', { id: 'shTallyNow', class: 'sh-btn', type: 'button', text: '今すぐ集計する' });
    async function run(auto) {
      btn.disabled = true; say(msg, auto ? '前回の集計から1週間以上たっているため、いいねを集計しています…' : 'いいねを集計しています…', true);
      const r = await A.runTally(sid);
      if (expired(r)) return;
      if (!r.ok) { btn.disabled = false; return say(msg, '集計できませんでした：' + r.message); }
      lastTally = '集計しました（いいねした人 ' + r.likers + ' 人・数が変わったフォルダ ' + r.changed + '）。';
      delete cache.shelf[sid];
      redraw(true);
    }
    btn.addEventListener('click', () => run(false));
    if (M.tallyDue(sh.rankedAt, Date.now()) && !autoTallied[sid]) { autoTallied[sid] = true; setTimeout(() => run(true), 0); }
    return h('div', { id: 'shTallyCard', class: 'sh-card' }, h('h2', { text: 'いいねの集計' }),
      h('p', { id: 'shTallyLast', class: 'sh-sub', text: rankedText(sh) + '。数は、1週間に1回、管理者の端末（この画面）で集計します。棚を開いたとき、前回から7日以上たっていれば、自動で集計します。' }), msg, btn);
  }

  /* ---------- 管理者の画面（段階5）：棚の名前・ルール／招待コード／メンバー／通報／棚の削除 ---------- */
  const adminHref = (sid) => '#/s/' + sid + '/admin';
  async function showAdmin(sid, t) {
    page(h('p', { class: 'sh-loading', text: '読み込んでいます…' }));
    const [base] = await Promise.all([loadShelf(sid, true), loadShelves(false)]);
    if (t !== view) return;
    const sh = base.sh, mem = base.mem;
    if (expired(sh) || expired(mem)) return;
    if (!sh.ok) return showFatal(sh.message, route);
    if (!sh.exists) return page(h('h1', { class: 'sh-h', text: 'この棚は、見つかりません' }), h('p', { class: 'sh-lead' }, linkTo('#/', '棚の一覧に戻る')));
    if (!mem.ok) return showFatal(mem.message, route);
    if (!mem.exists || mem.banned || mem.role !== 'admin') {
      return page(h('h1', { id: 'shNotAdmin', class: 'sh-h', text: '管理者の画面' }), note('この画面は、この棚の管理者だけが使えます。', true), h('p', { class: 'sh-lead' }, linkTo(folderHref(sid, 'root'), '棚に戻る')));
    }
    const membersBox = h('div', { id: 'shMembersBox' }, h('p', { class: 'sh-sub', text: '読み込んでいます…' }));
    const reportsBox = h('div', { id: 'shReportsBox' }, h('p', { class: 'sh-sub', text: '読み込んでいます…' }));
    inShell({ sid, name: sh.name, back: { href: folderHref(sid, 'root'), text: sh.name }, crumbs: [{ href: folderHref(sid, 'root'), text: sh.name }, { text: '管理者の画面' }], title: '管理者の画面', titleId: 'shAdminTitle' }, [
      infoCard(sid, sh), inviteCard(sid, sh, mem),
      h('div', { class: 'sh-card' }, h('h2', { text: 'メンバー' }), membersBox),
      h('div', { class: 'sh-card' }, h('h2', { text: '通報された投稿' }), reportsBox),
      dangerCard(sid, sh, mem)]);
    const mr = await A.listMembers(sid);
    if (t !== view || expired(mr)) return;
    membersBox.textContent = '';
    if (!mr.ok) membersBox.appendChild(h('p', { class: 'sh-msg', role: 'alert', text: mr.message }));
    else drawMembers(sid, mr.members, membersBox, t);
    const nick = {}; (mr.ok ? mr.members : []).forEach((m) => { nick[m.uid] = m.nick; });
    const rr = await A.listReports(sid);
    if (t !== view || expired(rr)) return;
    reportsBox.textContent = '';
    if (!rr.ok) reportsBox.appendChild(h('p', { class: 'sh-msg', role: 'alert', text: rr.message }));
    else drawReports(sid, rr.reports, nick, reportsBox);
  }

  function infoCard(sid, sh) {
    const msg = msgBox('shInfoMsg');
    const nameIn = h('input', { id: 'shInfoName', type: 'text', value: sh.name, autocomplete: 'off', maxlength: 200 });
    const rules = h('textarea', { id: 'shInfoRules', rows: 8 }); rules.value = sh.rules;
    const form = h('form', { novalidate: true }, h('div', { class: 'sh-field' }, h('label', { for: 'shInfoName', text: '棚の名前' }), nameIn),
      h('div', { class: 'sh-field' }, h('label', { for: 'shInfoRules', text: '棚のルール（参加するとき、全員に表示されます）' }), rules,
        h('p', { class: 'sh-hint', text: '強制力はありませんが、違反があった場合は、管理者が対応します。' })), msg,
      h('button', { id: 'shInfoSave', class: 'sh-btn primary', type: 'submit', text: '保存する' }));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = M.checkShelfName(nameIn.value); if (!n.ok) return say(msg, n.error);
      const ru = M.checkRulesText(rules.value); if (!ru.ok) return say(msg, ru.error);
      const btn = $('shInfoSave'); busy(btn, true, '保存しています…'); say(msg, '');
      const r = await A.updateShelfInfo({ sid, name: n.name, rules: ru.rules });
      if (expired(r)) return;
      busy(btn, false, '保存する');
      if (!r.ok) return say(msg, r.code === 'denied' ? '保存できませんでした（管理者だけが変えられます）。' : r.message);
      sh.name = n.name; sh.rules = ru.rules; joinedNames[sid] = n.name; delete cache.shelf[sid];
      A.syncJoinedName(me.uid, sid, n.name);
      say(msg, '保存しました。ほかのメンバーの一覧の名前は、その人が棚を開いたときに、新しくなります。', true);
    });
    return h('div', { id: 'shInfoCard', class: 'sh-card' }, h('h2', { text: '棚の名前とルール' }), form);
  }

  function inviteCard(sid, sh, mem) {
    const card = h('div', { id: 'shAdminInvite', class: 'sh-card' });
    const msg = msgBox('shInviteMsg');
    function show() {
      card.textContent = '';
      card.appendChild(h('h2', { text: '招待コード' }));
      if (!mem.code) { card.appendChild(h('p', { class: 'sh-sub', text: '招待コードが見つかりません。作り直してください。' })); } else {
        card.appendChild(h('p', { class: 'sh-sub', text: '友達に伝えて、参加してもらいます。' }));
        inviteBlock(sh.name, mem.code).forEach((n) => card.appendChild(n));
      }
      card.appendChild(msg);
      card.appendChild(h('button', { id: 'shRegen', class: 'sh-btn', type: 'button', text: '新しいコードに作り直す', onclick: confirmRegen }));
    }
    function confirmRegen() {
      card.appendChild(h('div', { id: 'shRegenConfirm', class: 'sh-confirm' },
        h('p', { class: 'sh-sub', text: '作り直すと、いまのコードでは、新しく参加できなくなります（いま参加している人は、そのままです）。LINE に貼ったコードも、新しいものに替えてください。' }),
        h('div', { class: 'sh-row' },
          h('button', { id: 'shRegenGo', class: 'sh-btn sm danger', type: 'button', text: '作り直す', onclick: async (ev) => {
            const b = ev.currentTarget; busy(b, true, '作り直しています…');
            const r = await A.regenInvite({ sid, uid: me.uid, oldCode: mem.code });
            if (expired(r)) return;
            if (!r.ok) { busy(b, false, '作り直す'); return say(msg, r.code === 'denied' ? '作り直せませんでした（管理者だけができます）。' : r.message); }
            mem.code = r.code; delete cache.shelf[sid];
            show(); say(msg, '新しい招待コードにしました。', true);
          } }),
          h('button', { class: 'sh-btn sm', type: 'button', text: 'やめる', onclick: show }))));
      $('shRegen').hidden = true;
    }
    show();
    return card;
  }

  function drawMembers(sid, members, box, t) {
    box.textContent = '';
    box.appendChild(h('p', { id: 'shMemberCount', class: 'sh-sub', text: members.length + '人（締め出すと、その人は、この棚の中身を見られず、投稿もできなくなります）' }));
    const msg = msgBox('shMembersMsg');
    box.appendChild(h('ul', { id: 'shMembers', class: 'sh-list' }, members.map((m) => {
      const self = m.uid === me.uid;
      const li = h('li', { 'data-uid': m.uid },
        h('div', { class: 'sh-item' }, h('span', null, h('b', { class: 'sh-fname', text: m.nick || '（名前なし）' }), h('small', { text: '参加 ' + M.fmtDay(m.joined) })),
          h('span', null, m.role === 'admin' ? h('span', { class: 'sh-tag admin', text: '管理者' }) : null, m.banned ? h('span', { class: 'sh-tag edit-no', text: '締め出し中' }) : null)));
      if (!self && m.role !== 'admin') {
        li.appendChild(h('div', { class: 'sh-actions' }, h('button', { class: 'sh-btn sm ' + (m.banned ? 'sh-unban' : 'sh-ban danger'), type: 'button', text: m.banned ? '締め出しを解除' : '締め出す', onclick: async (ev) => {
          const b = ev.currentTarget; busy(b, true, '処理しています…'); say(msg, '');
          const r = await A.setBanned(sid, m.uid, !m.banned);
          if (expired(r)) return;
          if (!r.ok) { busy(b, false, m.banned ? '締め出しを解除' : '締め出す'); return say(msg, r.message); }
          m.banned = !m.banned;
          drawMembers(sid, members, box, t);
        } })));
      }
      return li;
    })));
    box.appendChild(msg);
  }

  function drawReports(sid, reports, nick, box) {
    box.textContent = '';
    if (!reports.length) return box.appendChild(h('p', { id: 'shReportsEmpty', class: 'sh-sub', text: '通報は、ありません。' }));
    const msg = msgBox('shReportsMsg');
    box.appendChild(h('ul', { id: 'shReports', class: 'sh-list' }, reports.map((rp) => {
      const li = h('li', { 'data-rid': rp.id });
      const show = () => {
        li.textContent = '';
        li.appendChild(h('div', { class: 'sh-item' }, h('span', null, h('b', { class: 'sh-fname', text: rp.name }), h('small', { class: 'sh-meta', text: M.fmtDay(rp.created) + '　通報した人：' + (nick[rp.reporter] || '（不明）') }), h('small', { class: 'sh-meta sh-reason', text: '理由：' + rp.reason }))));
        li.appendChild(h('div', { class: 'sh-actions' },
          h('a', { class: 'sh-btn sm sh-rp-view', href: postHref(sid, rp.fid, rp.pid), text: '投稿を見る' }),
          h('button', { class: 'sh-btn sm danger sh-rp-del', type: 'button', text: '投稿を削除', onclick: askDelete }),
          h('button', { class: 'sh-btn sm sh-rp-dismiss', type: 'button', text: '通報だけ消す', onclick: dismiss })));
      };
      async function dismiss(ev) {
        const b = ev.currentTarget; busy(b, true, '…');
        const r = await A.deleteReport(sid, rp.id);
        if (expired(r)) return;
        if (!r.ok) { busy(b, false, '通報だけ消す'); return say(msg, r.message); }
        li.remove(); if (!box.querySelector('#shReports li')) drawReports(sid, [], nick, box);
      }
      function askDelete() {
        li.textContent = '';
        li.appendChild(h('div', { class: 'sh-confirm' }, h('p', { class: 'sh-sub', text: '「' + rp.name + '」を、この棚の一覧から消し、この通報も消します。ファイルは、投稿者のドライブに残ります。' }),
          h('div', { class: 'sh-row' }, h('button', { class: 'sh-btn sm danger sh-rp-delgo', type: 'button', text: '消す', onclick: async (ev) => {
            const b = ev.currentTarget; busy(b, true, '消しています…');
            const r = await A.removeEntry({ sid, parent: rp.fid, id: rp.pid });
            if (expired(r)) return;
            if (!r.ok && r.code !== 'denied' && r.code !== 'notfound') { busy(b, false, '消す'); return say(msg, r.message); }   // すでに無い投稿は、通報だけ消す
            const r2 = await A.deleteReport(sid, rp.id);
            if (expired(r2)) return;
            if (!r2.ok) { busy(b, false, '消す'); return say(msg, r2.message); }
            li.remove(); if (!box.querySelector('#shReports li')) drawReports(sid, [], nick, box);
          } }), h('button', { class: 'sh-btn sm', type: 'button', text: 'やめる', onclick: show }))));
      }
      show();
      return li;
    })));
    box.appendChild(msg);
  }

  function dangerCard(sid, sh, mem) {
    const msg = msgBox('shDeleteMsg');
    const agree = h('input', { id: 'shDeleteAgree', type: 'checkbox' });
    const goBtn = h('button', { id: 'shDeleteGo', class: 'sh-btn danger', type: 'button', text: 'この棚を削除する' });
    goBtn.addEventListener('click', async () => {
      if (!agree.checked) return say(msg, '内容を確かめて、チェックを入れてください。');
      busy(goBtn, true, '消しています…（時間がかかることがあります）'); say(msg, '');
      const r = await A.deleteShelf({ sid, uid: me.uid, code: mem.code });
      if (expired(r)) return;
      if (!r.ok) { busy(goBtn, false, 'この棚を削除する'); return say(msg, '削除できませんでした：' + r.message + '（途中まで消えている場合は、もう一度押してください）'); }
      delete cache.shelf[sid]; delete cache.folders[sid]; delete joinedNames[sid]; shelves = null;
      flash = '「' + sh.name + '」を削除しました。';
      go('#/');
    });
    return h('div', { id: 'shDangerCard', class: 'sh-card' }, h('h2', { text: '棚の削除' }),
      h('p', { class: 'sh-sub', text: '棚と、中のフォルダ・投稿の一覧・いいね・通報・メンバーを、すべて消します。元に戻せません。ファイルは、それぞれの投稿者のドライブに残ります。ほかのメンバーの一覧には、開くまで残りますが、開くと外せます。' }),
      h('label', { class: 'sh-check' }, agree, h('span', { text: '「' + sh.name + '」を削除してよいことを、確かめました' })), msg, goBtn);
  }

  /** 棚から抜ける（管理者以外）。自分の投稿は、棚に残る */
  function leaveCard(sid, sh) {
    const card = h('div', { id: 'shLeaveCard', class: 'sh-card' });
    const msg = msgBox('shLeaveMsg');
    function show() {
      card.textContent = '';
      card.appendChild(h('h2', { text: 'この棚から抜ける' }));
      card.appendChild(h('p', { class: 'sh-sub', text: '参加の記録と、自分のいいねが消えます。自分の投稿は、棚に残ります（消したいときは、先に、自分の投稿を削除してください）。' }));
      card.appendChild(msg);
      card.appendChild(h('button', { id: 'shLeave', class: 'sh-btn', type: 'button', text: '抜ける…', onclick: confirm }));
    }
    function confirm() {
      card.textContent = '';
      card.appendChild(h('h2', { text: 'この棚から抜ける' }));
      card.appendChild(h('div', { id: 'shLeaveConfirm', class: 'sh-confirm' },
        h('p', { class: 'sh-sub', text: '「' + sh.name + '」から抜けます。もう一度入るには、管理者から、招待コードを教えてもらう必要があります。' }), msg,
        h('div', { class: 'sh-row' },
          h('button', { id: 'shLeaveGo', class: 'sh-btn sm danger', type: 'button', text: '抜ける', onclick: async (ev) => {
            const b = ev.currentTarget; busy(b, true, '処理しています…');
            const r = await A.leaveShelf({ sid, uid: me.uid });
            if (expired(r)) return;
            if (!r.ok) { busy(b, false, '抜ける'); return say(msg, r.code === 'denied' ? '抜けられませんでした（管理者は、棚を削除するしかありません）。' : r.message); }
            delete cache.shelf[sid]; delete cache.folders[sid]; delete joinedNames[sid]; shelves = null;
            flash = '「' + sh.name + '」から抜けました。';
            go('#/');
          } }),
          h('button', { class: 'sh-btn sm', type: 'button', text: 'やめる', onclick: show }))));
    }
    show();
    return card;
  }

  /* ---------- アカウントの削除（段階7） ---------- */
  async function showAccount(t) {
    page(h('p', { class: 'sh-loading', text: '読み込んでいます…' }));
    const r = await A.myShelves(me.uid);
    if (t !== view || expired(r)) return;
    if (!r.ok) return showFatal(r.message, route);
    shelves = r.shelves;
    const roles = await Promise.all(r.shelves.map((s) => A.getMember(s.sid, me.uid)));
    if (t !== view) return;
    const rows = r.shelves.map((s, i) => ({ s, m: roles[i] }));
    const admins = rows.filter((x) => x.m.ok && x.m.exists && x.m.role === 'admin');
    const msg = msgBox('shAccountMsg');
    const agree = h('input', { id: 'shAccountAgree', type: 'checkbox' });
    const goBtn = h('button', { id: 'shAccountGo', class: 'sh-btn danger', type: 'button', text: 'アカウントを削除する', disabled: admins.length > 0 });
    goBtn.addEventListener('click', async () => {
      if (!agree.checked) return say(msg, '内容を確かめて、チェックを入れてください。');
      // 先に、パスワードでログインし直す（Firebase は、アカウントの削除に、直近のパスワードでのログインを求める）。ここで失敗したら、何も消さない
      const c = M.checkLoginId($('shAccountId').value); if (!c.ok) return say(msg, c.error);
      const pw = $('shAccountPw').value; if (!pw) return say(msg, 'パスワードを入れてください。');
      busy(goBtn, true, '確かめています…'); say(msg, '');
      const re = await AU.reauth(c.id, pw);
      if (!re.ok) { busy(goBtn, false, 'アカウントを削除する'); if (re.code === 'login') { expired(re); return; } return say(msg, re.error); }
      busy(goBtn, true, '消しています…');
      for (const x of rows) {
        const rr = x.m.ok && x.m.exists ? await A.leaveShelf({ sid: x.s.sid, uid: me.uid }) : await A.dropJoined(me.uid, x.s.sid);   // 抜ける（棚がすでに無い場合は、一覧から外すだけ）
        if (expired(rr)) return;
        if (!rr.ok && rr.code !== 'notfound') { busy(goBtn, false, 'アカウントを削除する'); return say(msg, '「' + x.s.name + '」から抜けられませんでした：' + rr.message); }
      }
      const pr = await A.deleteProfile(me.uid);
      if (expired(pr)) return;
      if (!pr.ok && pr.code !== 'notfound') { busy(goBtn, false, 'アカウントを削除する'); return say(msg, 'プロフィールを消せませんでした：' + pr.message); }
      const ar = await AU.deleteAccount();
      if (!ar.ok) { busy(goBtn, false, 'アカウントを削除する'); return say(msg, ar.error); }
      me = null; pending = ''; cache.shelf = {}; cache.folders = {}; shelves = null;
      flash = 'アカウントを削除しました。';
      go('#/');
    });
    inShell({ sid: null, back: { href: '#/', text: '棚' }, crumbs: [], title: 'アカウントを削除する', titleId: 'shAccountTitle' }, [
      h('div', { class: 'sh-card' }, h('h2', { text: '消えるもの' }),
        h('p', { class: 'sh-sub', text: '参加しているすべての棚から抜け、表示名（プロフィール）とログインのアカウントが消えます。元に戻せません。自分の投稿は、棚に残ります（消したい場合は、先に削除してください）。ドライブのファイルは、あなたのドライブに残ります。' }),
        r.shelves.length ? h('ul', { id: 'shAccountShelves', class: 'sh-list' }, rows.map((x) => h('li', null, h('div', { class: 'sh-item' }, h('span', null, h('b', { text: x.s.name })), h('span', { class: 'sh-tag' + (x.m.ok && x.m.exists && x.m.role === 'admin' ? ' admin' : ''), text: x.m.ok && x.m.exists ? (x.m.role === 'admin' ? '管理者' : 'メンバー') : '（棚が無い）' }))))) : h('p', { class: 'sh-sub', text: '参加している棚は、ありません。' })),
      admins.length ? note('管理者になっている棚があります（' + admins.map((x) => '「' + x.s.name + '」').join('') + '）。先に、その棚を削除してください（棚の「管理者の画面」の一番下）。', true, 'shAccountAdminNote') : null,
      h('div', { id: 'shAccountReauth', class: 'sh-card' }, h('h2', { text: '確認のため、ログインし直します' }),
        h('p', { class: 'sh-sub', text: 'アカウントを消すときは、安全のため、直前に、ログインIDとパスワードで、ログインし直す決まりです。入れたあと、下のボタンを押すと、すぐに消えます。' }),
        fld('shAccountId', 'ログインID', { autocomplete: 'username' }),
        fld('shAccountPw', 'パスワード', { type: 'password', autocomplete: 'current-password' })),
      h('label', { class: 'sh-check' }, agree, h('span', { text: '内容を確かめました（パスワードを忘れても、復旧できません）' })), msg, goBtn]);
  }

  /** 管理者の設定（棚の最上位に出す） */
  function settingsCard(sid, sh) {
    const msg = msgBox('shOpenMsg');
    const cb = h('input', { id: 'shOpen', type: 'checkbox', checked: sh.open });
    cb.addEventListener('change', async () => {
      cb.disabled = true; say(msg, '');
      const r = await A.setOpen(sid, cb.checked);
      cb.disabled = false;
      if (expired(r)) return;
      if (!r.ok) { cb.checked = !cb.checked; return say(msg, r.message); }
      delete cache.shelf[sid];
      say(msg, cb.checked ? 'メンバーも、フォルダを作れるようにしました。' : 'フォルダを作れるのは、管理者だけにしました。', true);
    });
    return h('div', { id: 'shSettings', class: 'sh-card' }, h('h2', { text: '管理者の設定' }),
      h('label', { class: 'sh-check' }, cb, h('span', { text: 'メンバーも、フォルダを作れるようにする' })), msg);
  }

  /* ---------- 起動 ---------- */
  U._test = { route, go, refresh: () => { if (cur) showShelf(cur.sid, cur.fid, nav(), true, cur.pid); } };   // refresh＝「更新」と同じ（覚えている文書を捨てて、読み直す）
  root.addEventListener('hashchange', route);
  $('dlg').addEventListener('close', () => {
    if ($('dlg').open) return;   // 閉じてすぐ開き直したときの、古い close は、無視する
    const f = dlgState.onClose; dlgState.onClose = null;
    $('dlg').textContent = '';   // 中身は、閉じたら捨てる（同じ ID の部品が、画面に残らないように）
    if (f) f();
  });
  let resizeTimer = 0;
  root.addEventListener('resize', () => { root.clearTimeout(resizeTimer); resizeTimer = root.setTimeout(() => { if (cur) paintCols(); }, 150); });   // 画面の幅が変わったら、開いておく列の数を決め直す
  if (LN.theme) LN.theme.onLayoutChange = () => { route(); };   // パソコン用 ⇄ スマホ用が切り替わったら、描き直す
  (async function start() { await AU.restore(); route(); })();
})(window);
