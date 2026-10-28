/* 棚の通信（Firestore の REST）。通信は、ここだけに閉じ込める（人数が増えて別の置き場へ移すときも、画面は変えずに済むように）。
 *  - 低い層：getDoc・listDocs・commit（値の変換つき）。書き込みは、規則が「同じまとまりで、証拠の文書も作られているか」を確かめるので、必ず commit のまとまりで送る。
 *  - 高い層：プロフィール・参加中の棚・棚を作る・招待コードで参加 など（段階1）。
 *  - 日時は、サーバー時刻の印（REQUEST_TIME）を使う（規則の request.time と一致する）。数の増減は increment。
 *  - 返す値は、{ ok:true, … } か { ok:false, code, message }。code は denied / notfound / exists / precondition / timeout / network / httpNNN。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const FB = LN.fbConfig || {};
  const A = (S.api = { cfg: { docs: FB.docs, key: FB.apiKey, timeoutMs: 15000 } });

  const docName = () => String(A.cfg.docs).replace(/^https?:\/\/[^/]+\/v1\//, '');

  /* ---------- 値の変換（JavaScript ⇔ Firestore の値） ---------- */
  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    const f = {}; Object.keys(v).forEach((k) => { f[k] = enc(v[k]); });
    return { mapValue: { fields: f } };
  }
  function dec(f) {
    if (!f || typeof f !== 'object') return null;
    if ('stringValue' in f) return f.stringValue;
    if ('booleanValue' in f) return f.booleanValue;
    if ('integerValue' in f) return Number(f.integerValue);
    if ('doubleValue' in f) return f.doubleValue;
    if ('timestampValue' in f) return f.timestampValue;
    if ('arrayValue' in f) return ((f.arrayValue && f.arrayValue.values) || []).map(dec);
    if ('mapValue' in f) { const o = {}; const m = (f.mapValue && f.mapValue.fields) || {}; Object.keys(m).forEach((k) => { o[k] = dec(m[k]); }); return o; }
    return null;
  }
  const encFields = (o) => { const f = {}; Object.keys(o || {}).forEach((k) => { f[k] = enc(o[k]); }); return f; };
  const decFields = (f) => { const o = {}; Object.keys(f || {}).forEach((k) => { o[k] = dec(f[k]); }); return o; };
  A._enc = enc; A._dec = dec;

  /* ---------- 書き込みの部品（commit に渡す） ---------- */
  const transforms = (o) => []
    .concat(((o && o.time) || []).map((p) => ({ fieldPath: p, setToServerValue: 'REQUEST_TIME' })))
    .concat(Object.keys((o && o.inc) || {}).map((p) => ({ fieldPath: p, increment: { integerValue: String(o.inc[p]) } })));
  const withT = (w, o) => { const t = transforms(o); if (t.length) w.updateTransforms = t; return w; };
  const W = (A.w = {
    /** 新しい文書を作る（すでにあれば失敗）。o.time＝サーバー時刻を入れる欄の名前 */
    create: (path, fields, o) => withT({ update: { name: docName() + '/' + path, fields: encFields(fields) }, currentDocument: { exists: false } }, o),
    /** 既存の文書の一部を書き換える。mask＝書き換える欄。o.inc＝増減する数（{ 欄: 1 }）、o.time＝サーバー時刻の欄 */
    patch: (path, fields, mask, o) => withT({ update: { name: docName() + '/' + path, fields: encFields(fields) }, updateMask: { fieldPaths: mask || [] }, currentDocument: { exists: true } }, o),
    del: (path) => ({ delete: docName() + '/' + path }),
  });

  /* ---------- 通信 ---------- */
  async function call(method, url, body) {
    const tok = await LN.shelf.auth.token();
    if (!tok) return { ok: false, code: 'login', message: 'ログインが切れました。もう一度ログインしてください。' };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), A.cfg.timeoutMs) : 0;
    try {
      const headers = Object.assign({ Authorization: 'Bearer ' + tok }, S.appcheck ? await S.appcheck.headers() : {});
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(A.cfg.key || ''), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined });
      let j = null; try { j = await r.json(); } catch (e) { /* 本文なし */ }
      if (r.ok) return { ok: true, json: j || {} };
      const st = (j && j.error && j.error.status) || '';
      const code = r.status === 404 || st === 'NOT_FOUND' ? 'notfound' : r.status === 403 || st === 'PERMISSION_DENIED' ? 'denied' : st === 'ALREADY_EXISTS' ? 'exists'
        : st === 'FAILED_PRECONDITION' || st === 'ABORTED' ? 'precondition' : r.status === 401 ? 'login' : 'http' + r.status;
      return { ok: false, code, status: r.status, message: A.explain(code, r.status) };
    } catch (e) {
      const t = e && e.name === 'AbortError';
      return { ok: false, code: t ? 'timeout' : 'network', message: A.explain(t ? 'timeout' : 'network') };
    } finally { if (timer) clearTimeout(timer); }
  }
  A.explain = function (code, status) {
    return ({
      login: 'ログインが切れました。もう一度ログインしてください。',
      denied: 'この操作は、許可されていません。',
      notfound: '見つかりませんでした。',
      exists: 'すでにあります。',
      precondition: 'ほかの操作と重なりました。もう一度お試しください。',
      timeout: '通信に時間がかかりすぎました。もう一度お試しください。',
      network: 'インターネットにつながりませんでした。',
    })[code] || '通信に失敗しました（' + (status || code) + '）。';
  };

  /** 文書を1つ読む。{ ok:true, exists:false } か { ok:true, exists:true, fields, id } */
  A.getDoc = async function (path) {
    const r = await call('GET', A.cfg.docs + '/' + path);
    if (!r.ok) return r.code === 'notfound' ? { ok: true, exists: false } : r;
    return { ok: true, exists: true, id: String(r.json.name || '').split('/').pop(), fields: decFields(r.json.fields) };
  };
  /** コレクションの文書を、すべて読む（300件ずつ・最大40ページ） */
  A.listDocs = async function (path) {
    const out = []; let page = '';
    for (let i = 0; i < 40; i++) {
      const r = await call('GET', A.cfg.docs + '/' + path + '?pageSize=300' + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
      if (!r.ok) return r.code === 'notfound' ? { ok: true, docs: out } : r;
      (r.json.documents || []).forEach((d) => out.push({ id: String(d.name || '').split('/').pop(), fields: decFields(d.fields) }));
      page = r.json.nextPageToken || ''; if (!page) break;
    }
    return { ok: true, docs: out };
  };
  /** 書き込みを、1つのまとまりで送る（全部成功か、全部失敗） */
  A.commit = async function (writes) {
    const r = await call('POST', A.cfg.docs + ':commit', { writes });
    return r.ok ? { ok: true } : r;
  };

  /* ---------- プロフィール ---------- */
  A.getProfile = async function (uid) {
    const r = await A.getDoc('profiles/' + uid);
    if (!r.ok || !r.exists) return r;
    const f = r.fields;
    return { ok: true, exists: true, nick: String(f.nick || ''), banned: f.banned === true, shelfCount: Number(f.shelfCount) || 0 };
  };
  A.createProfile = (uid, nick) => A.commit([W.create('profiles/' + uid, { nick, shelfCount: 0 }, { time: ['created'] })]);

  /* ---------- 棚 ---------- */
  /** 参加中の棚の一覧（新しく参加した順） */
  A.myShelves = async function (uid) {
    const r = await A.listDocs('profiles/' + uid + '/joined');
    if (!r.ok) return r;
    return { ok: true, shelves: r.docs.map((d) => ({ sid: d.id, name: String(d.fields.name || ''), joined: String(d.fields.joined || '') })).sort((a, b) => b.joined.localeCompare(a.joined)) };
  };
  A.getShelf = async function (sid) {
    const r = await A.getDoc('shelves/' + sid);
    if (!r.ok || !r.exists) return r;
    const f = r.fields;
    return { ok: true, exists: true, sid, name: String(f.name || ''), rules: String(f.rules || ''), memberCount: Number(f.memberCount) || 0, open: f.open === true, createdBy: String(f.createdBy || ''), created: String(f.created || ''), rankedAt: String(f.rankedAt || '') };
  };
  A.getMember = async function (sid, uid) {
    const r = await A.getDoc('shelves/' + sid + '/members/' + uid);
    if (!r.ok || !r.exists) return r;
    const f = r.fields;
    return { ok: true, exists: true, role: String(f.role || ''), banned: f.banned === true, nick: String(f.nick || ''), code: String(f.code || '') };
  };
  /** 招待コード → 棚の ID */
  A.lookupInvite = async function (code) {
    const r = await A.getDoc('invites/' + code);
    if (!r.ok || !r.exists) return r;
    return { ok: true, exists: true, sid: String(r.fields.sid || '') };
  };

  /** 棚を作る。1回のまとまりで、棚・管理者のメンバー・招待コード・参加一覧・最上位のフォルダ・作った数 を書く */
  A.createShelf = async function (o) {
    const M = S.model;
    const sid = M.newShelfId(), code = M.newCode();
    const r = await A.commit([
      W.create('shelves/' + sid, { name: o.name, rules: o.rules, createdBy: o.uid, memberCount: 1, open: true }, { time: ['created'] }),
      W.create('shelves/' + sid + '/members/' + o.uid, { role: 'admin', nick: o.nick, banned: false, code }, { time: ['joined'] }),
      W.create('invites/' + code, { sid }, { time: ['created'] }),
      W.create('profiles/' + o.uid + '/joined/' + sid, { name: o.name }, { time: ['joined'] }),
      W.create('shelves/' + sid + '/folders/root', { parent: '', depth: 0, createdBy: o.uid, children: {}, likes: {} }, { time: ['created'] }),
      W.patch('profiles/' + o.uid, {}, [], { inc: { shelfCount: 1 } }),
    ]);
    return r.ok ? { ok: true, sid, code } : r;
  };
  /** 招待コードで参加する。メンバーの文書・人数 +1・参加一覧 を、1回のまとまりで書く */
  A.joinShelf = async function (o) {
    return A.commit([
      W.create('shelves/' + o.sid + '/members/' + o.uid, { role: 'member', nick: o.nick, banned: false, code: o.code }, { time: ['joined'] }),
      W.patch('shelves/' + o.sid, {}, [], { inc: { memberCount: 1 } }),
      W.create('profiles/' + o.uid + '/joined/' + o.sid, { name: o.shelfName }, { time: ['joined'] }),
    ]);
  };
  /** 管理者の設定：メンバーもフォルダを作れるか */
  A.setOpen = (sid, open) => A.commit([W.patch('shelves/' + sid, { open: !!open }, ['open'], {})]);

  /* ---------- フォルダ（段階2） ----------
   * フォルダの文書 folders/{fid} は、直下の中身の一覧（children）を持つ。項目の追加・削除・書き換えは、children の「1項目だけ」を書き、
   * 規則に、どの項目を変えたかを知らせるため last（その項目の ID）も一緒に書く。サブフォルダは、親の項目の追加と、サブフォルダの文書の作成を、1回のまとまりで送る。 */
  const fp = (...seg) => seg.map((s) => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(s) ? s : '`' + String(s).replace(/`/g, '\\`') + '`')).join('.'); // 欄の道筋（数字で始まる名前などは引用符で囲む）
  const folderPath = (sid, fid) => 'shelves/' + sid + '/folders/' + fid;
  const asEntries = (m) => Object.keys(m || {}).map((id) => Object.assign({ id }, m[id]));

  /** フォルダの文書を読む。children は項目の配列（{ id, type, name, createdBy, authorNick, created, … }） */
  A.getFolder = async function (sid, fid) {
    const r = await A.getDoc(folderPath(sid, fid));
    if (!r.ok || !r.exists) return r;
    const f = r.fields;
    return { ok: true, exists: true, fid, parent: String(f.parent == null ? '' : f.parent), depth: Number(f.depth) || 0, createdBy: String(f.createdBy || ''), children: asEntries(f.children), likes: f.likes || {} };
  };
  /** サブフォルダを作る（親の children に項目を足し、サブフォルダの文書を作る） */
  A.addFolder = async function (o) {
    const fid = S.model.newFolderId();
    const r = await A.commit([
      W.patch(folderPath(o.sid, o.parent), { children: { [fid]: { type: 'folder', name: o.name, createdBy: o.uid, authorNick: o.nick } }, last: fid }, [fp('children', fid), 'last'], { time: [fp('children', fid, 'created')] }),
      W.create(folderPath(o.sid, fid), { parent: o.parent, depth: o.parentDepth + 1, createdBy: o.uid, children: {}, likes: {} }, { time: ['created'] }),
    ]);
    return r.ok ? { ok: true, fid } : r;
  };
  /** 項目の名前を変える（作った人か管理者） */
  A.renameEntry = (o) => A.commit([
    W.patch(folderPath(o.sid, o.parent), { children: { [o.id]: { name: o.name } }, last: o.id }, [fp('children', o.id, 'name'), 'last'], {}),
  ]);
  /* ---------- 投稿（段階3）：フォルダの children に、type='post' の項目を足す・消す。ファイルの中身は投稿者のドライブにある ---------- */
  /** 投稿の項目を足す。pid は呼び出し側で作る（ドライブのファイルの印に使うため）。日時はサーバー時刻 */
  A.addPost = async function (o) {
    const pid = o.pid || S.model.newPostId();
    const e = { type: 'post', name: o.name, createdBy: o.uid, authorNick: o.nick, driveId: o.driveId, kind: o.kind, mime: o.mime, size: o.size, edit: o.edit };
    if (o.derivedFrom) e.derivedFrom = o.derivedFrom;     // 派生版：同じフォルダの、編集OKの投稿（ノート）が元
    const r = await A.commit([
      W.patch(folderPath(o.sid, o.parent), { children: { [pid]: e }, last: pid }, [fp('children', pid), 'last'], { time: [fp('children', pid, 'created')] }),
    ]);
    return r.ok ? { ok: true, pid } : r;
  };
  /** 項目（投稿）を目次から消す（投稿した人か管理者）。ドライブのファイルには触れない */
  A.removeEntry = (o) => A.commit([
    W.patch(folderPath(o.sid, o.parent), { last: o.id }, [fp('children', o.id), 'last'], {}),
  ]);

  /* ---------- いいね（段階4） ----------
   * 押す・取り消す：自分の likes/{uid} の nids（投稿ID → true）に、1項目だけ足す・消す。数えるのは、週に1回、管理者の端末（runTally）。 */
  /** 自分のいいねの一覧。{ ok:true, exists, nids:{ 投稿ID:true } } */
  A.getMyLikes = async function (sid, uid) {
    const r = await A.getDoc('shelves/' + sid + '/likes/' + uid);
    if (!r.ok) return r;
    return { ok: true, exists: !!r.exists, nids: r.exists && r.fields.nids && typeof r.fields.nids === 'object' ? r.fields.nids : {} };
  };
  /** 押す（on=true）・取り消す（on=false）。exists＝自分のいいねの文書がすでにあるか（無ければ作る） */
  A.setLike = async function (o) {
    const path = 'shelves/' + o.sid + '/likes/' + o.uid;
    if (!o.exists) {
      if (!o.on) return { ok: true };
      const r = await A.commit([W.create(path, { nids: { [o.pid]: true } }, { time: ['updated'] })]);
      if (r.ok || r.code !== 'exists') return r;      // 別の端末で、先に作られていた：足し直す
    }
    return A.commit([W.patch(path, o.on ? { nids: { [o.pid]: true } } : {}, [fp('nids', o.pid)], { time: ['updated'] })]);   // 日時（updated）は、更新の欄ではなく、サーバー時刻の印で入れる
  };
  /** 週に1回の集計（管理者）：全員のいいね・メンバー・フォルダを読み、投稿ごとの数を数えて、変わったフォルダの likes と、棚の rankedAt を書く */
  A.runTally = async function (sid) {
    const [mem, lk, fl] = await Promise.all([A.listDocs('shelves/' + sid + '/members'), A.listDocs('shelves/' + sid + '/likes'), A.listDocs('shelves/' + sid + '/folders')]);
    for (const r of [mem, lk, fl]) if (!r.ok) return r;
    const t = S.model.tally({
      members: mem.docs.map((d) => ({ id: d.id, banned: d.fields.banned === true })),
      likes: lk.docs.map((d) => ({ id: d.id, nids: d.fields.nids || {} })),
      folders: fl.docs.map((d) => ({ id: d.id, children: d.fields.children || {}, likes: d.fields.likes || {} })),
    });
    for (let i = 0; i < t.updates.length; i += 100) {
      const r = await A.commit(t.updates.slice(i, i + 100).map((u) => W.patch(folderPath(sid, u.id), { likes: u.likes }, ['likes'], {})));
      if (!r.ok) return r;
    }
    const r = await A.commit([W.patch('shelves/' + sid, { memberCount: mem.docs.length }, ['memberCount'], { time: ['rankedAt'] })]);
    return r.ok ? { ok: true, changed: t.updates.length, likers: lk.docs.length, total: Object.keys(t.counts).length } : r;
  };

  /* ---------- 管理者の道具・通報（段階5） ---------- */
  /** メンバーの一覧（管理者だけ）。新しく参加した順 */
  A.listMembers = async function (sid) {
    const r = await A.listDocs('shelves/' + sid + '/members');
    if (!r.ok) return r;
    return { ok: true, members: r.docs.map((d) => ({ uid: d.id, nick: String(d.fields.nick || ''), role: String(d.fields.role || ''), banned: d.fields.banned === true, joined: String(d.fields.joined || '') })).sort((a, b) => b.joined.localeCompare(a.joined)) };
  };
  /** 締め出す・解除する（管理者。自分以外） */
  A.setBanned = (sid, uid, banned) => A.commit([W.patch('shelves/' + sid + '/members/' + uid, { banned: !!banned }, ['banned'], {})]);
  /** 棚の名前とルールを変える（管理者）。参加一覧の名前の写しは、各メンバーが、棚を開いたときに直す */
  A.updateShelfInfo = (o) => A.commit([W.patch('shelves/' + o.sid, { name: o.name, rules: o.rules }, ['name', 'rules'], {})]);
  /** 自分の参加一覧の名前を、棚の名前に合わせる（棚の名前が変わっていたとき） */
  A.syncJoinedName = (uid, sid, name) => A.commit([W.patch('profiles/' + uid + '/joined/' + sid, { name }, ['name'], {})]);
  /** 参加一覧から外す（棚が消えていたときなど） */
  A.dropJoined = (uid, sid) => A.commit([W.del('profiles/' + uid + '/joined/' + sid)]);
  /** 招待コードを作り直す（管理者）：新しいコードを作り、管理者のメンバー文書のコードを替え、古いコードを消す。古いコードでは、もう参加できない */
  A.regenInvite = async function (o) {
    const code = S.model.newCode();
    const w = [W.create('invites/' + code, { sid: o.sid }, { time: ['created'] }), W.patch('shelves/' + o.sid + '/members/' + o.uid, { code }, ['code'], {})];
    if (o.oldCode) w.push(W.del('invites/' + o.oldCode));
    const r = await A.commit(w);
    return r.ok ? { ok: true, code } : r;
  };
  /** 投稿を通報する（メンバー。1人が1つの投稿に1回） */
  A.report = (o) => A.commit([W.create('shelves/' + o.sid + '/reports/' + S.model.reportId(o.pid, o.uid), { pid: o.pid, fid: o.fid, name: o.name, reporter: o.uid, reason: o.reason }, { time: ['created'] })]);
  A.listReports = async function (sid) {
    const r = await A.listDocs('shelves/' + sid + '/reports');
    if (!r.ok) return r;
    return { ok: true, reports: r.docs.map((d) => ({ id: d.id, pid: String(d.fields.pid || ''), fid: String(d.fields.fid || ''), name: String(d.fields.name || ''), reporter: String(d.fields.reporter || ''), reason: String(d.fields.reason || ''), created: String(d.fields.created || '') })).sort((a, b) => b.created.localeCompare(a.created)) };
  };
  A.deleteReport = (sid, rid) => A.commit([W.del('shelves/' + sid + '/reports/' + rid)]);
  /** 棚を消す（管理者）：他のメンバー・いいね・通報・フォルダの文書・招待コードを先に消し、最後に、棚と管理者のメンバー文書（と自分の参加一覧）を、1回のまとまりで消す。
   *  （管理者のメンバー文書が先に消えると、あとの削除の権限が無くなるため）。他のメンバーの参加一覧は、本人しか消せないので残る（開くと「棚が無い」と出て、外せる） */
  A.deleteShelf = async function (o) {
    const base = 'shelves/' + o.sid + '/';
    const [mem, lk, rp, fl, lv] = await Promise.all(['members', 'likes', 'reports', 'folders', 'live'].map((c) => A.listDocs(base + c)));
    for (const r of [mem, lk, rp, fl, lv]) if (!r.ok) return r;
    const dels = [];
    mem.docs.filter((d) => d.id !== o.uid).forEach((d) => dels.push(W.del(base + 'members/' + d.id)));
    lk.docs.forEach((d) => dels.push(W.del(base + 'likes/' + d.id)));
    rp.docs.forEach((d) => dels.push(W.del(base + 'reports/' + d.id)));
    fl.docs.forEach((d) => dels.push(W.del(base + 'folders/' + d.id)));
    lv.docs.forEach((d) => dels.push(W.del(base + 'live/' + d.id)));   // 共同編集の作業用の写し（本文）も、一緒に消す
    if (o.code) dels.push(W.del('invites/' + o.code));
    for (let i = 0; i < dels.length; i += 200) {
      const r = await A.commit(dels.slice(i, i + 200));
      if (!r.ok) return r;
    }
    return A.commit([W.del('shelves/' + o.sid), W.del(base + 'members/' + o.uid), W.del('profiles/' + o.uid + '/joined/' + o.sid)]);
  };

  /** 棚から抜ける（管理者以外）：自分のメンバー文書・いいねの文書・参加一覧を消し、人数を 1 減らす。1回のまとまりで。自分の投稿は残る */
  A.leaveShelf = (o) => A.commit([
    W.del('shelves/' + o.sid + '/members/' + o.uid),
    W.patch('shelves/' + o.sid, {}, [], { inc: { memberCount: -1 } }),
    W.del('profiles/' + o.uid + '/joined/' + o.sid),
    W.del('shelves/' + o.sid + '/likes/' + o.uid),
  ]);
  /** プロフィール（表示名）を消す（アカウントの削除の途中。参加一覧は、先に消しておく） */
  A.deleteProfile = (uid) => A.commit([W.del('profiles/' + uid)]);

  /** 消すフォルダの中身を、下まで調べる（件数の確認用）。ids＝消すフォルダの文書の ID（自分と、その下のサブフォルダ）、items＝中身の件数 */
  A.scanTree = async function (sid, fid) {
    const ids = [], stack = [fid]; let items = 0;
    while (stack.length) {
      const id = stack.pop(); ids.push(id);
      if (ids.length > 400) return { ok: false, code: 'toobig', message: 'フォルダの数が多すぎるため、一度に消せません。下のフォルダから順に消してください。' };
      const r = await A.getFolder(sid, id);
      if (!r.ok) return r;
      if (!r.exists) continue;
      r.children.forEach((c) => { items += 1; if (c.type === 'folder') stack.push(c.id); });
    }
    return { ok: true, ids, items };
  };
  /** フォルダを消す（管理者）。親の項目を消し、そのフォルダと下のサブフォルダの文書を、1回のまとまりで消す（ids は scanTree で調べたもの） */
  A.removeFolder = (o) => A.commit([
    W.patch(folderPath(o.sid, o.parent), { last: o.fid }, [fp('children', o.fid), 'last'], {}),
  ].concat(o.ids.map((id) => W.del(folderPath(o.sid, id)))));

  /* ---------- 共同編集（作業用の写し）：shelves/{sid}/live/{pid}。docs/コミュニティ実装計画.md の「共同編集」 ----------
   *  本文は、共同編集のあいだだけここに置く。版（rev）は 1 ずつ増える。書くときは、読んだときの updateTime を「前提」にして送り、
   *  同時に書いた人がいたら、断られる（code: precondition）→ 読み直して合流し、やり直す。 */
  const livePath = (sid, pid) => 'shelves/' + sid + '/live/' + pid;
  const tsMs = (v) => { const t = Date.parse(v); return isNaN(t) ? 0 : t; };
  const parseLive = (id, f, updateTime) => {
    const ed = {}; Object.keys(f.editors || {}).forEach((u) => { ed[u] = tsMs(f.editors[u]); });
    return {
      ok: true, exists: true, pid: id, fid: String(f.fid || ''), owner: String(f.owner || ''), startedBy: String(f.startedBy || ''), title: String(f.title || ''),
      state: f.state === 'pending' ? 'pending' : 'open', rev: Number(f.rev) || 0, enc: f.enc === 'gz' ? 'gz' : 'plain', text: String(f.text || ''),
      by: String(f.by || ''), at: tsMs(f.at), started: tsMs(f.started), editors: ed, updateTime: updateTime || '',
    };
  };
  /** 作業用の写しを1つ読む。無ければ { ok:true, exists:false } */
  A.liveGet = async function (sid, pid) {
    const r = await call('GET', A.cfg.docs + '/' + livePath(sid, pid));
    if (!r.ok) return r.code === 'notfound' ? { ok: true, exists: false } : r;
    return parseLive(pid, decFields(r.json.fields), r.json.updateTime);
  };
  /** 棚の中の、作業用の写しの一覧（投稿者の「返却待ち」の確認用。本文は含むので、件数は少ない前提） */
  A.liveList = async function (sid) {
    const r = await A.listDocs('shelves/' + sid + '/live');
    return r.ok ? { ok: true, items: r.docs.map((d) => parseLive(d.id, d.fields, '')) } : r;
  };
  /** 始める（最初の本文＝投稿の本文）。o＝{ sid, fid, pid, uid, owner（投稿者）, title, enc, text }。すでにあれば code: exists */
  A.liveCreate = (o) => A.commit([W.create(livePath(o.sid, o.pid), {
    fid: o.fid, owner: o.owner, startedBy: o.uid, title: String(o.title || '').slice(0, 80), state: 'open', rev: 1, enc: o.enc, text: o.text, by: o.uid, editors: {},
  }, { time: ['at', 'started', fp('editors', o.uid)] })]);
  /** 本文を書く（版 +1）。o＝{ sid, pid, uid, rev（新しい版）, enc, text, updateTime（読んだときの）}。同時に書かれていたら code: precondition（または denied） */
  A.liveWrite = (o) => {
    const w = W.patch(livePath(o.sid, o.pid), { rev: o.rev, enc: o.enc, text: o.text, by: o.uid }, ['rev', 'enc', 'text', 'by'], { time: ['at', fp('editors', o.uid)] });
    if (o.updateTime) w.currentDocument = { updateTime: o.updateTime };
    return A.commit([w]);
  };
  /** 終える（返却待ちにする）／もう一度開く（投稿者だけ） */
  A.liveSetState = (o) => A.commit([W.patch(livePath(o.sid, o.pid), { state: o.state, by: o.uid }, ['state', 'by'], { time: ['at'] })]);
  /** 作業用の写しを消す（返却したあと・破棄・期限切れの掃除） */
  A.liveDelete = (sid, pid) => A.commit([W.del(livePath(sid, pid))]);
})(window);
