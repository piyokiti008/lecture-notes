/* Google ログイン ＋ 各自の Google ドライブへの自動保存（運営のサーバーは無い）
 *
 *  - ログイン：Google Identity Services のトークン方式（ポップアップ）。権限は「このアプリが作ったファイルだけ」(drive.file) と基本情報のみ。
 *  - 名簿：ログインのたびに Firebase Authentication へ記録する（管理画面で人数の確認・個別停止ができる）。送るのはログイン情報だけで、ノートの中身は送らない。
 *  - 保存：ブラウザ内（IndexedDB）への保存が常に先。ドライブへは裏で同期する。ドライブの「講義ノート」フォルダに、
 *          文字データ(JSON 1つ)と、貼り付けた画像（画像ごとに1ファイル）を置く。
 *  - 同期するのは「中身」（教科・単元・ノート・考査・AIプリント）だけ。表示位置や設定は端末ごと。
 *  - 置き換えるときは必ず直前の状態を「安全コピー」に残す（2026-10-01 のデータ消失の教訓）。
 *  - アクセストークンは約1時間で切れる。切れたら、次の操作のときに自動で再接続を試み、だめなら画面左下のボタンで再接続する。
 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  // 公開されても問題ない識別子（秘密ではない）。Firebase プロジェクト p-notes-4ed2b の Web クライアント
  const cfg = {
    clientId: '473111156744-0s1sg9m5i452mnr0edcdg0a6uk12s697.apps.googleusercontent.com',
    apiKey: 'AIzaSyCNVYjLftIeUTu0H5OQ6Tsk5tyE9PXUwGE',
    scope: 'https://www.googleapis.com/auth/drive.file openid email profile',
    gisSrc: 'https://accounts.google.com/gsi/client',
    drive: 'https://www.googleapis.com/drive/v3',
    upload: 'https://www.googleapis.com/upload/drive/v3',
    userinfo: 'https://www.googleapis.com/oauth2/v3/userinfo',
    roster: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp',
    pushDelayMs: 4000,   // 編集が止まってからドライブへ送るまでの待ち
    pollMs: 90000,       // 他の端末の変更を確かめる間隔（画面が見えているとき）
    gis: null,           // テスト用：Google のログイン部品の代わり
  };
  const c = (LN.cloud = { cfg, status: 'off', message: '' });

  let U = null;                       // LN.ui（app.js から渡される）
  let token = null, tokenExp = 0;     // アクセストークン（メモリだけに置く。保存しない）
  let applying = false;               // ドライブの内容を取り込み中（このあいだの保存は「変更」とみなさない）
  let connecting = false, armed = false, autoTried = false, started = false;
  let pushTimer = null, retryTimer = null, lock = Promise.resolve();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const toast = (m) => { if (U) U.toast(m); };
  const tokenOk = () => !!token && Date.now() < tokenExp;

  /* ---------- このブラウザの「つながり」の記録（localStorage。ノートの中身は入れない） ---------- */
  const BOOK_KEY = 'ln.cloud.v1', SKIP_KEY = 'ln.cloud.skip';
  const lsGet = (k) => { try { return JSON.parse(root.localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { root.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 書けなくても動く */ } };
  let book = lsGet(BOOK_KEY) || {};   // { enabled, sub, email, name, folderId, fileId, baseVersion, lastHash, dirty, images:{id:fileId}, lastSync }
  if (!book.images) book.images = {};
  const saveBook = () => lsSet(BOOK_KEY, book);

  function hash(str) { // cyrb53：中身が同じか調べるための短い指紋
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  /* ---------- 状態表示（画面左下のボタン） ---------- */
  const CLOUD_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 8.6 4.7 4.7 0 0 1 17.5 18z"/></svg>';
  function describe() {
    const s = c.status;
    if (!book.enabled && s !== 'connecting') return { text: 'ログイン（自動保存）', dot: '', title: 'Google でログインすると、ノートがあなたの Google ドライブに自動で保存されます' };
    const who = book.email ? book.email + '：' : '';
    switch (s) {
      case 'connecting': return { text: 'ログイン中…', dot: '', title: 'Google のログイン画面で操作してください' };
      case 'syncing': return { text: '同期中…', dot: '', title: who + 'ドライブと同期しています' };
      case 'pending': return { text: '保存待ち…', dot: '', title: who + '変更を、まもなくドライブへ保存します' };
      case 'needlogin': return { text: '再接続が必要', dot: 'dotwarn', title: who + 'ドライブへの保存を続けるには、押して再接続してください（ノートはこのブラウザに保存されています）' };
      case 'offline': return { text: 'オフライン', dot: 'dotwarn', title: who + 'インターネットにつながるとドライブへ保存します' };
      case 'conflict': return { text: '要確認', dot: 'dotwarn', title: who + 'ドライブとこのブラウザの内容が食い違っています。押して確認してください' };
      case 'blocked': return { text: '利用停止中', dot: 'dotwarn', title: 'このアカウントは利用停止中です' };
      case 'error': return { text: '同期エラー', dot: 'dotwarn', title: who + (c.message || '同期できませんでした') };
      default: return { text: '同期済み', dot: 'dotok', title: who + 'ドライブに保存済みです' };
    }
  }
  function chipHtml() {
    const d = describe();
    return '<button class="btn ghost cloud-chip" id="cloudChip" data-act="cloud" title="' + esc(d.title) + '">' + CLOUD_ICON + '<span class="cloud-t">' + esc(d.text) + '</span>' + (d.dot ? '<span class="' + d.dot + '"></span>' : '') + '</button>';
  }
  c.chipHtml = chipHtml;
  c.enabled = () => !!book.enabled;                 // このブラウザで、ドライブへの自動保存を使っているか
  c.label = () => describe().text;                 // 画面に出す短い状態（メニューなど）
  c.attention = () => describe().dot === 'dotwarn'; // 気づいてほしい状態か（要再接続・エラー・要確認など）
  function setStatus(s, msg) {
    c.status = s; c.message = msg || '';
    const el = root.document && root.document.getElementById('cloudChip');
    if (el) el.outerHTML = chipHtml();
    if (c.onStatus) { try { c.onStatus(s); } catch (e) { /* 無視 */ } }
  }
  const settle = () => setStatus(book.dirty ? 'pending' : 'synced');

  /* ---------- Google ログイン（トークン方式） ---------- */
  let gisPromise = null;
  function loadGis() {
    if (cfg.gis) return Promise.resolve(cfg.gis);
    if (root.google && root.google.accounts && root.google.accounts.oauth2) return Promise.resolve(root.google.accounts.oauth2);
    if (!gisPromise) {
      gisPromise = new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = cfg.gisSrc; s.async = true;
        s.onload = () => res(root.google.accounts.oauth2);
        s.onerror = () => { gisPromise = null; rej(new Error('Google のログイン部品を読み込めませんでした（インターネット接続をご確認ください）')); };
        document.head.appendChild(s);
      });
    }
    return gisPromise;
  }
  const preloadGis = () => { loadGis().catch(() => {}); };

  async function requestToken(prompt, hint) {
    const g = await loadGis();
    return new Promise((resolve, reject) => {
      const tc = g.initTokenClient({
        client_id: cfg.clientId, scope: cfg.scope, hint: hint || undefined,
        callback: (r) => (r && r.error ? reject(Object.assign(new Error(r.error_description || r.error), { code: r.error })) : resolve(r)),
        error_callback: (e) => reject(Object.assign(new Error((e && (e.message || e.type)) || 'popup'), { code: (e && e.type) || 'popup' })),
      });
      tc.requestAccessToken({ prompt });
    });
  }

  class DriveError extends Error {
    constructor(status, body) { super('Drive ' + status + ' ' + String(body || '').slice(0, 160)); this.status = status; this.body = body; }
  }
  async function api(url, init, tries) {
    const max = tries || 3;
    for (let i = 0; ; i++) {
      if (!tokenOk()) throw new DriveError(401, 'token');
      const r = await fetch(url, Object.assign({}, init || {}, { headers: Object.assign({ Authorization: 'Bearer ' + token }, (init && init.headers) || {}) }));
      if (r.ok) return r;
      const body = await r.text().catch(() => '');
      if (r.status === 401) { token = null; throw new DriveError(401, body); }
      const retryable = r.status === 429 || r.status >= 500 || (r.status === 403 && /rateLimit/i.test(body));
      if (retryable && i < max - 1) { await sleep(400 * Math.pow(2, i)); continue; }
      throw new DriveError(r.status, body);
    }
  }
  const apiJson = async (url, init) => (await api(url, init)).json();

  /** 名簿への記録。利用停止にされたアカウントなら 'disabled'。名簿に届かなかっただけなら、利用は止めない */
  async function rosterCheck() {
    try {
      const r = await fetch(cfg.roster + '?key=' + encodeURIComponent(cfg.apiKey), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postBody: 'access_token=' + encodeURIComponent(token) + '&providerId=google.com', requestUri: root.location.origin, returnSecureToken: true, returnIdpCredential: false }),
      });
      if (r.ok) return 'ok';
      const j = await r.json().catch(() => ({}));
      const msg = (j && j.error && j.error.message) || '';
      return /USER_DISABLED/.test(msg) ? 'disabled' : 'unknown:' + msg;
    } catch (e) { return 'unknown:' + e.message; }
  }

  /* ---------- Google ドライブの操作 ---------- */
  async function listFiles(q, fields, orderBy) {
    const out = []; let page = '';
    do {
      const u = cfg.drive + '/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('nextPageToken,files(' + fields + ')') + '&pageSize=1000&spaces=drive' +
        (orderBy ? '&orderBy=' + encodeURIComponent(orderBy) : '') + (page ? '&pageToken=' + encodeURIComponent(page) : '');
      const j = await apiJson(u);
      out.push(...(j.files || [])); page = j.nextPageToken || '';
    } while (page);
    return out;
  }
  async function ensureFolder() {
    const fs = await listFiles("appProperties has { key='ln' and value='folder' } and trashed=false", 'id,createdTime', 'createdTime');
    if (fs.length) return fs[0].id;
    const f = await apiJson(cfg.drive + '/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '講義ノート', mimeType: 'application/vnd.google-apps.folder', appProperties: { ln: 'folder' } }) });
    return f.id;
  }
  const findState = async (folderId) => (await listFiles("'" + folderId + "' in parents and appProperties has { key='ln' and value='state' } and trashed=false", 'id,version,modifiedTime', 'modifiedTime desc'))[0] || null;
  const getMeta = (fileId) => apiJson(cfg.drive + '/files/' + fileId + '?fields=id,version,modifiedTime,trashed');
  async function readState(fileId) { return (await api(cfg.drive + '/files/' + fileId + '?alt=media')).text(); }
  function multipart(meta, data, mime) {
    const b = '----ln' + Math.random().toString(36).slice(2);
    return { type: 'multipart/related; boundary=' + b, body: new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n', JSON.stringify(meta), '\r\n--' + b + '\r\nContent-Type: ' + mime + '\r\n\r\n', data, '\r\n--' + b + '--']) };
  }
  async function createState(folderId, text) {
    const mp = multipart({ name: 'ノート（自動保存）.json', parents: [folderId], mimeType: 'application/json', appProperties: { ln: 'state' } }, text, 'application/json');
    return apiJson(cfg.upload + '/files?uploadType=multipart&fields=id,version,modifiedTime', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
  }
  const updateState = (fileId, text) => apiJson(cfg.upload + '/files/' + fileId + '?uploadType=media&fields=id,version,modifiedTime', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: text });

  const stateText = (contentStr) => '{"app":"lecture-notes","kind":"content","format":1,"savedAt":' + JSON.stringify(new Date().toISOString()) + ',"content":' + contentStr + '}';
  function parseState(text) {
    try { const j = JSON.parse(text); return j && j.app === 'lecture-notes' && j.content && typeof j.content === 'object' ? LN.contentOf(j.content) : null; } catch (e) { return null; }
  }

  function dataUrlToBlob(du) {
    const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(du);
    if (!m) throw new Error('画像の形式が不明です');
    const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] });
  }
  const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
  async function remoteImageMap(folderId) {
    const fs = await listFiles("'" + folderId + "' in parents and appProperties has { key='ln' and value='img' } and trashed=false", 'id,appProperties');
    const m = {}; fs.forEach((f) => { if (f.appProperties && f.appProperties.imgId) m[f.appProperties.imgId] = f.id; });
    return m;
  }
  async function uploadImages(folderId, ids) {
    const need = Array.from(ids).filter((id) => LN.images[id] && !book.images[id]);
    if (!need.length) return;
    Object.assign(book.images, await remoteImageMap(folderId)); // すでにドライブにある画像は上げ直さない
    for (const id of need) {
      if (book.images[id]) continue;
      const blob = dataUrlToBlob(LN.images[id]);
      const mp = multipart({ name: 'img-' + id, parents: [folderId], appProperties: { ln: 'img', imgId: id } }, blob, blob.type || 'application/octet-stream');
      const f = await apiJson(cfg.upload + '/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': mp.type }, body: mp.body });
      book.images[id] = f.id; saveBook();
    }
  }
  /** ドライブにある画像のうち、このブラウザに無いものを取り込む。取り込めなかった枚数を返す */
  async function downloadImages(folderId, content) {
    const need = Array.from(LN.usedImageIdsOf(content)).filter((id) => !LN.images[id]);
    if (!need.length) return 0;
    const map = await remoteImageMap(folderId);
    Object.assign(book.images, map);
    let failed = 0;
    for (let i = 0; i < need.length; i += 4) {
      await Promise.all(need.slice(i, i + 4).map(async (id) => {
        try {
          if (!map[id]) throw new Error('none');
          const blob = await (await api(cfg.drive + '/files/' + map[id] + '?alt=media')).blob();
          await LN.putImage(id, await blobToDataUrl(blob));
        } catch (e) { if (e instanceof DriveError && e.status === 401) throw e; failed++; }
      }));
    }
    return failed;
  }

  /* ---------- 同期の本体 ---------- */
  async function exclusive(fn) {
    const prev = lock; let release;
    lock = new Promise((r) => { release = r; });
    await prev;
    try { return await fn(); } finally { release(); }
  }
  const countOf = (ct) => ({ subs: ct.subjects.length, notes: ct.notes.length });

  function mergeContent(local, remote) {
    const out = {};
    ['subjects', 'units', 'notes', 'exams', 'aiSheets'].forEach((k) => {
      const m = new Map();
      (remote[k] || []).forEach((x) => m.set(x.id, x));
      (local[k] || []).forEach((x) => { const y = m.get(x.id); if (!y || (x.updatedAt || 0) >= (y.updatedAt || 0)) m.set(x.id, x); });
      out[k] = Array.from(m.values());
    });
    return out;
  }

  async function whenIdle() { // 別のダイアログを開いているあいだは、確認ダイアログを出さずに待つ
    for (let i = 0; i < 600 && root.document.getElementById('dlg').open; i++) await sleep(500);
  }

  /** 同期が成功した記録。lastCounts は「前回の同期のときの教科数・ノート数」で、急に減っていないかの見張りに使う */
  function markSynced(extra) {
    Object.assign(book, extra, { lastSync: Date.now(), lastCounts: countOf(LN.contentOf(LN.state)) });
    saveBook();
  }

  async function pull(file, remote, folderId, why) {
    applying = true;
    try {
      if (!LN.contentIsEmpty(LN.contentOf(LN.state))) await LN.snapshotLocal(why || 'ドライブから取り込む前');
      const failed = await downloadImages(folderId, remote);
      await LN.replaceContent(remote);
      markSynced({ folderId, fileId: file.id, baseVersion: file.version, lastHash: hash(LN.contentJson()), dirty: false });
      U.reload();
      if (failed) toast('画像 ' + failed + ' 枚を取り込めませんでした。あとでもう一度「今すぐ同期」を試してください');
    } finally { applying = false; }
  }

  async function pushTo(folderId, fileId) {
    const contentStr = LN.contentJson(), h = hash(contentStr); // 送る内容と指紋は、同じ瞬間のものにそろえる
    await uploadImages(folderId, LN.usedImageIds());
    const res = await updateState(fileId, stateText(contentStr));
    markSynced({ folderId, fileId, baseVersion: res.version, lastHash: h });
    book.dirty = hash(LN.contentJson()) !== h; // 送っているあいだに、さらに編集されていたら、まだ「変更あり」
    saveBook();
    if (book.dirty) schedulePush(1000);
  }

  /** ノートが前回の同期のときより大きく減っていないか（ブラウザ側のデータが壊れて空になったのを、ドライブに上書きしないための見張り） */
  function shrunkSharply(local) {
    const prev = book.lastCounts, now = countOf(local);
    if (!prev || (prev.subs + prev.notes) === 0) return false;
    if (now.subs + now.notes === 0) return true;
    return prev.notes >= 4 && now.notes < prev.notes * 0.5;
  }
  let deferUntil = 0; // 「今は決めない」を選んだあと、しばらくは確認を出し直さない
  async function askShrunk(local, file) {
    if (Date.now() < deferUntil) return null;
    await whenIdle();
    setStatus('conflict');
    const P = book.lastCounts, N = countOf(local);
    const r = await U.ask({
      title: 'ノートが大きく減っています',
      message: 'このブラウザのノートが、前回ドライブと同期したときより大きく減っています。<br><br>前回：<b>' + P.subs + '教科・' + P.notes + 'ノート</b>　→　今：<b>' + N.subs + '教科・' + N.notes + 'ノート</b><br><br>' +
        '自分で削除したのでなければ、ドライブの内容に戻すのが安全です。どちらを選んでも、使わなかった側は「安全コピー」に残ります。',
      fields: [{ name: 'choice', label: 'どうしますか？', type: 'select', options: [['drive', 'ドライブの内容に戻す（おすすめ）'], ['local', '今の内容をドライブに保存する（自分で削除した場合）']] }],
      ok: '決定', cancelText: '今は決めない',
    });
    if (!r) { deferUntil = Date.now() + 10 * 60 * 1000; return null; }
    return r.choice;
  }

  async function chooseOnConflict(local, remote, file, manual) {
    if (!manual && Date.now() < deferUntil) return null;
    await whenIdle();
    setStatus('conflict');
    const L = countOf(local), R = countOf(remote);
    const when = file.modifiedTime ? new Date(file.modifiedTime).toLocaleString('ja-JP') : '';
    const r = await U.ask({
      title: 'ノートが2か所にあります',
      message: 'Google ドライブとこのブラウザの両方に、違う内容のノートがあります。<br><br>' +
        'ドライブ：<b>' + R.subs + '教科・' + R.notes + 'ノート</b>' + (when ? '（' + esc(when) + ' 更新）' : '') + '<br>' +
        'このブラウザ：<b>' + L.subs + '教科・' + L.notes + 'ノート</b><br><br>' +
        'どれを選んでも、使わなかった側の内容は「安全コピー」に残り、あとから戻せます。',
      fields: [{ name: 'choice', label: 'どうしますか？', type: 'select', options: [
        ['merge', '両方を合わせる（おすすめ。同じノートは新しいほうを使います）'],
        ['drive', 'ドライブの内容を使う（このブラウザの内容は置き換わります）'],
        ['local', 'このブラウザの内容を使う（ドライブの内容は置き換わります）'],
      ] }],
      ok: '決定', cancelText: '今は決めない',
    });
    if (!r) { deferUntil = Date.now() + 10 * 60 * 1000; return null; }
    return r.choice;
  }

  /** ドライブとこのブラウザを突き合わせる。人が操作してよい（確認ダイアログを出してよい）のは、衝突したときだけ */
  async function reconcile(o) {
    const manual = !!(o && o.manual);
    return exclusive(async () => {
      if (!tokenOk()) throw new DriveError(401, 'token');
      setStatus('syncing');
      let folderId = book.folderId, file = null;
      if (book.fileId && folderId) { // 速い道：前回と同じファイルを直接見る
        try { const m = await getMeta(book.fileId); if (!m.trashed) file = m; } catch (e) { if (!(e instanceof DriveError) || e.status !== 404) throw e; }
      }
      if (!file) { folderId = await ensureFolder(); file = await findState(folderId); }

      const content = LN.contentOf(LN.state), contentStr = LN.contentJson(), curHash = hash(contentStr);
      const localEmpty = LN.contentIsEmpty(content);

      if (!file) { // ドライブにまだ何も無い：このブラウザの内容を、最初の保存として置く
        const created = await createState(folderId, stateText(contentStr));
        await uploadImages(folderId, LN.usedImageIds());
        markSynced({ folderId, fileId: created.id, baseVersion: created.version, lastHash: curHash, dirty: false });
        return settle();
      }

      const neverSynced = book.baseVersion == null || book.fileId !== file.id;
      const remoteChanged = neverSynced || String(file.version) !== String(book.baseVersion);
      const localChanged = !neverSynced && (book.dirty || curHash !== book.lastHash);

      // ドライブ側に変わりが無い（こちらの変更だけ、または何も無い）場合の処理
      const localOnly = async () => {
        if (localChanged) {
          if (shrunkSharply(content)) { // 急に減っている：確認なしでドライブを上書きしない
            const pick = await askShrunk(content, file);
            if (!pick) { setStatus('conflict'); return; }
            const remoteNow = parseState(await readState(file.id));
            if (pick === 'drive' && remoteNow) { await pull(file, remoteNow, folderId, 'ドライブの内容に戻す前'); toast('ドライブの内容に戻しました'); return settle(); }
            if (remoteNow) await LN.snapshotLocal('ドライブの内容（置き換える前）', remoteNow, {});
          }
          await pushTo(folderId, file.id);
        } else { markSynced({ dirty: false }); }
        return settle();
      };
      if (!remoteChanged) return localOnly();

      // 版の番号が違う。ただし、ドライブは中身を変えていなくても番号だけ進めることがある
      // （実際に、作成直後に 1→2 になった）ので、番号ではなく中身で判断する
      const remote = parseState(await readState(file.id));
      if (!remote) throw new Error('ドライブのノートのファイルを読み取れませんでした');
      const remoteHash = hash(JSON.stringify(LN.contentOf(remote)));
      if (!neverSynced && remoteHash === book.lastHash) { // 前回こちらが置いた内容のまま：他の端末は何も変えていない
        book.baseVersion = file.version; saveBook();
        return localOnly();
      }

      if (neverSynced && remoteHash === curHash) { // 中身が同じ：つなぐだけ
        await uploadImages(folderId, LN.usedImageIds());
        markSynced({ folderId, fileId: file.id, baseVersion: file.version, lastHash: curHash, dirty: false });
        return settle();
      }
      if ((neverSynced && localEmpty) || (!neverSynced && !localChanged)) { // こちらに守るべき変更が無い：ドライブの内容を取り込む
        await pull(file, remote, folderId, 'ドライブから取り込む前');
        if (!neverSynced) toast('他の端末での変更を取り込みました');
        return settle();
      }

      // こちらにも、ドライブにも、違う内容がある
      const choice = await chooseOnConflict(content, remote, file, manual);
      if (!choice) { setStatus('conflict'); return; }
      if (choice === 'drive') {
        await pull(file, remote, folderId, 'ドライブの内容に置き換える前');
      } else if (choice === 'merge') {
        await LN.snapshotLocal('合わせる前（このブラウザの内容）');
        await LN.snapshotLocal('合わせる前（ドライブの内容）', remote, {});
        const merged = mergeContent(content, remote);
        applying = true;
        try { await downloadImages(folderId, merged); await LN.replaceContent(merged); } finally { applying = false; }
        U.reload();
        await pushTo(folderId, file.id);
        toast('2つのノートを合わせて、ドライブに保存しました');
      } else {
        await LN.snapshotLocal('ドライブの内容（置き換える前）', remote, {});
        await pushTo(folderId, file.id);
        toast('このブラウザの内容を、ドライブに保存しました');
      }
      return settle();
    });
  }

  async function guarded(fn) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof DriveError && e.status === 401) { token = null; setStatus('needlogin'); armAutoReconnect(); }
      else if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) { setStatus('offline'); retryLater(30000); }
      else { console.error(e); setStatus('error', e && e.message); retryLater(60000); }
      return null;
    }
  }
  function retryLater(ms) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { if (book.enabled && tokenOk()) c.sync(); }, ms); }
  function schedulePush(delay) {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      if (!book.enabled) return;
      if (tokenOk()) c.sync(); else { setStatus('needlogin'); armAutoReconnect(); }
    }, delay == null ? cfg.pushDelayMs : delay);
  }
  c.sync = (o) => guarded(() => reconcile(o));

  /* 保存が終わるたびに、中身が変わったか調べて、変わっていればドライブへの保存を予約する */
  LN.onFlushed = () => {
    if (applying || !book.enabled) return;
    book.dirty = hash(LN.contentJson()) !== book.lastHash;
    saveBook();
    if (!book.dirty) return;
    if (c.status === 'synced') setStatus('pending');
    schedulePush();
  };

  /* ---------- ログイン／ログアウト ---------- */
  function popupCode(e) { return e && (e.code === 'popup_closed' || e.code === 'popup_failed_to_open' || e.code === 'access_denied'); }

  async function connect(o) {
    o = o || {};
    if (connecting) return false;
    connecting = true;
    c.lastError = ''; // うまくいかなかった理由（ホームページの案内に使う）：'popup' / 'scope' / 'blocked' / 'cancel' / エラー文
    setStatus('connecting');
    try {
      const r = await requestToken(o.prompt != null ? o.prompt : (book.email ? '' : 'select_account'), o.hint != null ? o.hint : book.email);
      if (!/drive\.file/.test(r.scope || '')) {
        c.lastError = 'scope';
        setStatus(book.enabled ? 'needlogin' : 'off');
        if (!o.auto && !o.quiet) await U.ask({ title: 'ドライブへの保存が許可されていません', message: 'ログインの途中で、Google ドライブの項目のチェックが外れたようです。自動保存には、その許可が必要です（許可するのは「このアプリが作ったファイル」だけです）。もう一度ログインして、すべての項目にチェックを入れてください。', ok: '閉じる', hideCancel: true });
        return false;
      }
      token = r.access_token; tokenExp = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 120000;
      const info = await apiJson(cfg.userinfo);
      if (!info || !info.sub) throw new Error('アカウント情報を取得できませんでした');

      const roster = await rosterCheck();
      c.rosterStatus = roster; // 'ok' / 'disabled' / 'unknown:…'（名簿に届かなかった理由。確認用）
      if (roster.startsWith('unknown')) console.warn('名簿への記録に失敗しました（利用は続けられます）：', roster);
      if (roster === 'disabled') { c.lastError = 'blocked'; token = null; setStatus('blocked'); if (!o.quiet) showBlocked(info); return false; }

      if (book.sub && book.sub !== info.sub) { // このブラウザのノートは別のアカウントのもの
        if (!(await confirmSwitch(info))) { c.lastError = 'cancel'; token = null; setStatus(book.enabled ? 'needlogin' : 'off'); return false; }
        applying = true;
        try {
          await LN.snapshotLocal('アカウントを切り替える前');
          book = { images: {} };
          await LN.replaceContent({});
        } finally { applying = false; }
        U.reload(); // 表示を空に（このあと、新しいアカウントのドライブの内容を取り込む）
      }
      Object.assign(book, { sub: info.sub, email: info.email || '', name: info.name || '', enabled: true });
      saveBook();
      autoTried = false;
      await guarded(() => reconcile({ manual: !o.auto }));
      return true;
    } catch (e) {
      token = null;
      c.lastError = popupCode(e) ? 'popup' : (e && e.message) || 'error';
      setStatus(book.enabled ? 'needlogin' : 'off');
      if (!o.auto && !o.quiet) toast(popupCode(e) ? 'ログインが完了しませんでした。もう一度お試しください（ポップアップがブロックされていないか確認してください）' : 'ログインできませんでした：' + e.message);
      return false;
    } finally { connecting = false; }
  }

  async function confirmSwitch(info) {
    const unsynced = !!book.dirty;
    return !!(await U.ask({
      title: '別のアカウントでログインします',
      message: 'このブラウザのノートは <b>' + esc(book.email || '別のアカウント') + '</b> のものです。<b>' + esc(info.email || '') + '</b> でログインすると、表示が、そのアカウントのドライブにあるノートに入れ替わります。<br><br>' +
        '今のノートは「安全コピー」としてこのブラウザに残り、' + esc(book.email || '元のアカウント') + ' のドライブに保存済みの分も消えません。' +
        (unsynced ? '<br><br><b style="color:var(--danger)">ただし、まだドライブに保存できていない変更があります。念のため、先に「バックアップ」から「ファイルに書き出す」をしておくことをおすすめします。</b>' : ''),
      ok: '切り替える', cancelText: 'やめる', danger: unsynced,
    }));
  }

  function showBlocked(info) {
    U.ask({ title: 'このアカウントは利用停止中です', message: '<b>' + esc((info && info.email) || '') + '</b> は、現在ご利用いただけません。心当たりがない場合は、フィードバックからお知らせください。<br><br>このブラウザに保存されているノートは消えません。「バックアップ」からファイルに書き出せます。', ok: '閉じる', hideCancel: true });
  }

  function logout() {
    token = null; tokenExp = 0;
    book.enabled = false; saveBook();
    lsSet(SKIP_KEY, true); // やめた人に、次回また最初のごあいさつを出さない
    clearTimeout(pushTimer);
    setStatus('off');
    toast('自動保存をやめました。ノートはこのブラウザに残っています');
  }

  /** 次の操作（クリック／キー入力）のときに、一度だけ静かに再接続を試す（ポップアップは操作の直後でないと開けないため） */
  function armAutoReconnect() {
    if (armed || autoTried || !book.enabled) return;
    armed = true;
    const off = () => { ['pointerdown', 'keydown'].forEach((ev) => document.removeEventListener(ev, h, true)); armed = false; };
    const h = (ev) => {
      if (!book.enabled || tokenOk() || connecting || c.status === 'blocked') { if (tokenOk()) off(); return; }
      const t = ev.target;
      if (t && t.closest && t.closest('dialog, #cloudChip')) return;
      off(); autoTried = true;
      connect({ prompt: '', hint: book.email, auto: true });
    };
    ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, h, true));
  }

  /* ---------- 画面 ---------- */
  const PRIVACY = '<div class="bk-box">' +
    '<b>運営（このアプリの作者）に見えるもの：</b>ログインしたアカウントの一覧（メールアドレス・名前）だけです。<br>' +
    '<b>運営に見えないもの：</b>ノートの中身。ノートは<b>あなた自身の Google ドライブ</b>に保存され、運営は読めません。<br>' +
    'このアプリが使う権限は「このアプリが作ったファイルだけ」で、ドライブの他のファイルには触れません。</div>';

  function closeDlg() { const d = root.document.getElementById('dlg'); if (d && d.open) d.close(); }
  const fmt = (t) => (t ? new Date(t).toLocaleString('ja-JP') : 'まだありません');

  async function openDialog() {
    const snaps = await LN.listSnapshots().catch(() => []);
    const d = describe();
    let body;
    if (!book.enabled) {
      preloadGis();
      body = '<p class="dlg-msg">Google でログインすると、ノートが自動で<b>あなたの Google ドライブ</b>（「講義ノート」フォルダ）に保存されます。別のパソコンでも、同じアカウントでログインすれば続きから使えます。</p>' + PRIVACY +
        '<div style="margin-top:10px"><button type="button" class="btn primary" data-act="cloud-login">Google でログイン</button></div>';
    } else {
      const link = book.folderId ? '<a href="https://drive.google.com/drive/folders/' + encodeURIComponent(book.folderId) + '" target="_blank" rel="noopener noreferrer">ドライブで保存先を開く</a>' : '';
      body = '<div class="bk-box' + (d.dot === 'dotwarn' ? ' warn' : '') + '">アカウント：<b>' + esc(book.email || '') + '</b><br>状態：<b>' + esc(d.text) + '</b>' + (c.message ? '（' + esc(c.message) + '）' : '') +
        '<br>最後に同期：<b>' + esc(fmt(book.lastSync)) + '</b>' + (link ? '<br>' + link : '') + '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">' +
        (tokenOk() ? '<button type="button" class="btn primary" data-act="cloud-sync">今すぐ同期</button>' : '<button type="button" class="btn primary" data-act="cloud-login">再接続</button>') +
        '<button type="button" class="btn" data-act="cloud-switch">別のアカウントでログイン</button>' +
        '<button type="button" class="btn" data-act="cloud-logout">自動保存をやめる</button></div>' + '<div style="margin-top:10px">' + PRIVACY + '</div>' +
        (snaps.length ? '<div class="help-sec"><b>安全コピー</b>（置き換える前の状態を、ブラウザの中に自動で残しています）<br>' +
          snaps.map((s, i) => esc(new Date(s.at).toLocaleString('ja-JP')) + '　' + esc(s.reason) + '　<button type="button" class="btn sm" data-act="cloud-restore" data-i="' + i + '">この状態に戻す</button>').join('<br>') + '</div>' : '');
    }
    U.ask({ title: 'ログインと自動保存', ok: '閉じる', hideCancel: true, body });
  }

  /* ホームページ（landing.js）から使う入口 */
  c.lastError = '';
  c.preload = preloadGis;
  /** 「パソコン版／スマホ版」を選んだあとのログイン。成功すれば true（失敗の理由は c.lastError）。案内の画面に出すので、ダイアログやトーストは出さない */
  c.startLogin = async () => {
    const okk = await connect({ prompt: 'select_account', quiet: true });
    return !!(okk && book.enabled);
  };
  /** 「ログインせずに使う」：ホームページを次回から出さない */
  c.skipLogin = () => lsSet(SKIP_KEY, true);

  c.init = function (ui) {
    U = ui;
    const A = U.actions;
    A['cloud'] = () => openDialog();
    A['cloud-login'] = () => { closeDlg(); connect({ prompt: book.email ? '' : 'select_account' }); };
    A['cloud-switch'] = () => { closeDlg(); connect({ prompt: 'select_account', hint: '' }); };
    A['cloud-sync'] = async () => { closeDlg(); toast('同期しています…'); await c.sync({ manual: true }); if (c.status === 'synced') toast('同期しました'); };
    A['cloud-logout'] = async () => {
      closeDlg();
      if (await U.ask({ title: '自動保存をやめますか？', message: 'このブラウザでの自動保存を止めます。Google ドライブに保存済みのノートはそのまま残り、このブラウザのノートも消えません。', ok: 'やめる', cancelText: 'キャンセル' })) logout();
    };
    A['cloud-restore'] = async (el) => {
      const list = await LN.listSnapshots(), s = list[Number(el.dataset.i)];
      if (!s) return;
      closeDlg();
      if (!(await U.ask({ title: '安全コピーに戻す', message: esc(new Date(s.at).toLocaleString('ja-JP')) + ' の状態（' + esc(s.reason) + '）に戻します。今の状態も、もう一度安全コピーとして残します。', ok: '戻す', cancelText: 'キャンセル' }))) return;
      const j = JSON.parse(s.json);
      await LN.snapshotLocal('安全コピーに戻す前');
      for (const id of Object.keys(j.images || {})) await LN.putImage(id, j.images[id]);
      await LN.replaceContent(j.content || {});
      U.reload(); toast('戻しました');
    };
  };

  /** 画面を描いたあとに呼ぶ：初回のごあいさつ／前回ログイン済みなら再接続の準備 */
  c.start = function () {
    if (started) return; started = true;
    if (book.enabled) { // 前回ログイン済み：画面はすぐ使える。ドライブへは、再接続できしだい同期する
      preloadGis();
      setStatus('needlogin');
      armAutoReconnect();
    }
    root.document.addEventListener('visibilitychange', () => { if (!root.document.hidden && book.enabled && tokenOk()) c.sync(); });
    setInterval(() => { if (!root.document.hidden && book.enabled && tokenOk() && !connecting) c.sync(); }, cfg.pollMs);
  };

  /* テストから状態を見るための窓口（本番の動作には使わない） */
  c._test = { book: () => book, token: () => token, expire: () => { tokenExp = 0; }, hash, tokenOk };
})(window);
