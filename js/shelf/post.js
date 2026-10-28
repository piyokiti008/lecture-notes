/* 棚への投稿（段階3。index.html）。メニューの「棚に投稿」と、棚のページの「ここに投稿する」（#/post/棚のID/フォルダのID）から開く。
 *  流れ：Google ログイン（ドライブに保存するため。js/cloud.js）→ 棚のログイン（ログインID＋パスワード）→ 棚とフォルダを選ぶ → ファイル・タイトル・編集の扱い → ルールに同意して投稿。
 *  投稿の手順：①ファイルの種類・大きさ・中身を確かめる ②自分のドライブの「講義ノート」フォルダにファイルを作る ③「リンクを知る人は閲覧可」にする ④棚のフォルダに登録する。
 *             ③か④に失敗したら、②のファイルを消す（公開したまま、棚に載らないファイルを残さない）。
 *  「自分の投稿の管理」：このアプリが棚用に作ったドライブのファイルの一覧。「取り下げて削除」で、ドライブから消し（公開も止まる）、棚の一覧からも消す（棚にログインしているとき）。
 *  利用者が決めた文字（棚の名前・フォルダの名前・ルール）は信用できないので、必ず textContent で入れる。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = LN.shelf, M = S.model, AU = S.auth, A = S.api, D = S.drive;
  const doc = root.document;
  const P = (LN.post = LN.post || {});
  P.cfg = Object.assign({ shelfUrl: 'shelf.html', access: null }, P.cfg);   // access：テスト用。Google ドライブの口（cloud.js の driveAccess）の代わり
  let U = null, current = null;

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
  const msgBox = (id) => h('p', { id: id || 'pstMsg', class: 'pst-msg', hidden: true, role: 'alert' });
  const field = (label, input) => h('div', { class: 'dlg-field' }, h('label', { class: 'l', for: input.id, text: label }), input);
  const G = () => P.cfg.access || (LN.cloud && LN.cloud.driveAccess) || null;
  const abs = (rel) => new URL(rel, root.location.href).href;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  P.isOpen = () => !!current;   // テスト用：いま、投稿のダイアログを開いているか
  P.driveAccess = () => G();   // Google ドライブの口（共同編集を終わりにして、派生版を出すときに、「講義ノート」フォルダを使う）
  /** ドライブの書き込み用トークン（切れていたら、再接続を試みる）。Google にログインしていなければ null（共同編集を「終わりにする」ときに使う） */
  P.driveToken = async function () {
    const g = G();
    if (!g || !g.enabled || !g.enabled()) return null;
    let t = g.token();
    if (!t && g.reconnect) { try { await g.reconnect(); } catch (e) { /* 下で null */ } t = g.token(); }
    return t || null;
  };

  P.init = function (ui) {
    U = ui;
    ui.actions['post-open'] = () => P.open({});
    ui.actions['post-manage'] = () => P.open({ manage: true });
  };
  /** 画面を描いたあとに呼ぶ：#/post/… で開かれていたら、投稿のダイアログを開く */
  P.start = function () {
    const go = () => { const t = M.parsePostTo(root.location.hash); if (t) P.open(t); };
    root.addEventListener('hashchange', go);
    go();
  };

  /** 投稿のダイアログを開く。target＝{ sid, fid }（投稿先の指定）か { manage:true }。閉じたら解決する Promise を返す */
  P.open = function (target) {
    if (!U || current) return Promise.resolve();
    const dlg = doc.getElementById('dlg');
    const st = { tab: target && target.manage ? 'manage' : target && target.import ? 'import' : 'post', imp: target && target.import ? target.import : null, src: 'file', target: target || {}, me: null, shelves: null, sh: null, dest: null, pick: null, file: null, working: false, onEnter: null, done: null, note: '' };
    let rootEl = null, closeDlg = null, seq = 0;
    // Enter キーでダイアログが閉じてしまわないよう、送信は、ここで止める（必要な画面だけ、onEnter で受ける）
    const trap = (e) => { if (!rootEl) return; e.preventDefault(); e.stopPropagation(); if (st.onEnter && !st.working) st.onEnter(); };
    dlg.addEventListener('submit', trap, true);
    const alive = (n) => !!rootEl && rootEl.isConnected && n === seq;

    const closed = U.ask({
      title: st.tab === 'import' ? 'ノートを取り込む' : '棚に投稿', wide: true, hideOk: true, cancelText: '閉じる', body: '<div id="pstRoot" class="pst"></div>',
      onOpen(form, finish) { rootEl = form.querySelector('#pstRoot'); closeDlg = finish; draw(); },
    });
    current = st;
    closed.then(() => {
      dlg.removeEventListener('submit', trap, true); current = null; rootEl = null; seq++;
      if (/^#\/post/.test(root.location.hash)) { try { root.history.replaceState(null, '', root.location.pathname + root.location.search); } catch (e) { /* そのままでよい */ } }
    });

    /* ---------- 画面の骨組み ---------- */
    async function draw() {
      if (!rootEl) return;
      const n = ++seq;
      st.onEnter = null;
      rootEl.textContent = '';
      const body = h('div', { id: 'pstBody' });
      if (st.tab === 'import') { rootEl.appendChild(body); return drawImport(body, n); }   // 取り込みは、Google のログインが要らない（公開されたノートを読むだけ）
      rootEl.appendChild(h('div', { class: 'pst-tabs' },
        h('button', { id: 'pstTabPost', type: 'button', class: 'btn sm' + (st.tab === 'post' ? ' primary' : ''), disabled: st.working, onclick: () => { st.tab = 'post'; draw(); }, text: '投稿する' }),
        h('button', { id: 'pstTabManage', type: 'button', class: 'btn sm' + (st.tab === 'manage' ? ' primary' : ''), disabled: st.working, onclick: () => { st.tab = 'manage'; draw(); }, text: '自分の投稿の管理' })));
      rootEl.appendChild(h('p', { class: 'pst-guide' }, h('a', { href: 'guide.html#shelf', target: '_blank', rel: 'noopener', text: '画像つきの使い方（棚へのログインと投稿の流れ）を見る' })));
      rootEl.appendChild(body);
      if (!googleReady(body)) return;
      if (st.tab === 'manage') return drawManage(body, n);
      if (st.done) return drawDone(body);
      if (st.pick) return drawPicker(body, n);
      await drawPost(body, n);
    }

    /* ---------- Google ログイン（ドライブに保存するため） ---------- */
    function googleReady(body) {
      const g = G();
      if (!g || !g.enabled()) {
        const msg = msgBox('pstGoogleMsg');
        body.appendChild(h('div', { class: 'bk-box', id: 'pstGoogleGate' },
          h('b', { text: 'Google でのログインが必要です。' }), h('br'),
          '投稿するファイルは、あなたの Google ドライブに置かれます（運営のサーバーには置きません）。使う権限は「このアプリが作ったファイルだけ」です。'));
        body.appendChild(msg);
        body.appendChild(h('button', { id: 'pstGoogleLogin', type: 'button', class: 'btn primary', text: 'Google でログイン', onclick: async () => {
          closeDlg(); await closed;
          let ok = false; try { ok = !!(LN.cloud && (await LN.cloud.startLogin())); } catch (e) { ok = false; }
          if (!ok) U.toast('ログインできませんでした。もう一度お試しください');
          P.open(st.target);
        } }));
        return false;
      }
      if (!g.token()) {
        const msg = msgBox('pstGoogleMsg');
        body.appendChild(h('div', { class: 'bk-box warn', id: 'pstReconnectGate' }, h('b', { text: 'Google のログインが切れています。' }), h('br'), '（約1時間で切れます。ノートは、このブラウザに保存されています）'));
        body.appendChild(msg);
        body.appendChild(h('button', { id: 'pstReconnect', type: 'button', class: 'btn primary', text: '再接続', onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; say(msg, '');
          let ok = false; try { ok = await g.reconnect(); } catch (err) { ok = false; }
          if (ok) draw(); else { b.disabled = false; say(msg, '再接続できませんでした。ポップアップがブロックされていないか確かめて、もう一度押してください。'); }
        } }));
        return false;
      }
      return true;
    }

    /* ---------- 投稿する ---------- */
    async function drawPost(body, n) {
      if (!AU.uid()) { await AU.restore(); if (!alive(n)) return; }
      if (!AU.uid()) return drawShelfLogin(body);
      if (!st.me) {
        body.appendChild(h('p', { class: 'pst-sub', text: '読み込んでいます…' }));
        const pr = await A.getProfile(AU.uid());
        if (!alive(n)) return;
        if (!pr.ok && pr.code === 'login') { AU.signOut(); return draw(); }
        if (!pr.ok) return drawError(body, pr.message);
        if (!pr.exists) return drawError(body, '棚の表示名が、まだ決まっていません。先に、棚のページで決めてください。', true);
        if (pr.banned) return drawError(body, 'このアカウントは、利用停止中です。');
        st.me = { uid: AU.uid(), nick: pr.nick };
      }
      if (!st.shelves) {
        body.textContent = '';
        body.appendChild(h('p', { class: 'pst-sub', text: '棚の一覧を読み込んでいます…' }));
        const r = await A.myShelves(st.me.uid);
        if (!alive(n)) return;
        if (!r.ok) return drawError(body, r.message);
        st.shelves = r.shelves;
      }
      if (!st.shelves.length) return drawError(body, 'まだ、参加している棚がありません。棚のページで、招待コードから参加するか、棚を作ってください。', true);
      if (!st.dest) {
        body.textContent = '';
        body.appendChild(h('p', { class: 'pst-sub', text: '投稿先を確かめています…' }));
        const known = st.shelves.some((s) => s.sid === st.target.sid);
        if (st.target.sid && !known) st.note = 'リンクで指定された棚は、あなたが参加している棚の中にありません。ほかの棚が選ばれています。';
        const want = known ? st.target : { sid: st.shelves[0].sid, fid: 'root' };
        const ok = await setShelf(want.sid, want.fid || 'root', n);
        if (!alive(n)) return;
        if (!ok.ok) return drawError(body, ok.message);
      }
      body.textContent = '';
      drawForm(body, n);
    }

    function drawError(body, text, link) {
      body.textContent = '';
      body.appendChild(h('p', { id: 'pstError', class: 'pst-msg', role: 'alert', text }));
      body.appendChild(h('div', { class: 'pst-row' },
        h('button', { id: 'pstRetry', type: 'button', class: 'btn', text: 'もう一度試す', onclick: () => { st.dest = null; st.shelves = null; draw(); } }),
        link ? h('a', { id: 'pstShelfLink', class: 'btn', href: P.cfg.shelfUrl, target: '_blank', rel: 'noopener', text: '棚のページを開く' }) : null));
    }

    function drawShelfLogin(body) {
      const msg = msgBox();
      const idIn = h('input', { id: 'pstLoginId', type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false' });
      const pwIn = h('input', { id: 'pstLoginPw', type: 'password', autocomplete: 'current-password' });
      const keep = h('input', { id: 'pstKeep', type: 'checkbox', checked: true });
      const go = h('button', { id: 'pstLoginGo', type: 'button', class: 'btn primary', text: '棚にログイン' });
      async function login() {
        const c = M.checkLoginId(idIn.value); if (!c.ok) return say(msg, c.error);
        if (!pwIn.value) return say(msg, 'パスワードを入力してください。');
        go.disabled = true; go.textContent = 'ログインしています…'; say(msg, '');
        const r = await AU.signIn(c.id, pwIn.value, keep.checked);
        if (!rootEl) return;
        if (!r.ok) { go.disabled = false; go.textContent = '棚にログイン'; return say(msg, r.error); }
        draw();
      }
      go.addEventListener('click', login);
      st.onEnter = login;
      body.appendChild(h('div', { class: 'bk-box' }, h('b', { text: '棚のアカウントでログインしてください。' }), h('br'), '棚のページ（LINE の中でも開けます）で作ったログインIDとパスワードです。Google のアカウントとは別です。'));
      body.appendChild(field('ログインID', idIn)); body.appendChild(field('パスワード', pwIn));
      body.appendChild(h('label', { class: 'pst-check' }, keep, h('span', { text: 'この端末でログインを保つ' })));
      body.appendChild(msg);
      body.appendChild(h('div', { class: 'pst-row' }, go, h('a', { id: 'pstSignup', class: 'btn', href: P.cfg.shelfUrl + '#/signup', target: '_blank', rel: 'noopener', text: 'アカウントを作る（棚のページ）' })));
    }

    /** 棚と投稿先のフォルダを決め、棚のルールなどを読み込む */
    async function setShelf(sid, fid) {
      const [sh, mem] = await Promise.all([A.getShelf(sid), A.getMember(sid, st.me.uid)]);
      if (!sh.ok) return sh;
      if (!sh.exists) return { ok: false, message: 'その棚は、見つかりません。' };
      if (!mem.ok) return mem;
      if (!mem.exists || mem.banned) return { ok: false, message: 'この棚には、投稿できません（メンバーではないか、締め出されています）。' };
      const d = await resolveDest(sid, fid, sh.name);
      if (!d.ok) return d;
      st.sh = sh; st.dest = d;
      return { ok: true };
    }
    /** 投稿先のフォルダ → 最上位までの道筋（名前つき）を、親をさかのぼって調べる */
    async function resolveDest(sid, fid, shelfName) {
      let fo = await A.getFolder(sid, fid);
      if (!fo.ok) return fo;
      if (!fo.exists) { st.note = '指定されたフォルダが見つからないため、棚の最上位にしました。'; fid = 'root'; fo = await A.getFolder(sid, 'root'); if (!fo.ok || !fo.exists) return fo.ok ? { ok: false, message: '棚の最上位のフォルダが見つかりません。' } : fo; }
      const path = []; let cur = fid, doc0 = fo;
      for (let i = 0; i <= M.MAX_DEPTH && cur !== 'root'; i++) {
        const pd = await A.getFolder(sid, doc0.parent);
        if (!pd.ok || !pd.exists) break;
        const ent = pd.children.find((c) => c.id === cur && c.type === 'folder');
        path.unshift({ fid: cur, name: ent ? ent.name : '（フォルダ）' });
        cur = doc0.parent; doc0 = pd;
      }
      path.unshift({ fid: 'root', name: shelfName });
      return { ok: true, sid, fid, path, fo };
    }

    function drawForm(body, n) {
      const d = st.dest;
      const msg = msgBox();
      const shelfSel = h('select', { id: 'pstShelf' }, st.shelves.map((s) => h('option', { value: s.sid, text: s.name })));
      shelfSel.value = d.sid;
      shelfSel.addEventListener('change', () => { st.dest = null; st.target = { sid: shelfSel.value, fid: 'root' }; st.file = null; draw(); });
      const fileIn = h('input', { id: 'pstFile', type: 'file', accept: '.pdf,.docx,.xlsx,.pptx' });
      const fileInfo = h('p', { id: 'pstFileInfo', class: 'pst-sub' });
      const titleIn = h('input', { id: 'pstTitle', type: 'text', maxlength: '200', autocomplete: 'off', placeholder: '例：第3回 回帰分析のまとめ' });
      const agree = h('input', { id: 'pstAgree', type: 'checkbox' });
      const progress = h('p', { id: 'pstProgress', class: 'pst-sub', hidden: true });
      const go = h('button', { id: 'pstGo', type: 'button', class: 'btn primary', text: '投稿する' });
      const editVal = () => (rootEl.querySelector('input[name=pstEdit]:checked') || {}).value || 'no';
      fileIn.addEventListener('change', () => {
        const f = fileIn.files && fileIn.files[0];
        st.file = null; fileInfo.classList.remove('err'); fileInfo.textContent = '';
        if (!f) return;
        const c = M.checkPostFile(f);
        if (!c.ok) { fileIn.value = ''; fileInfo.classList.add('err'); fileInfo.textContent = c.error; return; }
        st.file = f;
        fileInfo.textContent = M.kindLabel(c.kind) + '（' + M.fmtSize(f.size) + '）';
        if (!titleIn.value.trim()) titleIn.value = M.titleFromFile(f.name);
      });
      // 投稿するもの：ファイル（Word・Excel・PowerPoint・PDF）か、このアプリのノート
      const notes = ((LN.state && LN.state.notes) || []).slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const subjName = (id) => { const s = ((LN.state && LN.state.subjects) || []).find((x) => x.id === id); return s ? s.name : '（教科なし）'; };
      const noteSel = h('select', { id: 'pstNoteSel' }, notes.length ? notes.map((x) => h('option', { value: x.id, text: subjName(x.subjectId) + ' › ' + (x.title || '無題のノート') })) : h('option', { value: '', text: '（ノートがありません）' }));
      const noteBox = h('div', { id: 'pstNoteBox', class: 'dlg-field', hidden: st.src !== 'note' }, h('label', { class: 'l', for: 'pstNoteSel', text: '投稿するノート（本文と、貼った画像を、そのまま投稿します）' }), noteSel);
      const fileBox = h('div', { id: 'pstFileBox', class: 'dlg-field', hidden: st.src === 'note' }, h('label', { class: 'l', for: 'pstFile', text: 'ファイル（Word・Excel・PowerPoint・PDF。20MB まで）' }), fileIn, fileInfo);
      const useNote = () => (rootEl.querySelector('input[name=pstSrc]:checked') || {}).value === 'note';
      // 取り込んだノート（出どころの印 origin がある）：編集OKの投稿が元なら、派生版として出せる。「編集しないで」が元なら、投稿できない
      const originBox = h('div', { id: 'pstOriginBox', class: 'dlg-field', hidden: true });
      const deriveCb = h('input', { id: 'pstDerive', type: 'checkbox', checked: true });
      const refreshOrigin = () => {
        originBox.textContent = ''; originBox.hidden = true;
        if (st.src !== 'note') return;
        const nt = notes.find((x) => x.id === noteSel.value), og = nt && M.checkOrigin(nt.origin);
        if (!og) return;
        originBox.hidden = false;
        if (og.edit === 'ok') originBox.appendChild(h('label', { class: 'pst-check' }, deriveCb, h('span', { id: 'pstDeriveText', text: '「' + og.title + '」（' + og.author + ' さんの投稿）の派生版として出す（元の投稿と同じフォルダに出ます）' })));
        else originBox.appendChild(h('p', { id: 'pstOriginNo', class: 'pst-msg', text: '元の投稿（' + og.author + ' さんの「' + og.title + '」）は「編集しないでほしい」です。取り込んだノートは、個人利用にとどめてください。このノートは、棚に投稿できません。' }));
      };
      const onSrc = () => {
        st.src = useNote() ? 'note' : 'file'; noteBox.hidden = st.src !== 'note'; fileBox.hidden = st.src === 'note';
        if (st.src === 'note') fillNoteTitle();
        refreshOrigin();
      };
      const fillNoteTitle = () => { const nt = notes.find((x) => x.id === noteSel.value); if (nt && !titleIn.value.trim()) titleIn.value = M.titleFromFile(nt.title || ''); };
      noteSel.addEventListener('change', () => { const nt = notes.find((x) => x.id === noteSel.value); if (nt) titleIn.value = M.titleFromFile(nt.title || ''); refreshOrigin(); });
      const derive = () => !!(rootEl.querySelector('#pstDerive') && rootEl.querySelector('#pstDerive').checked);
      go.addEventListener('click', () => submit({ msg, progress, go, titleIn, agree, editVal, n, useNote, noteSel, notes, derive }));

      body.appendChild(field('棚', shelfSel));
      body.appendChild(h('div', { class: 'dlg-field' }, h('label', { class: 'l', text: '投稿先のフォルダ' }),
        h('div', { class: 'pst-dest' }, h('span', { id: 'pstDest', class: 'pst-dest-path', text: d.path.map((p) => p.name).join(' › ') }),
          h('button', { id: 'pstDestChange', type: 'button', class: 'btn sm', text: '変える', onclick: () => { st.pick = { sid: d.sid, path: d.path.slice(), fo: d.fo }; draw(); } })),
        st.note ? h('p', { id: 'pstNote', class: 'pst-sub', text: st.note }) : null));
      body.appendChild(h('div', { class: 'dlg-field' }, h('label', { class: 'l', text: '投稿するもの' }),
        h('div', { class: 'pst-row' },
          h('label', { class: 'pst-radio' }, h('input', { id: 'pstSrcFile', type: 'radio', name: 'pstSrc', value: 'file', checked: st.src !== 'note', onchange: onSrc }), h('span', { text: 'ファイル' })),
          h('label', { class: 'pst-radio' }, h('input', { id: 'pstSrcNote', type: 'radio', name: 'pstSrc', value: 'note', checked: st.src === 'note', onchange: onSrc }), h('span', { text: 'このアプリのノート' })))));
      body.appendChild(fileBox); body.appendChild(noteBox); body.appendChild(originBox);
      refreshOrigin();
      body.appendChild(field('タイトル（棚に出る名前。80文字まで）', titleIn));
      body.appendChild(h('div', { class: 'dlg-field' }, h('label', { class: 'l', text: '編集の扱い' }),
        h('label', { class: 'pst-radio' }, h('input', { id: 'pstEditNo', type: 'radio', name: 'pstEdit', value: 'no', checked: true }), h('span', { text: '編集しないでほしい（取り込みは、個人利用だけ）' })),
        h('label', { class: 'pst-radio' }, h('input', { id: 'pstEditOk', type: 'radio', name: 'pstEdit', value: 'ok' }), h('span', { text: '編集OK（ほかの人が取り込んで直し、自分の版を出してよい）' }))));
      body.appendChild(h('div', { id: 'pstDriveNote', class: 'bk-box' }, 'ファイルは、あなたの Google ドライブの「講義ノート」フォルダに保存され、リンクを知っている人が見られる状態になります。リンクは棚のメンバー以外には表示されませんが、見られる状態であることには変わりません。削除すると、見られなくなります（「自分の投稿の管理」から削除できます）。'));
      body.appendChild(h('div', { class: 'dlg-field' }, h('label', { class: 'l', text: 'この棚のルール' }), h('div', { id: 'pstRules', class: 'pst-rules', text: st.sh.rules || '（管理者は、ルールを書いていません）' }),
        h('p', { class: 'pst-sub', text: 'ルールに強制力はありませんが、違反があった場合は、管理者が対応します。' })));
      body.appendChild(h('label', { class: 'pst-check' }, agree, h('span', { text: 'この棚のルールに同意して投稿する' })));
      body.appendChild(msg); body.appendChild(progress);
      body.appendChild(go);
    }

    /* ---------- 投稿先のフォルダを選ぶ ---------- */
    async function drawPicker(body, n) {
      const pk = st.pick, here = pk.path[pk.path.length - 1];
      const msg = msgBox('pstPickMsg');
      const goTo = async (fid, path) => {
        say(msg, '');
        const fo = await A.getFolder(pk.sid, fid);
        if (!alive(n)) return;
        if (!fo.ok || !fo.exists) return say(msg, fo.ok ? 'このフォルダは、見つかりません。' : fo.message);
        st.pick = { sid: pk.sid, path, fo }; draw();
      };
      const subs = M.sortEntries(pk.fo.children.filter((c) => c.type === 'folder'), 'name');
      body.appendChild(h('p', { class: 'pst-sub', text: '投稿先のフォルダを選びます。' }));
      body.appendChild(h('p', { id: 'pstPickPath', class: 'pst-dest-path', text: pk.path.map((p) => p.name).join(' › ') }));
      if (pk.path.length > 1) body.appendChild(h('button', { id: 'pstPickUp', type: 'button', class: 'btn sm', text: '↑ 上のフォルダへ', onclick: () => { const up = pk.path.slice(0, -1); goTo(up[up.length - 1].fid, up); } }));
      body.appendChild(h('div', { id: 'pstPickList', class: 'pst-pick' }, subs.length
        ? subs.map((c) => h('button', { type: 'button', class: 'btn pst-pick-item', 'data-fid': c.id, text: c.name, onclick: () => goTo(c.id, pk.path.concat([{ fid: c.id, name: c.name }])) }))
        : h('p', { class: 'pst-sub', text: 'このフォルダの中に、フォルダはありません。' })));
      body.appendChild(msg);
      body.appendChild(h('div', { class: 'pst-row' },
        h('button', { id: 'pstPickOk', type: 'button', class: 'btn primary', text: 'このフォルダに決める', onclick: () => { st.dest = { ok: true, sid: pk.sid, fid: here.fid, path: pk.path, fo: pk.fo }; st.pick = null; st.note = ''; draw(); } }),
        h('button', { id: 'pstPickCancel', type: 'button', class: 'btn', text: 'やめる', onclick: () => { st.pick = null; draw(); } })));
    }

    /* ---------- 投稿の実行 ---------- */
    function failure(message, code) { const e = new Error(message); e.pst = true; e.code = code; return e; }
    async function submit(o) {
      if (st.working) return;
      // 投稿するもの：ノート（本文と画像を JSON にする）か、ファイル
      let c, file, origin = null;
      if (o.useNote()) {
        const nt = o.notes.find((x) => x.id === o.noteSel.value);
        if (!nt) return say(o.msg, '投稿するノートを選んでください。');
        const og = M.checkOrigin(nt.origin);
        if (og && og.edit === 'no') return say(o.msg, '元の投稿の作者は「編集しないでほしい」を選んでいます。取り込んだこのノートは、棚に投稿できません。');
        if (og && o.derive()) origin = og;
        const text = JSON.stringify(M.buildNoteDoc(nt, LN.images || {}));
        file = new Blob([text], { type: 'application/json' });
        if (file.size > M.MAX_POST_BYTES) return say(o.msg, 'ノートが大きすぎます（' + M.fmtSize(file.size) + '。' + M.fmtSize(M.MAX_POST_BYTES) + 'まで）。貼った画像が多い場合は、減らしてください。');
        c = { ok: true, kind: 'note', mime: 'application/json' };
      } else {
        file = st.file;
        c = file ? M.checkPostFile(file) : null;
        if (!c) return say(o.msg, 'ファイルを選んでください。');
        if (!c.ok) return say(o.msg, c.error);
      }
      const t = M.checkPostTitle(o.titleIn.value); if (!t.ok) return say(o.msg, t.error);
      if (!o.agree.checked) return say(o.msg, 'この棚のルールに同意すると、投稿できます。');
      const g = G(); if (!g || !g.token()) return draw();
      const d = origin ? { sid: origin.sid, fid: origin.fid } : st.dest, edit = o.editVal();   // 派生版は、元の投稿と同じフォルダに出す
      st.working = true; say(o.msg, ''); o.go.disabled = true;
      rootEl.querySelectorAll('.pst-tabs button').forEach((b) => { b.disabled = true; });
      const step = (text) => { if (rootEl && rootEl.isConnected) { o.progress.hidden = false; o.progress.textContent = text; } };
      let created = null;
      try {
        if (c.kind !== 'note') {
          step('ファイルの中身を確かめています…');
          const sn = M.sniffPostFile(new Uint8Array(await file.arrayBuffer()), c.kind);
          if (!sn.ok) throw failure(sn.error);
        }
        step('投稿先を確かめています…');
        const fo = await A.getFolder(d.sid, d.fid);
        if (!fo.ok) throw failure(fo.message, fo.code);
        if (!fo.exists) throw failure('投稿先のフォルダが、見つかりません。消されたかもしれません。別のフォルダを選んでください。');
        if (fo.children.length >= M.MAX_CHILDREN) throw failure('このフォルダは、いっぱいです（' + M.MAX_CHILDREN + '件まで）。別のフォルダを選んでください。');
        if (origin) {
          const orig = fo.children.find((x) => x.id === origin.pid && x.type === 'post');
          if (!orig) throw failure('元の投稿が見つかりません（削除されたかもしれません）。「派生版として出す」のチェックを外すと、ふつうの投稿として出せます。');
          if (orig.edit !== 'ok') throw failure('元の投稿は、いまは「編集OK」ではないため、派生版にできません。');
        }
        step('Google ドライブに保存しています…');
        let folderId;
        try { folderId = await g.folderId(); } catch (e) { throw failure(e && e.status === 401 ? 'Google のログインが切れました。もう一度ログインしてください。' : 'ドライブの「講義ノート」フォルダを用意できませんでした。', e && e.status === 401 ? 'login' : ''); }
        const pid = M.newPostId();
        const up = await D.upload(g.token(), file, { name: M.driveFileName(t.title, c.kind), mime: c.mime, parents: [folderId], appProperties: { ln: 'post', sid: d.sid, fid: d.fid, pid } });
        if (!up.ok) throw failure(up.message, up.code);
        created = up.id;
        step('公開の設定をしています…');
        const sh = await D.share(g.token(), created);
        if (!sh.ok) throw failure('公開の設定ができなかったため、ファイルを消しました。' + sh.message, sh.code);
        step('棚に登録しています…');
        const ad = await A.addPost({ sid: d.sid, parent: d.fid, pid, uid: st.me.uid, nick: st.me.nick, name: t.title, driveId: created, kind: c.kind, mime: c.mime, size: file.size, edit, derivedFrom: origin ? origin.pid : '' });
        if (!ad.ok) throw failure('棚に登録できませんでした' + (ad.code === 'denied' ? '（この棚のメンバーでなくなったか、フォルダがいっぱいかもしれません）。' : '：' + ad.message), ad.code);
        created = null;   // 登録できたので、後始末は要らない
        st.done = { sid: d.sid, fid: d.fid, pid, title: t.title, kind: c.kind };
        st.file = null; st.working = false; st.src = 'file';
        if (rootEl && rootEl.isConnected) draw(); else U.toast('棚に投稿しました：' + t.title);
      } catch (e) {
        let extra = '';
        if (created) { const rm = await D.remove(g.token() || '', created).catch(() => ({ ok: false })); extra = rm.ok ? '' : '（ドライブに保存したファイルを消せませんでした。「自分の投稿の管理」で確認してください）'; }
        st.working = false;
        const text = (e && e.pst ? e.message : '投稿できませんでした：' + ((e && e.message) || '原因不明')) + extra;
        if (rootEl && rootEl.isConnected) {
          rootEl.querySelectorAll('.pst-tabs button').forEach((b) => { b.disabled = false; });
          o.go.disabled = false; o.progress.hidden = true; say(o.msg, text);
          if (e && e.code === 'login') { await sleep(1200); if (rootEl && rootEl.isConnected) draw(); }
        } else U.toast(text);
      }
    }

    function drawDone(body) {
      const dn = st.done;
      body.appendChild(h('div', { id: 'pstDone', class: 'bk-box' }, h('b', { text: '棚に投稿しました。' }), h('br'), '「' + dn.title + '」を、棚のフォルダに登録しました。ファイルは、あなたの Google ドライブにあります。'));
      body.appendChild(h('div', { class: 'pst-row' },
        h('a', { id: 'pstSeeIt', class: 'btn primary', href: M.postLink(abs(P.cfg.shelfUrl), dn.sid, dn.fid, dn.pid), target: '_blank', rel: 'noopener', text: '棚で見る' }),
        h('button', { id: 'pstAgain', type: 'button', class: 'btn', text: '続けて投稿する', onclick: () => { st.done = null; draw(); } })));
    }

    /* ---------- 取り込み（段階6）：棚の投稿（ノート）を、自分のノートに取り込む ---------- */
    async function drawImport(body, n) {
      if (!AU.uid()) { await AU.restore(); if (!alive(n)) return; }
      if (!AU.uid()) return drawShelfLogin(body);
      const im = st.imp;
      body.appendChild(h('p', { class: 'pst-sub', text: '投稿を読み込んでいます…' }));
      const fo = await A.getFolder(im.sid, im.fid);
      if (!alive(n)) return;
      if (!fo.ok && fo.code === 'login') { AU.signOut(); return draw(); }
      const fail = (t) => { body.textContent = ''; body.appendChild(h('p', { id: 'pstImpError', class: 'pst-msg', role: 'alert', text: t })); };
      if (!fo.ok) return fail(fo.code === 'denied' ? 'この棚のメンバーでないため、読み込めません。' : fo.message);
      const e = fo.exists ? fo.children.find((c) => c.id === im.pid && c.type === 'post') : null;
      if (!e) return fail('この投稿は、見つかりません（削除されたかもしれません）。');
      if (e.kind !== 'note') return fail('取り込めるのは、ノート形式の投稿だけです。Word・Excel・PowerPoint・PDF は、ダウンロードして使ってください。');
      const meta = await D.inspect(e.driveId);
      if (!alive(n)) return;
      const chk = meta.ok ? M.checkDriveMeta(e, meta.meta) : { ok: false, reason: 'error' };
      if (!chk.ok) return fail(chk.reason === 'gone' ? 'このノートは、いま取り込めません（投稿者が取り下げたか、公開が止まっています）。' : 'ノートの状態を確かめられませんでした。しばらくしてから、もう一度お試しください。');
      const rt = await D.readText(e.driveId, M.MAX_POST_BYTES);
      if (!alive(n)) return;
      const doc0 = rt.ok ? M.parseNoteDoc(rt.text) : null;
      if (!doc0 || !doc0.ok) return fail(rt.ok ? doc0.error : rt.message);
      const subjects = ((LN.state && LN.state.subjects) || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      body.textContent = '';
      const msg = msgBox('pstImpMsg');
      const sel = h('select', { id: 'pstImpSubject' }, subjects.map((s) => h('option', { value: s.id, text: s.name })), h('option', { value: '__new', text: '新しい教科を作る…' }));
      const newName = h('input', { id: 'pstImpNewName', type: 'text', maxlength: '100', value: '棚から取り込んだノート', autocomplete: 'off', hidden: subjects.length > 0 });
      if (!subjects.length) sel.value = '__new';
      sel.addEventListener('change', () => { newName.hidden = sel.value !== '__new'; });
      const go = h('button', { id: 'pstImpGo', type: 'button', class: 'btn primary', text: '自分のノートに取り込む' });
      go.addEventListener('click', async () => {
        const subjName = (newName.value || '').trim();
        if (sel.value === '__new' && !subjName) return say(msg, '新しい教科の名前を入力してください。');
        go.disabled = true; say(msg, '');
        try {
          const imp = M.importNote(doc0, { sid: im.sid, fid: im.fid, pid: im.pid, author: e.authorNick, title: e.name, edit: e.edit }, () => M.randomString('abcdefghijklmnopqrstuvwxyz0123456789', 16));
          let subjectId = sel.value;
          if (subjectId === '__new') {
            const s = { id: LN.uid(), name: subjName.slice(0, 100), color: '#5b6dd6', order: Math.max(0, ...((LN.state.subjects || []).map((x) => x.order || 0))) + 1 };
            LN.state.subjects.push(s); subjectId = s.id;
          }
          for (const id of Object.keys(imp.images)) await LN.putImage(id, imp.images[id]);
          const now = Date.now();
          const note = { id: LN.uid(), subjectId, unitId: null, title: imp.title.slice(0, 200), date: imp.date || (LN.dateStr ? LN.dateStr(new Date()) : ''), body: imp.body, star: 0, review: false, createdAt: now, updatedAt: now, origin: imp.origin };
          LN.state.notes.push(note);
          LN.save(); await LN.flush();
          U.ui.view = 'notes'; U.ui.subjectId = subjectId; U.ui.noteId = note.id; if (U.persistUi) U.persistUi();
          U.reload();
          body.textContent = '';
          body.appendChild(h('div', { id: 'pstImpDone', class: 'bk-box' }, h('b', { text: '取り込みました。' }), h('br'), '「' + note.title + '」を、自分のノートに入れました。',
            e.edit === 'ok' ? ' 自由に直せます。直したあと、メニューの「棚に投稿」から、元の投稿の「派生版」として、同じフォルダに出せます。' : ' 作者は「編集しないでほしい」を選んでいます。個人利用にとどめてください（派生版は出せません）。'));
        } catch (err) { go.disabled = false; say(msg, '取り込めませんでした：' + ((err && err.message) || '原因不明')); }
      });
      body.appendChild(h('div', { class: 'bk-box', id: 'pstImpInfo' }, h('b', { id: 'pstImpTitle', text: e.name }), h('br'), (e.authorNick || '') + ' さんのノート（' + M.fmtSize(e.size) + '）'));
      const poster = e.createdBy === AU.uid() && e.edit === 'ok' && !!S.live;   // 自分の投稿：コピーの取り込みではなく、共同編集を始める
      body.appendChild(poster
        ? h('p', { id: 'pstImpEdit', class: 'pst-sub', text: 'あなたの投稿です。共同編集は、あなたも、ほかのメンバーも、始められます。あなたが「終わりにする」と、内容が、あなたの投稿に反映されます。' })
        : e.edit === 'ok'
        ? h('p', { id: 'pstImpEdit', class: 'pst-sub', text: '投稿者は「編集OK」にしています。取り込んで直し、元の投稿の「派生版」として出せます。' })
        : h('p', { id: 'pstImpEdit', class: 'pst-msg', text: '投稿者は「編集しないでほしい」を選んでいます。取り込みは、個人利用だけにしてください。派生版は出せません。' }));
      body.appendChild(h('div', { id: 'pstImpPreview', class: 'pst-rules', text: doc0.body.slice(0, 300) + (doc0.body.length > 300 ? '…' : '') }));
      body.appendChild(field('取り込む教科', sel)); body.appendChild(newName);
      body.appendChild(msg); if (!poster) body.appendChild(go);
      if (e.edit === 'ok' && S.live) {   // 共同編集：本文を、ほかの人と同時に直す（js/shelf/live.js）
        const co = h('button', { id: 'pstImpCo', type: 'button', class: poster ? 'btn primary' : 'btn', text: '共同編集を始める／参加する' });
        co.addEventListener('click', async () => {
          const subjName = (newName.value || '').trim();
          if (sel.value === '__new' && !subjName) return say(msg, '新しい教科の名前を入力してください。');
          co.disabled = go.disabled = true; say(msg, '');
          try {
            const origin = M.checkOrigin({ sid: im.sid, fid: im.fid, pid: im.pid, author: e.authorNick, title: e.name, edit: e.edit });
            const r = await S.live.join({ sid: im.sid, fid: im.fid, pid: im.pid, entry: e, doc: doc0, subjectId: '', origin });
            if (!r.ok) { co.disabled = go.disabled = false; return say(msg, r.message); }
            let subjectId = sel.value;
            if (subjectId === '__new') {
              const s = { id: LN.uid(), name: subjName.slice(0, 100), color: '#5b6dd6', order: Math.max(0, ...((LN.state.subjects || []).map((x) => x.order || 0))) + 1 };
              LN.state.subjects.push(s); subjectId = s.id;
            }
            r.note.subjectId = subjectId;
            LN.state.notes.push(r.note);
            LN.save(); await LN.flush();
            U.ui.view = 'notes'; U.ui.subjectId = subjectId; U.ui.noteId = r.note.id; if (U.persistUi) U.persistUi();
            U.reload();
            body.textContent = '';
            body.appendChild(h('div', { id: 'pstImpDone', class: 'bk-box' }, h('b', { text: '共同編集に参加しました。' }), h('br'), '「' + r.note.title + '」が、あなたのノートに入りました。ふつうのノートと同じように書けます。ほかの人の変更は、10〜30秒ごとに合流します。'));
          } catch (err) { co.disabled = go.disabled = false; say(msg, '参加できませんでした：' + ((err && err.message) || '原因不明')); }
        });
        body.appendChild(h('p', { class: 'pst-sub', id: 'pstImpCoHelp', text: poster
          ? '「共同編集を始める」を押すと、このノートが、あなたのノートに入り、ほかのメンバーが参加できます（本文だけ。画像・図解は、まだ入れられません）。ノートの画面の「終わりにする」を押すと、いまの内容が、あなたの投稿に反映されます。'
          : '共同編集：ほかの人と、同じノートを同時に直します（本文だけ。画像・図解は、まだ入れられません）。投稿者がいなくても始められます。終わりにすると、結果は、投稿者が終わりにした場合は投稿に反映され、ほかの人が終わりにした場合は、その人の派生版として棚に出ます。' }));
        body.appendChild(co);
        A.liveGet(im.sid, im.pid).then((lr) => {   // 始まっているか・止まっているかで、ボタンの文と、押せるかを決める
          if (!alive(n) || !lr.ok) return;
          const uid = AU.uid();
          if (!lr.exists) { co.textContent = '共同編集を始める'; return; }
          if (lr.state === 'open') { co.textContent = '共同編集に参加する'; return; }
          if (lr.owner === uid || lr.startedBy === uid) { co.textContent = '共同編集を再開して、参加する'; return; }
          co.disabled = true; say(msg, '共同編集は、いま止まっています。始めた人（または投稿者）が、再開するか、終わりにするまで、参加できません。');
        });
      }
    }

    /* ---------- 自分の投稿の管理（ドライブに置いたファイルの一覧・取り下げ） ---------- */
    async function drawManage(body, n) {
      const g = G();
      if (!AU.uid()) await AU.restore();   // 棚にログイン済みの端末なら、棚の一覧からも消せる
      if (!alive(n)) return;
      body.appendChild(h('p', { class: 'pst-sub', text: 'このアプリが、棚への投稿のために、あなたのドライブに作ったファイルの一覧です。「取り下げて削除」で、ドライブから消し（公開も止まります）、棚の一覧からも消します。' }));
      const list = h('div', { id: 'pstMine' }, h('p', { class: 'pst-sub', text: '読み込んでいます…' }));
      body.appendChild(list);
      const r = await D.listMine(g.token());
      if (!alive(n)) return;
      list.textContent = '';
      if (!r.ok) {
        list.appendChild(h('p', { id: 'pstMineError', class: 'pst-msg', role: 'alert', text: r.message }));
        if (r.code === 'login') { list.appendChild(h('button', { type: 'button', class: 'btn', text: '再接続', onclick: () => draw() })); }
        return;
      }
      if (!r.files.length) return list.appendChild(h('p', { id: 'pstMineEmpty', class: 'pst-sub', text: '棚に出しているファイルは、ありません。' }));
      const liveBy = {};
      if (AU.uid() && S.live) {   // 共同編集中・返却待ちのノート（投稿者の確認が要るもの）
        const sids = Array.from(new Set(r.files.filter((f) => f.appProperties && f.appProperties.sid && f.appProperties.pid && /\.json$/.test(f.name)).map((f) => f.appProperties.sid)));
        for (const sid of sids) { const lr = await A.liveList(sid); if (lr.ok) lr.items.forEach((x) => { if (x.owner === AU.uid()) liveBy[sid + '/' + x.pid] = x; }); }
        if (!alive(n)) return;
      }
      r.files.forEach((f) => list.appendChild(mineRow(f, liveBy[((f.appProperties || {}).sid) + '/' + ((f.appProperties || {}).pid)])));
    }
    function mineRow(f, live) {
      const wrap = h('div', { class: 'pst-mine', 'data-id': f.id });
      const props = f.appProperties || {};
      const show = () => {
        wrap.textContent = '';
        wrap.appendChild(h('div', { class: 'pst-mine-name', text: f.name }));
        wrap.appendChild(h('div', { class: 'pst-sub', text: M.fmtSize(f.size) + '　' + M.fmtDay(f.createdTime) }));
        wrap.appendChild(h('button', { type: 'button', class: 'btn sm pst-mine-del', text: '取り下げて削除', onclick: confirmDel }));
        if (live) wrap.appendChild(liveBox());
      };
      /* 共同編集：いまの状態・変更の確認・ドライブへ返す・終える／もう一度開く・破棄（投稿者だけが見る） */
      function liveBox() {
        const pid = props.pid, CEx = LN.coedit, L2 = S.live;
        const box = h('div', { class: 'pst-live', id: 'pstLive_' + pid });
        const m3 = msgBox('pstLiveMsg_' + pid), out = h('div', { class: 'pst-diff', id: 'pstLiveDiffOut_' + pid, hidden: true });
        const day = (ms) => M.fmtDay(new Date(ms).toISOString());
        const pending = live.state === 'pending', nEd = CEx.activeEditors(live.editors, Date.now());
        box.appendChild(h('div', { class: 'pst-live-state', id: 'pstLiveState_' + pid, text: pending ? '共同編集：返却待ち（最後の変更 ' + day(live.at) + '）' : '共同編集中：いま ' + nEd + ' 人（最後の変更 ' + day(live.at) + '）' }));
        box.appendChild(h('p', { class: 'pst-sub', text: pending ? '内容を確かめて、よければ「ドライブへ返す」を押してください。あなたのドライブの投稿ファイルが、この内容に置き換わります（元の内容は、ドライブの「版の管理」から戻せます）。' : '編集が終わったら「終える」か、いまの内容を「ドライブへ返す」ことができます。' }));
        const row = h('div', { class: 'pst-row' });
        row.appendChild(h('button', { type: 'button', class: 'btn sm', id: 'pstLiveDiff_' + pid, text: '変更を確認', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; say(m3, '');
          try {
            const text = await CEx.unpack(live.enc, live.text);
            const rt = await D.readText(f.id, M.MAX_POST_BYTES), od = rt.ok ? M.parseNoteDoc(rt.text) : null;
            const sm = CEx.summary(od && od.ok ? od.body : '', text, 12);
            out.textContent = ''; out.hidden = false;
            out.appendChild(h('p', { class: 'pst-sub', id: 'pstLiveDiffSum_' + pid, text: '元の投稿からの変更：追加 ' + sm.added + ' 行・削除 ' + sm.removed + ' 行' + (sm.total > sm.hunks.length ? '（先頭 ' + sm.hunks.length + ' か所を表示）' : '') }));
            sm.hunks.forEach((hk) => {
              hk.del.slice(0, 4).forEach((t) => out.appendChild(h('div', { class: 'pst-diff-del', text: '－ ' + t.slice(0, 80) })));
              hk.ins.slice(0, 4).forEach((t) => out.appendChild(h('div', { class: 'pst-diff-ins', text: '＋ ' + t.slice(0, 80) })));
            });
          } catch (err) { say(m3, '変更を確認できませんでした：' + ((err && err.message) || '原因不明')); }
          b.disabled = false;
        } }));
        row.appendChild(h('button', { type: 'button', class: 'btn sm primary', id: 'pstLiveBack_' + pid, text: 'ドライブへ返す', onclick: async (ev) => {
          const b = ev.currentTarget, g = G(), tok = g && g.token();
          if (!tok) return say(m3, 'Google のログインが切れました。「再接続」してからやり直してください。');
          b.disabled = true; say(m3, '');
          const r2 = await L2.giveBack({ sid: props.sid, pid, driveId: f.id, token: tok });
          if (!r2.ok) { b.disabled = false; return say(m3, r2.message); }
          box.textContent = '';
          box.appendChild(h('p', { class: 'pst-ok', id: 'pstLiveDone_' + pid, text: '共同編集の内容を、ドライブの投稿に返しました。共同編集は終わりました。' }));
        } }));
        row.appendChild(h('button', { type: 'button', class: 'btn sm', id: 'pstLiveState2_' + pid, text: pending ? '再開する' : '止める（あとで返す）', onclick: async (ev) => {
          const b = ev.currentTarget; b.disabled = true; say(m3, '');
          const to = pending ? 'open' : 'pending';
          const r2 = await A.liveSetState({ sid: props.sid, pid, uid: AU.uid(), state: to });
          if (!r2.ok) { b.disabled = false; return say(m3, r2.message); }
          live.state = to; live.at = Date.now(); show();
        } }));
        let armed = false;
        const drop = h('button', { type: 'button', class: 'btn sm danger', id: 'pstLiveDrop_' + pid, text: '破棄', onclick: async (ev) => {
          const b = ev.currentTarget;
          if (!armed) { armed = true; b.textContent = '本当に破棄する（共同編集の内容は消えます。ドライブの投稿は、そのまま）'; return; }
          b.disabled = true; say(m3, '');
          const r2 = await A.liveDelete(props.sid, pid);
          if (!r2.ok) { b.disabled = false; return say(m3, r2.message); }
          box.textContent = '';
          box.appendChild(h('p', { class: 'pst-ok', id: 'pstLiveDropped_' + pid, text: '共同編集の内容を破棄しました（ドライブの投稿は、そのままです）。' }));
        } });
        row.appendChild(drop);
        box.appendChild(row); box.appendChild(m3); box.appendChild(out);
        return box;
      }
      function confirmDel() {
        wrap.textContent = '';
        const m2 = msgBox('pstMineMsg');
        wrap.appendChild(h('div', { class: 'pst-mine-name', text: f.name }));
        wrap.appendChild(h('p', { class: 'pst-sub pst-mine-confirm', text: 'ドライブから削除します（公開も止まります）。' + (props.sid ? '棚の一覧からも消します。' : '') + '元に戻せません。' }));
        wrap.appendChild(m2);
        wrap.appendChild(h('div', { class: 'pst-row' },
          h('button', { type: 'button', class: 'btn sm danger pst-mine-go', text: '削除する', onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true; say(m2, '');
            const g = G(), tok = g && g.token();
            if (!tok) { b.disabled = false; return say(m2, 'Google のログインが切れました。「再接続」してからやり直してください。'); }
            const r = await D.remove(tok, f.id);
            if (!r.ok) { b.disabled = false; return say(m2, r.message); }
            let note = '';
            if (props.sid && props.fid && props.pid) {
              if (AU.uid()) {
                const rr = await A.removeEntry({ sid: props.sid, parent: props.fid, id: props.pid });
                if (rr.ok) note = '棚の一覧からも消しました。';
                else if (rr.code === 'denied' || rr.code === 'notfound') note = '棚の一覧には、すでに無いようです。';
                else note = '棚の一覧から消せませんでした（' + rr.message + '）。棚のページで、その投稿を「削除」してください。';
              } else note = '棚の一覧からは、まだ消えていません。棚にログインして（「投稿する」の画面）やり直すか、棚のページで、その投稿を「削除」してください。';
            }
            wrap.textContent = '';
            wrap.appendChild(h('p', { class: 'pst-ok pst-mine-done', text: '「' + f.name + '」をドライブから削除しました。' + note }));
          } }),
          h('button', { type: 'button', class: 'btn sm', text: 'やめる', onclick: show })));
      }
      show();
      return wrap;
    }

    return closed;
  };
})(window);
