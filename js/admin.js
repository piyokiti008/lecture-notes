/* 運営用の名簿（admin.html）：ニックネームの一覧と、利用停止（BAN）の操作。
 *  - 運営の Google アカウントでログインし（Firebase のログインを通すと、運営だけが名簿を読める規則に合う）、Firestore の members を読む。
 *  - 表示するのは、ニックネーム・番号の頭の6文字・登録日・最終利用日・停止の有無だけ。利用者の Google アカウントは、そもそも名簿に入っていない。
 *  - 利用者が決めたニックネームは信用できない文字列なので、画面には必ず textContent で入れる（HTML として解釈しない）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const FB = LN.fbConfig || {};
  const doc = root.document;
  const A = (LN.admin = {
    cfg: {
      clientId: FB.clientId, apiKey: FB.apiKey, roster: FB.roster,
      signin: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp',
      gisSrc: 'https://accounts.google.com/gsi/client',
      scope: 'openid email',
      docs: FB.docs,
      gis: null, // 試験用：Google のログイン部品の代わり
    },
  });
  const $ = (id) => doc.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let idToken = '', rows = [];

  function say(el, t) { el.textContent = t || ''; el.hidden = !t; }
  const fmtDay = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0'); };
  const ago = (iso) => {
    const t = new Date(iso).getTime(); if (isNaN(t)) return '';
    const days = Math.floor((Date.now() - t) / 86400000);
    return days <= 0 ? '今日' : days === 1 ? '昨日' : days + '日前';
  };

  /* ---------- 運営のログイン ---------- */
  function loadGis() {
    if (A.cfg.gis) return Promise.resolve(A.cfg.gis);
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve(root.google.accounts.oauth2);
    return new Promise((res, rej) => {
      const s = doc.createElement('script'); s.src = A.cfg.gisSrc; s.async = true;
      s.onload = () => res(root.google.accounts.oauth2);
      s.onerror = () => rej(new Error('Google のログイン部品を読み込めませんでした。'));
      doc.head.appendChild(s);
    });
  }
  function googleToken() {
    return loadGis().then((g) => new Promise((resolve, reject) => {
      const tc = g.initTokenClient({
        client_id: A.cfg.clientId, scope: A.cfg.scope,
        callback: (r) => (r && r.access_token ? resolve(r.access_token) : reject(new Error((r && (r.error_description || r.error)) || 'ログインできませんでした。'))),
        error_callback: (e) => reject(new Error('ログインの小窓が閉じられました。')),
      });
      tc.requestAccessToken({ prompt: 'select_account' });
    }));
  }
  async function signIn() {
    const tok = await googleToken();
    const r = await fetch(A.cfg.signin + '?key=' + encodeURIComponent(A.cfg.apiKey), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ postBody: 'access_token=' + encodeURIComponent(tok) + '&providerId=google.com', requestUri: root.location.origin, returnSecureToken: true, returnIdpCredential: false }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.idToken) throw new Error('名簿のログインに失敗しました（' + ((j.error && j.error.message) || r.status) + '）。');
    idToken = j.idToken;
  }

  /* ---------- 名簿を読む・書く ---------- */
  const headers = () => ({ Authorization: 'Bearer ' + idToken });
  const keyQ = () => '&key=' + encodeURIComponent(A.cfg.apiKey);
  const sv = (f) => (f && typeof f.stringValue === 'string' ? f.stringValue : '');
  const tv = (f) => (f && (f.timestampValue || f.stringValue) ? String(f.timestampValue || f.stringValue) : '');
  const pidOfName = (name) => String(name || '').split('/').pop();

  async function loadAll() {
    const out = []; let page = '';
    for (let i = 0; i < 40; i++) { // 300件 × 40ページ＝12000人まで
      const r = await fetch(A.cfg.roster + '?pageSize=300&orderBy=' + encodeURIComponent('last desc') + (page ? '&pageToken=' + encodeURIComponent(page) : '') + keyQ(), { headers: headers(), credentials: 'omit' });
      if (r.status === 401 || r.status === 403) { const e = new Error('denied'); e.denied = true; throw e; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('名簿を読めませんでした（' + r.status + '）。');
      (j.documents || []).forEach((d) => { const f = d.fields || {}; out.push({ pid: pidOfName(d.name), nick: sv(f.nick), first: tv(f.first), last: tv(f.last), banned: !!(f.banned && f.banned.booleanValue === true) }); });
      page = j.nextPageToken || ''; if (!page) break;
    }
    return out;
  }
  async function setBanned(pid, on) {
    const r = await fetch(A.cfg.roster + '/' + encodeURIComponent(pid) + '?updateMask.fieldPaths=banned&currentDocument.exists=true' + keyQ(), {
      method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, headers()), credentials: 'omit',
      body: JSON.stringify({ fields: { banned: { booleanValue: !!on } } }),
    });
    if (!r.ok) throw new Error('変更できませんでした（' + r.status + '）。');
  }

  /* ---------- 画面 ---------- */
  function td(text, cls) { const c = doc.createElement('td'); if (cls) c.className = cls; c.textContent = text; return c; }
  function render() {
    const q = $('admQ').value.trim().toLowerCase();
    const week = Date.now() - 7 * 86400000;
    const total = rows.length, banned = rows.filter((x) => x.banned).length;
    const active = rows.filter((x) => new Date(x.last).getTime() >= week).length;
    const fresh = rows.filter((x) => new Date(x.first).getTime() >= week).length;
    const st = $('admStats'); st.textContent = '';
    [['登録', total + '人'], ['この1週間に使った', active + '人'], ['この1週間に登録', fresh + '人'], ['利用停止', banned + '人']].forEach((p) => {
      const d = doc.createElement('div'); d.className = 'adm-stat'; const b = doc.createElement('b'); b.textContent = p[1]; const s = doc.createElement('span'); s.textContent = p[0]; d.appendChild(b); d.appendChild(s); st.appendChild(d);
    });
    const body = $('admRows'); body.textContent = '';
    const shown = rows.filter((x) => !q || x.nick.toLowerCase().includes(q) || x.pid.startsWith(q));
    if (!shown.length) { const tr = doc.createElement('tr'); const c = td(rows.length ? '該当する人がいません。' : 'まだ、登録した人がいません。', 'adm-empty'); c.colSpan = 6; tr.appendChild(c); body.appendChild(tr); return; }
    shown.forEach((x) => {
      const tr = doc.createElement('tr'); if (x.banned) tr.className = 'banned';
      tr.appendChild(td(x.nick || '（なし）', 'nick'));
      tr.appendChild(td(x.pid.slice(0, 6), 'pid'));
      tr.appendChild(td(fmtDay(x.first)));
      tr.appendChild(td(fmtDay(x.last) + '（' + ago(x.last) + '）'));
      tr.appendChild(td(x.banned ? '利用停止中' : '利用中', x.banned ? 'st-ban' : 'st-ok'));
      const op = doc.createElement('td'); const b = doc.createElement('button'); b.type = 'button'; b.className = 'adm-btn sm' + (x.banned ? '' : ' danger');
      b.textContent = x.banned ? '停止を解除' : '利用停止にする'; b.dataset.pid = x.pid; b.dataset.on = x.banned ? '0' : '1';
      op.appendChild(b); tr.appendChild(op); body.appendChild(tr);
    });
  }

  async function reload() {
    say($('admMsg2'), '読み込んでいます…');
    try { rows = await loadAll(); say($('admMsg2'), ''); render(); }
    catch (e) {
      if (e.denied) { idToken = ''; $('admMain').hidden = true; $('admLogin').hidden = false; say($('admMsg'), 'このアカウントには、名簿を読む権限がありません（運営のアカウントでログインしてください）。'); }
      else say($('admMsg2'), e.message || '名簿を読めませんでした。');
    }
  }

  async function login() {
    say($('admMsg'), 'ログインしています…'); $('admGo').disabled = true;
    try { await signIn(); $('admLogin').hidden = true; $('admMain').hidden = false; $('admShelvesCard').hidden = false; say($('admMsg'), ''); await reload(); }
    catch (e) { say($('admMsg'), e.message || 'ログインできませんでした。'); }
    $('admGo').disabled = false;
  }

  $('admGo').addEventListener('click', login);
  $('admReload').addEventListener('click', reload);
  $('admQ').addEventListener('input', render);
  $('admOut').addEventListener('click', () => { idToken = ''; rows = []; shelves = []; $('admShelves').textContent = ''; $('admShelvesCard').hidden = true; $('admMain').hidden = true; $('admLogin').hidden = false; $('admRows').textContent = ''; say($('admMsg'), 'ログアウトしました。'); });
  $('admRows').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-pid]'); if (!b) return;
    const on = b.dataset.on === '1', x = rows.find((r) => r.pid === b.dataset.pid); if (!x) return;
    if (on && !root.confirm('「' + (x.nick || '（なし）') + '」さん（番号 ' + x.pid.slice(0, 6) + '）を、利用停止にします。よろしいですか？')) return;
    b.disabled = true;
    try { await setBanned(x.pid, on); x.banned = on; render(); say($('admMsg2'), ''); }
    catch (err) { b.disabled = false; say($('admMsg2'), err.message); }
  });

  /* ---------- 棚（削除の依頼に応える。名前・人数・作成日だけが見える。中身は読めない） ---------- */
  const docName = () => String(A.cfg.docs || '').replace(/^https?:\/\/[^/]+\/v1\//, '');
  const num = (f) => (f && f.integerValue !== undefined ? Number(f.integerValue) : 0);
  async function listCol(path) {
    const out = []; let page = '';
    for (let i = 0; i < 40; i++) {
      const r = await fetch(A.cfg.docs + '/' + path + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : '') + keyQ(), { headers: headers(), credentials: 'omit' });
      if (r.status === 404) break;
      if (r.status === 401 || r.status === 403) { const e = new Error('denied'); e.denied = true; throw e; }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('読み込めませんでした（' + r.status + '）。');
      (j.documents || []).forEach((d) => out.push({ id: pidOfName(d.name), fields: d.fields || {} }));
      page = j.nextPageToken || ''; if (!page) break;
    }
    return out;
  }
  async function loadShelves() { return (await listCol('shelves')).map((d) => ({ sid: d.id, name: sv(d.fields.name), count: num(d.fields.memberCount), created: tv(d.fields.created) })).sort((a, b) => b.created.localeCompare(a.created)); }
  async function removeDocs(paths) {
    for (let i = 0; i < paths.length; i += 200) {
      const r = await fetch(A.cfg.docs + ':commit?key=' + encodeURIComponent(A.cfg.apiKey), { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers()), credentials: 'omit', body: JSON.stringify({ writes: paths.slice(i, i + 200).map((p) => ({ delete: docName() + '/' + p })) }) });
      if (!r.ok) throw new Error('消せませんでした（' + r.status + '）。');
    }
  }
  /** 棚を消す：メンバー・いいね・通報・招待コードを先に、最後に棚そのものを消す。フォルダの文書は、運営には読めない（一覧を取れない）ので残るが、メンバーがいなくなるので、誰にも見えない */
  async function deleteShelf(sid) {
    const [mem, lk, rp] = await Promise.all([listCol('shelves/' + sid + '/members'), listCol('shelves/' + sid + '/likes'), listCol('shelves/' + sid + '/reports')]);
    const paths = [];
    mem.forEach((d) => { paths.push('shelves/' + sid + '/members/' + d.id); if (sv(d.fields.role) === 'admin' && /^[A-Z2-9]{12}$/.test(sv(d.fields.code))) paths.push('invites/' + sv(d.fields.code)); });
    lk.forEach((d) => paths.push('shelves/' + sid + '/likes/' + d.id)); rp.forEach((d) => paths.push('shelves/' + sid + '/reports/' + d.id));
    paths.push('shelves/' + sid);
    await removeDocs(paths);
  }
  let shelves = [];
  function renderShelves() {
    const body = $('admShelves'); body.textContent = '';
    if (!shelves.length) { const tr = doc.createElement('tr'); const c = td('棚は、ありません。', 'adm-empty'); c.colSpan = 5; tr.appendChild(c); body.appendChild(tr); return; }
    shelves.forEach((x) => {
      const tr = doc.createElement('tr');
      tr.appendChild(td(x.name || '（名前なし）', 'nick')); tr.appendChild(td(x.count + '人')); tr.appendChild(td(fmtDay(x.created))); tr.appendChild(td(x.sid.slice(0, 6), 'pid'));
      const op = doc.createElement('td'); const b = doc.createElement('button'); b.type = 'button'; b.className = 'adm-btn sm danger'; b.textContent = '棚を削除'; b.dataset.sid = x.sid; op.appendChild(b); tr.appendChild(op); body.appendChild(tr);
    });
  }
  async function reloadShelves() {
    say($('admMsg3'), '読み込んでいます…');
    try { shelves = await loadShelves(); say($('admMsg3'), ''); renderShelves(); }
    catch (e) { say($('admMsg3'), e.denied ? 'この操作は、許可されていません（運営のアカウントでログインしてください）。' : (e.message || '読み込めませんでした。')); }
  }
  $('admShelvesLoad').addEventListener('click', reloadShelves);
  $('admShelves').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-sid]'); if (!b) return;
    const x = shelves.find((s) => s.sid === b.dataset.sid); if (!x) return;
    if (!root.confirm('棚「' + (x.name || '（名前なし）') + '」（' + x.count + '人）を削除します。メンバー・いいね・通報の記録が消え、誰も中身を見られなくなります。元に戻せません。よろしいですか？')) return;
    b.disabled = true;
    try { await deleteShelf(x.sid); shelves = shelves.filter((s) => s.sid !== x.sid); renderShelves(); say($('admMsg3'), ''); }
    catch (err) { b.disabled = false; say($('admMsg3'), err.message || '消せませんでした。'); }
  });
  A._test = { loadAll, sleep, loadShelves };
})(window);
