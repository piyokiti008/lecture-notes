/* 共同編集の動かす部分（index.html のノート画面で使う）。docs/コミュニティ実装計画.md の「共同編集」。
 *  - 共同編集のノートは、ふつうのノート（IndexedDB・同じエディタ）。ノートに shared＝{ sid, fid, pid, rev, base, owner, startedBy } の印が付く。
 *    base＝最後に同期した時点の、サーバーの本文（3方向の合流の「共通の元」）。本文だけを共有する（タイトル・教科・単元・重要度・要復習は、自分用）。
 *  - 同期（tick）：サーバーの作業用の写し（shelves/{棚}/live/{投稿}）を読む → base・自分の本文・サーバーの本文を合流 → 変わっていれば、版 +1 で書く
 *    （同時に書かれていたら、読み直してやり直す）→ 画面のエディタに、差分だけを入れる（変換中は待つ）→ base を更新。
 *    間隔は js/coedit.js の決まりのとおり：打ち終わって2秒後・最長15秒ごとに送り、見に行くのは10〜60秒（動きが少ないほど長く）。タブが裏なら止める。
 *  - 返却：投稿者が承認すると、合流した本文を、投稿者のドライブの投稿ファイルに上書きし、作業用の写しを消す（giveBack）。
 *  - 最初は文字だけ（画像・図解は、ほかの人に届かないため、共同編集のノートには入れられない）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const L = (S.live = { st: { state: 'idle', msg: '', editors: 0, conflicts: 0, at: 0 }, onStatus: null });
  const CE = () => LN.coedit, A = () => S.api, AU = () => S.auth, M = () => S.model, D = () => S.drive;
  const SID_RE = /^[a-z0-9]{12,40}$/, ID_RE = /^[a-z0-9]{12,32}$/;
  const BUDGET_KEY = 'ln.coedit.budget';

  let cur = null;   // いま開いている共同編集のノートの状態
  const noteOf = (id) => ((LN.state && LN.state.notes) || []).find((n) => n.id === id) || null;
  const today = () => (LN.dateStr ? LN.dateStr(new Date()) : new Date().toISOString().slice(0, 10));

  /** ノートの shared の印が、正しい形か */
  L.isShared = (n) => !!(n && n.shared && typeof n.shared === 'object' && SID_RE.test(n.shared.sid || '') && (n.shared.fid === 'root' || ID_RE.test(n.shared.fid || '')) && ID_RE.test(n.shared.pid || '')
    && Number.isInteger(n.shared.rev) && n.shared.rev >= 0 && typeof n.shared.base === 'string');
  /** 「終える」（返却待ちにする）ができる人か：投稿者・始めた人（管理者は、棚の画面から） */
  L.canFinish = (n) => { const u = AU() && AU().uid(); return !!(u && L.isShared(n) && (n.shared.owner === u || n.shared.startedBy === u)); };

  /* ---------- 状態の表示 ---------- */
  const MSG = {
    idle: '', syncing: '同期しています…',
    nologin: '棚にログインしていません。メニューの「棚に投稿」からログインすると、共同編集を続けられます。',
    login: '棚のログインが切れました。メニューの「棚に投稿」からログインし直してください。',
    denied: 'この共同編集には、いま参加できません（棚から抜けた・利用停止などの可能性があります）。',
    offline: 'インターネットにつながりません。つながったら、続きを同期します（打った内容は、この端末に残っています）。',
    quota: '通信が混み合っているため、自動の同期を止めました。「今すぐ同期」で、手動で同期できます。',
    budget: '今日の自動の同期の上限（3時間）に達しました。「今すぐ同期」で、手動で同期できます。',
    paused: 'しばらく動きがないため、自動の同期を止めました。打つか「今すぐ同期」で再開します。',
    pending: '返却待ちです。投稿者が確認するまで、編集は止まっています（あなたの変更は、このノートに残っています）。',
    gone: '共同編集は終わりました（投稿者が反映したか、写しが消えました）。このノートは、あなたのふつうのノートとして残ります。',
  };
  function setStatus(state, msg, extra) {
    Object.assign(L.st, { state, msg: msg || MSG[state] || '' }, extra || {});
    if (state === 'ok') L.st.at = Date.now();
    if (typeof L.onStatus === 'function') { try { L.onStatus(L.st); } catch (e) { /* 表示の失敗は、同期を止めない */ } }
  }

  /* ---------- 1日の自動同期の時間（端末ごと） ---------- */
  function spent() { try { const j = JSON.parse(root.localStorage.getItem(BUDGET_KEY) || '{}'); return j.day === today() ? Number(j.ms) || 0 : 0; } catch (e) { return 0; } }
  function spend(ms) { try { root.localStorage.setItem(BUDGET_KEY, JSON.stringify({ day: today(), ms: spent() + Math.max(0, ms) })); } catch (e) { /* 保存できなくても、同期は続ける */ } }

  /* ---------- 取り付け・取り外し ---------- */
  /** ノート画面を開いた（エディタを作ったあと）。hooks＝{ getText(), applyChanges(changes, newText), isComposing() } */
  L.attach = function (note, hooks) {
    L.detach();
    if (!L.isShared(note)) return;
    const dirty0 = String(note.body || '') !== note.shared.base;   // 前に開いたときの、送れていない変更（再読み込みのあとなど）
    cur = { noteId: note.id, hooks, attachAt: Date.now(), timer: 0, busy: false, again: false, stopped: false, autoPaused: false, retries: 0, lastEditAt: 0, dirtySince: dirty0 ? Date.now() : 0, lastRemoteAt: 0, nextPollAt: Date.now() + 200, editors: 0, tickAt: Date.now(), alertedConflict: 0, lastManual: 0 };
    cur.onVis = () => { if (!cur) return; if (root.document.hidden) { clearTimeout(cur.timer); cur.timer = 0; } else { cur.nextPollAt = Date.now(); tick('visible'); } };
    if (root.document) root.document.addEventListener('visibilitychange', cur.onVis);
    setStatus('syncing');
    plan();
  };
  /** ノート画面を離れる。送っていない変更があれば、最後に1回だけ送る（画面には何も入れない） */
  L.detach = function () {
    const c = cur; if (!c) return;
    clearTimeout(c.timer); c.stopped = true;
    if (root.document) root.document.removeEventListener('visibilitychange', c.onVis);
    cur = null;
    const n = noteOf(c.noteId);
    if (n && L.isShared(n) && !c.frozen && c.dirtySince) doSync(Object.assign({}, c, { stopped: false, busy: false, hooks: null }), 'final', { final: true }).catch(() => { /* 最後の送信の失敗は、次に開いたときに、やり直す */ });
    setStatus('idle');
  };
  /** 本文が変わった（エディタの onChange から） */
  L.touch = function () {
    const c = cur; if (!c || c.stopped || c.applying) return;   // 画面に取り込んでいる最中の変更は、自分が打ったものではない
    const n = noteOf(c.noteId); if (!n || !L.isShared(n)) return;
    const now = Date.now(); c.lastEditAt = now;
    if (!c.dirtySince && String(n.body || '') !== n.shared.base) c.dirtySince = now;
    if (c.frozen) return;   // 止まっている状態（ログイン切れ・返却待ちなど）では、予定を立てない
    if (c.autoPaused) { c.autoPaused = false; c.nextPollAt = now; if (L.st.state === 'paused') setStatus('idle'); }
    plan();
  };
  /** 「今すぐ同期」（連打は3秒に1回まで） */
  L.syncNow = function () {
    const c = cur; if (!c) return Promise.resolve(false);
    const now = Date.now();
    if (now - c.lastManual < CE().CFG.minManualMs) return Promise.resolve(false);
    c.lastManual = now; c.autoPaused = false; c.frozen = false; c.retries = 0;
    return tick('manual').then(() => true);
  };

  function plan() {
    const c = cur; if (!c || c.stopped || c.frozen) return;
    clearTimeout(c.timer); c.timer = 0;
    if (root.document && root.document.hidden) return;
    const now = Date.now();
    const sw = CE().sendWait(now, c.dirtySince, c.lastEditAt);
    let wait = sw;
    if (!c.autoPaused) { const pd = Math.max(0, (c.nextPollAt || now) - now); wait = wait === null ? pd : Math.min(wait, pd); }
    if (wait === null) return;
    c.timer = setTimeout(() => { c.timer = 0; tick('auto'); }, wait);
  }
  async function tick(reason) {
    const c = cur; if (!c || c.stopped) return;
    if (c.busy) { c.again = true; return; }
    c.busy = true;
    try { await doSync(c, reason, {}); } catch (e) { setStatus('error', '同期できませんでした：' + ((e && e.message) || '原因不明')); if (cur === c) c.nextPollAt = Date.now() + 30000; }
    finally { c.busy = false; if (cur === c && !c.stopped) { if (c.again) { c.again = false; c.nextPollAt = Math.min(c.nextPollAt || Infinity, Date.now() + 500); } plan(); } }
  }
  const alive = (c) => cur === c && !c.stopped;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 本文を、ノートに直接入れる（エディタが無いとき＝最後の送信のとき） */
  function setBody(n, text) { n.body = text; n.updatedAt = Date.now(); LN.save(); }

  /** 同期の本体 */
  async function doSync(c, reason, opts) {
    const n = noteOf(c.noteId);
    if (!n || !L.isShared(n)) return;
    const sh = n.shared;
    const say = (state, msg, extra) => { if (!opts.final) setStatus(state, msg, extra); };   // 最後の送信は、いま開いている別のノートの表示を変えない
    if (!AU().uid()) { try { await AU().restore(); } catch (e) { /* ログインできないだけ */ } }
    if (!AU().uid()) { c.frozen = true; return say('nologin'); }
    if (!opts.final && reason !== 'manual' && spent() >= CE().CFG.dailyAutoMs) { c.frozen = true; return say('budget'); }
    say('syncing');
    const mine0 = opts.final ? String(n.body || '') : c.hooks.getText();
    const r = await A().liveGet(sh.sid, sh.pid);
    if (!opts.final && !alive(c)) return;
    if (!r.ok) return fail(r, c, opts);
    if (!r.exists) return gone(n, c, opts);
    let remote; try { remote = await CE().unpack(r.enc, r.text); } catch (e) { return say('error', e.message); }
    const now = Date.now();
    const remoteChanged = r.rev !== sh.rev || remote !== sh.base;
    if (remoteChanged) c.lastRemoteAt = now;
    c.editors = CE().activeEditors(r.editors, now);
    // 3方向の合流
    let merged = mine0, conflicts = 0;
    if (remoteChanged) { const m = CE().merge3(sh.base, mine0, remote); merged = m.text; conflicts = m.conflicts; }
    let newRev = r.rev, newBase = remote;
    // 自分の変更を送るのは、打ち終わって2秒たったとき・打ち続けて15秒たったとき・手で同期したとき・画面を離れるときだけ（見に行くだけの周期では、送らない＝書き込みの回数を減らす）
    const localDirty = mine0 !== sh.base;
    const due = localDirty && (opts.final || reason === 'manual' || CE().sendDue(Date.now(), c.dirtySince || 1, c.lastEditAt || 0));
    if (r.state === 'open' && merged !== remote && due) {
      const chk = CE().checkBody(merged);
      if (!chk.ok) return say('error', chk.message);
      const pk = await CE().pack(merged);
      const w = await A().liveWrite({ sid: sh.sid, pid: sh.pid, uid: AU().uid(), rev: r.rev + 1, enc: pk.enc, text: pk.text, updateTime: r.updateTime });
      if (!opts.final && !alive(c)) return;
      if (!w.ok) {
        if ((w.code === 'precondition' || w.code === 'denied') && ++c.retries <= 3) { c.nextPollAt = Date.now() + 300 + c.retries * 700; return say('syncing'); }   // 同時に書かれた：読み直す
        return fail(w, c, opts);
      }
      c.retries = 0; newRev = r.rev + 1; newBase = merged;
    } else if (r.state === 'pending') {
      newBase = remote;   // 返却待ち：書けない。サーバーの本文だけ取り込む（自分の未送信の変更は、このノートに残る）
    }
    // 画面に反映（打っている間に変わっていたら、その分も守る）
    if (opts.final) {
      if (merged !== mine0) setBody(n, merged);
    } else {
      const cur0 = c.hooks.getText();
      const target = cur0 === mine0 ? merged : CE().merge3(mine0, cur0, merged).text;
      if (target !== cur0) {
        if (c.hooks.isComposing && c.hooks.isComposing()) { c.nextPollAt = Date.now() + 700; return; }   // 日本語の変換中は、変換が終わってから取り込む（基準も進めない）
        c.applying = true;
        try { c.hooks.applyChanges(CE().changes(cur0, target), target); } finally { c.applying = false; }
      }
    }
    sh.rev = newRev; sh.base = newBase; sh.state = r.state; sh.owner = r.owner || sh.owner; sh.startedBy = r.startedBy || sh.startedBy;
    LN.save();
    const textNow = opts.final ? String(n.body || '') : c.hooks.getText();
    c.dirtySince = textNow !== sh.base ? Date.now() : 0;
    if (opts.final) return;
    if (conflicts) { c.alertedConflict = conflicts; if (LN.ui && LN.ui.toast) LN.ui.toast('同時に直された所が ' + conflicts + ' か所あります。本文の「⚠」の印を見て、どちらかを消してください'); }
    spend(Math.min(Date.now() - c.tickAt, 2 * CE().CFG.pollBaseMs)); c.tickAt = Date.now();
    const d = CE().pollDelay({ sinceRemote: Date.now() - (c.lastRemoteAt || 0) > 1e12 ? Infinity : Date.now() - c.lastRemoteAt, sinceLocal: Date.now() - Math.max(c.lastEditAt || 0, c.attachAt || 0), alone: c.editors <= 1 && !remoteChanged });
    const extra = { editors: c.editors, conflicts: CE().countMarks(textNow) };
    c.frozen = r.state === 'pending';   // 返却待ちの間は、自動の同期も送信も止める（「今すぐ同期」で、状態を確かめ直せる）
    if (r.state === 'pending') return say('pending', '', extra);
    if (d === null) { c.autoPaused = true; return say('paused', '', extra); }
    c.nextPollAt = Date.now() + d;
    say('ok', '', extra);
  }
  function fail(r, c, opts) {
    const say = (state, msg) => { if (!(opts && opts.final)) setStatus(state, msg); };
    const code = r.code;
    if (code === 'login') { c.frozen = true; return say('login'); }
    if (code === 'denied') { c.frozen = true; return say('denied'); }
    if (code === 'http429') { c.frozen = true; return say('quota'); }
    if (code === 'network' || code === 'timeout') { c.nextPollAt = Date.now() + 30000; return say('offline'); }
    c.nextPollAt = Date.now() + 60000;
    return say('error', r.message || '同期できませんでした。');
  }
  function gone(n, c, opts) {   // 作業用の写しが無い：返却された、または消された。このノートは、ふつうのノートになる
    delete n.shared; LN.save(); c.frozen = true; c.stopped = true; clearTimeout(c.timer);
    if (opts && opts.final) return;
    if (LN.ui) { try { if (LN.ui.renderEditor) LN.ui.renderEditor(); if (LN.ui.renderList) LN.ui.renderList(); } catch (e) { /* 表示の失敗は無視 */ } }
    setStatus('gone');   // 描き直し（detach で idle に戻る）のあとに、知らせる
    if (LN.ui && LN.ui.toast) LN.ui.toast(MSG.gone);
  }

  /* ---------- 終える・抜ける ---------- */
  /** 共同編集を終える（返却待ちにする）。投稿者か始めた人。最後に、未送信の変更を送ってから */
  L.finish = async function () {
    const c = cur, n = c && noteOf(c.noteId);
    if (!n || !L.isShared(n)) return { ok: false, message: '共同編集のノートではありません。' };
    const stop = c; await tick('manual'); if (stop.busy) await delay(300);
    const r = await A().liveSetState({ sid: n.shared.sid, pid: n.shared.pid, uid: AU().uid(), state: 'pending' });
    if (!r.ok) return { ok: false, message: r.code === 'denied' ? '共同編集を終えられるのは、投稿者か、始めた人です。' : r.message };
    n.shared.state = 'pending'; LN.save(); setStatus('pending'); if (cur) cur.frozen = true;
    return { ok: true };
  };
  /** 共同編集から抜ける（このノートは、いまの本文のまま、ふつうのノートになる）。サーバーの写しは、そのまま */
  L.leave = async function () {
    const c = cur, n = c && noteOf(c.noteId);
    if (!n || !L.isShared(n)) return { ok: false, message: '共同編集のノートではありません。' };
    await tick('manual');
    delete n.shared; LN.save(); L.detach(); setStatus('idle');
    return { ok: true };
  };

  /* ---------- 参加する（取り込みの画面から） ---------- */
  /** 共同編集に参加：作業用の写しが無ければ、投稿の本文から始める。自分のノートを作る。
   *  o＝{ sid, fid, pid, entry（棚の目次の投稿の項目）, doc（読んだ投稿の本文 M.parseNoteDoc の結果）, subjectId, origin }
   *  → { ok:true, note } か { ok:false, message } */
  L.join = async function (o) {
    const e = o.entry;
    if (!e || e.edit !== 'ok') return { ok: false, message: '投稿者が「編集OK」にしていないため、共同編集できません。' };
    if (!AU().uid()) { try { await AU().restore(); } catch (err) { /* 下で断る */ } }
    const uid = AU().uid(); if (!uid) return { ok: false, message: '棚にログインしていません。' };
    let r = await A().liveGet(o.sid, o.pid);
    if (!r.ok) return { ok: false, message: r.message };
    let text, rev, owner, startedBy;
    if (r.exists) {
      if (r.state === 'pending') return { ok: false, message: 'この共同編集は、いま「返却待ち」です（投稿者が確認するまで、新しく参加できません）。' };
      if (CE().activeEditors(r.editors, Date.now()) >= CE().CFG.maxEditors && !(uid in r.editors)) return { ok: false, message: 'この共同編集は、いま満員です（同時に ' + CE().CFG.maxEditors + ' 人まで）。しばらくしてからお試しください。' };
      try { text = await CE().unpack(r.enc, r.text); } catch (err) { return { ok: false, message: err.message }; }
      rev = r.rev; owner = r.owner; startedBy = r.startedBy;
    } else {
      const chk = CE().checkBody(o.doc.body);
      if (!chk.ok) return { ok: false, message: chk.message };
      if (o.doc.images && Object.keys(o.doc.images).length) return { ok: false, message: '画像が入っているノートは、まだ共同編集できません（画像は、ほかの人に届かないため）。' };
      const pk = await CE().pack(o.doc.body);
      const c = await A().liveCreate({ sid: o.sid, fid: o.fid, pid: o.pid, uid, owner: e.createdBy, title: e.name, enc: pk.enc, text: pk.text });
      if (!c.ok) {
        if (c.code === 'exists') return L.join(o);   // 同時に、ほかの人が始めた：その写しに参加する
        return { ok: false, message: c.code === 'denied' ? 'この投稿は、共同編集を始められません（投稿者が「編集OK」にしていない、またはこの棚のメンバーでない可能性があります）。' : c.message };
      }
      text = o.doc.body; rev = 1; owner = e.createdBy; startedBy = uid;
    }
    const now = Date.now();
    const note = { id: LN.uid(), subjectId: o.subjectId, unitId: null, title: String(e.name || '共同編集のノート').slice(0, 200), date: o.doc.date || today(), body: text, star: 0, review: false, createdAt: now, updatedAt: now,
      origin: o.origin || undefined, shared: { sid: o.sid, fid: o.fid, pid: o.pid, rev, base: text, owner, startedBy, state: 'open' } };
    if (!note.origin) delete note.origin;
    return { ok: true, note };
  };

  /* ---------- 返却（投稿者）：合流した本文を、ドライブの投稿ファイルに上書きして、作業用の写しを消す ---------- */
  /** o＝{ sid, pid, driveId, token（Google のアクセストークン）}。→ { ok:true } か { ok:false, message } */
  L.giveBack = async function (o) {
    const r = await A().liveGet(o.sid, o.pid);
    if (!r.ok) return { ok: false, message: r.message };
    if (!r.exists) return { ok: false, message: '共同編集の写しが見つかりません（すでに消えています）。' };
    let text; try { text = await CE().unpack(r.enc, r.text); } catch (e) { return { ok: false, message: e.message }; }
    const orig = await D().readText(o.driveId, M().MAX_POST_BYTES);
    const od = orig.ok ? M().parseNoteDoc(orig.text) : null;
    const doc = M().buildNoteDoc({ title: (od && od.ok && od.title) || r.title, date: od && od.ok ? od.date : '', body: text }, {});
    const up = await D().update(o.token, o.driveId, JSON.stringify(doc), 'application/json');
    if (!up.ok) return { ok: false, message: up.message || 'ドライブに書き込めませんでした。' };
    const del = await A().liveDelete(o.sid, o.pid);
    return del.ok ? { ok: true } : { ok: false, message: 'ドライブには返しましたが、作業用の写しを消せませんでした。もう一度「破棄」を押してください。' };
  };
})(window);
