/* 棚（コミュニティ）の、純粋な部品：入力の検査・ID と招待コードの生成・架空アドレス・画面の道筋・共有の文面。
 * 通信や画面は持たない（通信は api.js・auth.js、画面は ui.js）。ブラウザと Node のどちらでも動く（test/test-shelf-model.js）。
 *  - ログインID：半角の英数字・「_」「-」の3〜20文字。全角は半角に、大文字は小文字にそろえる。メール欄には、ここから作った架空のアドレスを入れる
 *    （運営の一覧に出るのは架空のアドレスだけ。Google のメールは、棚には一切届かない）。
 *  - 招待コード：12文字（紛らわしい I・L・O・0・1 を除く31種）。画面には 4文字ずつ区切って出す。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const M = (S.model = {});

  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  M.CODE_CHARS = CODE_CHARS;
  M.CODE_LEN = 12;
  M.NICK_MAX = 20;
  M.NAME_MAX = 60;
  M.RULES_MAX = 2000;
  M.PW_MIN = 8;
  M.PW_MAX = 128;
  M.MAX_SHELVES = 5;
  M.EMAIL_DOMAIN = 'ln-members.invalid';

  // 見えない文字・制御文字（表示を乱す・なりすましに使える）
  const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;
  const oneLine = (raw) => String(raw == null ? '' : raw).replace(CTRL, '').replace(/[\s　]+/g, ' ').trim();

  /* ---------- 入力の検査（どれも { ok:true, … } か { ok:false, error } を返す） ---------- */
  M.normLoginId = (raw) => String(raw == null ? '' : raw).normalize('NFKC').trim().toLowerCase();

  M.checkLoginId = function (raw) {
    const id = M.normLoginId(raw);
    if (!id) return { ok: false, error: 'ログインIDを入力してください。' };
    if (!/^[a-z0-9_-]{3,20}$/.test(id)) return { ok: false, error: 'ログインIDは、半角の英数字・「_」・「-」で、3〜20文字にしてください。' };
    return { ok: true, id };
  };

  M.checkPassword = function (raw, loginId) {
    const s = String(raw == null ? '' : raw);
    if (s.length < M.PW_MIN) return { ok: false, error: 'パスワードは' + M.PW_MIN + '文字以上にしてください。' };
    if (s.length > M.PW_MAX) return { ok: false, error: 'パスワードが長すぎます（' + M.PW_MAX + '文字まで）。' };
    if (/^(.)\1+$/.test(s)) return { ok: false, error: '同じ文字だけのパスワードは使えません。' };
    if (loginId && s.normalize('NFKC').toLowerCase() === M.normLoginId(loginId)) return { ok: false, error: 'ログインIDと同じパスワードは使えません。' };
    return { ok: true, password: s };
  };

  M.checkNick = function (raw) {
    const s = oneLine(raw);
    const len = Array.from(s).length;
    if (!len) return { ok: false, error: '表示名を入力してください。' };
    if (len > M.NICK_MAX) return { ok: false, error: '表示名は' + M.NICK_MAX + '文字以内にしてください（いまは' + len + '文字です）。' };
    if (/@|＠/.test(s) || /https?:|www\.|\.com|\.jp/i.test(s)) return { ok: false, error: 'メールアドレスやホームページのアドレスは入れないでください。' };
    if (/[0-9０-９]{7,}/.test(s)) return { ok: false, error: '電話番号のような長い数字は入れないでください。' };
    if (/運営|管理者|管理人|公式|admin|administrator|moderator/i.test(s)) return { ok: false, error: '「運営」「管理者」「公式」などを含む名前は使えません（運営と間違えられるため）。' };
    return { ok: true, nick: s };
  };

  M.checkShelfName = function (raw) {
    const s = oneLine(raw);
    if (!s) return { ok: false, error: '棚の名前を入力してください。' };
    if (s.length > M.NAME_MAX) return { ok: false, error: '棚の名前は' + M.NAME_MAX + '文字以内にしてください（いまは' + s.length + '文字です）。' };
    return { ok: true, name: s };
  };

  M.FOLDER_NAME_MAX = 80;
  M.MAX_DEPTH = 10;       // フォルダの深さ（最上位の中身が 1）
  M.MAX_CHILDREN = 300;   // 1フォルダの直下の件数
  M.checkFolderName = function (raw) {
    const s = oneLine(raw);
    if (!s) return { ok: false, error: 'フォルダの名前を入力してください。' };
    if (s.length > M.FOLDER_NAME_MAX) return { ok: false, error: 'フォルダの名前は' + M.FOLDER_NAME_MAX + '文字以内にしてください（いまは' + s.length + '文字です）。' };
    return { ok: true, name: s };
  };

  /** 通報の理由（200文字まで） */
  M.REASON_MAX = 200;
  M.checkReason = function (raw) {
    const s = oneLine(raw);
    if (!s) return { ok: false, error: '通報の理由を入力してください。' };
    if (s.length > M.REASON_MAX) return { ok: false, error: '理由は' + M.REASON_MAX + '文字以内にしてください（いまは' + s.length + '文字です）。' };
    return { ok: true, reason: s };
  };
  M.reportId = (pid, uid) => pid + '_' + uid;
  M.adminLink = (base, sid) => String(base || '').replace(/#.*$/, '') + '#/s/' + sid + '/admin';

  M.checkRulesText = function (raw) {
    // 改行は残し、見えない文字は消す。Firestore の規則は文字数（UTF-16）で数えるので、同じ数え方で2000字まで
    const s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (s.length > M.RULES_MAX) return { ok: false, error: 'ルールは' + M.RULES_MAX + '文字以内にしてください（いまは' + s.length + '文字です）。' };
    return { ok: true, rules: s };
  };

  /* ---------- 乱数から作る ID・招待コード ---------- */
  M.randomString = function (alphabet, len) {
    const c = root.crypto;
    if (!c || !c.getRandomValues) throw new Error('no-crypto');
    const n = alphabet.length, limit = 256 - (256 % n); // 偏りが出ないよう、端の値は捨てる
    let out = '';
    while (out.length < len) {
      const buf = c.getRandomValues(new Uint8Array(len * 2));
      for (let i = 0; i < buf.length && out.length < len; i++) if (buf[i] < limit) out += alphabet[buf[i] % n];
    }
    return out;
  };
  M.newShelfId = () => M.randomString(ID_CHARS, 26);
  /** フォルダ・項目の ID：英小文字で始まる20文字（Firestore の欄の名前に使うとき、数字で始まると引用符が要るため、最初は必ず文字にする） */
  M.newFolderId = () => M.randomString('abcdefghijklmnopqrstuvwxyz', 1) + M.randomString(ID_CHARS, 19);
  M.isFolderId = (s) => typeof s === 'string' && /^[a-z0-9]{12,32}$/.test(s);
  M.newCode = () => M.randomString(CODE_CHARS, M.CODE_LEN);
  M.formatCode = (code) => String(code || '').replace(/(.{4})(?=.)/g, '$1-');
  /** 画面から入力されたコード → 12文字の正式な形。正しくなければ空文字（ハイフン・空白・小文字・全角は許す） */
  M.parseCode = function (raw) {
    const s = String(raw == null ? '' : raw).normalize('NFKC').toUpperCase().replace(/[\s\-_]/g, '');
    return s.length === M.CODE_LEN && Array.from(s).every((ch) => CODE_CHARS.indexOf(ch) >= 0) ? s : '';
  };

  /* ---------- 架空アドレス（ログインID → メール欄に入れる値） ---------- */
  M.emailOf = async function (loginId) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) throw new Error('no-crypto');
    const norm = M.normLoginId(loginId);
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode('ln-shelf-id-v1:' + norm));
    const hex = Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'u' + hex + '@' + M.EMAIL_DOMAIN;
  };

  /* ---------- 画面の道筋（URL の # 以降） ---------- */
  M.parseRoute = function (hash) {
    const p = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (!p.length) return { name: 'home' };
    if (p[0] === 'signup') return { name: 'signup' };
    if (p[0] === 'login') return { name: 'login' };
    if (p[0] === 'new') return { name: 'new' };
    if (p[0] === 'account') return { name: 'account' };
    if (p[0] === 'join') return { name: 'join', code: M.parseCode(p[1] || ''), raw: p[1] || '' };
    if (p[0] === 's' && /^[a-z0-9]{12,40}$/.test(p[1] || '')) {
      if (p[2] === 'admin') return { name: 'admin', sid: p[1] };
      if (p[2] === 'f' && M.isFolderId(p[3])) {
        if (p[4] === 'p' && M.isFolderId(p[5])) return { name: 'post', sid: p[1], fid: p[3], pid: p[5] };
        return { name: 'folder', sid: p[1], fid: p[3] };
      }
      if (p[2] === 'p' && M.isFolderId(p[3])) return { name: 'post', sid: p[1], fid: 'root', pid: p[3] };
      return { name: 'shelf', sid: p[1] };
    }
    return { name: 'home' };
  };
  M.folderLink = (base, sid, fid) => String(base || '').replace(/#.*$/, '') + '#/s/' + sid + (fid && fid !== 'root' ? '/f/' + fid : '');
  M.postLink = (base, sid, fid, pid) => M.folderLink(base, sid, fid) + '/p/' + pid;
  /** 棚（shelf.html）から投稿画面（index.html）へ：#/post/棚のID/フォルダのID。管理は #/post/manage */
  M.postToLink = (base, sid, fid) => String(base || '').replace(/#.*$/, '') + '#/post/' + sid + '/' + (fid || 'root');
  M.manageLink = (base) => String(base || '').replace(/#.*$/, '') + '#/post/manage';
  /** 取り込み（段階6）：棚の投稿（ノート）を、自分のノートに取り込む画面（index.html#/import/棚/フォルダ/投稿） */
  M.importLink = (base, sid, fid, pid) => String(base || '').replace(/#.*$/, '') + '#/import/' + sid + '/' + (fid || 'root') + '/' + pid;
  /** ノートの出どころ（取り込んだノートに付く印）。形が正しいものだけ { sid, fid, pid, author, title, edit } にして返す。正しくなければ null */
  M.checkOrigin = function (o) {
    if (!o || typeof o !== 'object' || !/^[a-z0-9]{12,40}$/.test(o.sid || '') || !(o.fid === 'root' || M.isFolderId(o.fid)) || !M.isFolderId(o.pid)) return null;
    return { sid: o.sid, fid: o.fid, pid: o.pid, author: String(o.author || '').slice(0, 40), title: String(o.title || '').slice(0, 80), edit: o.edit === 'ok' ? 'ok' : 'no' };
  };
  /** 他人のノート（M.parseNoteDoc の結果）→ 自分のノートに入れる形。画像は新しい ID に付け替える（自分の画像と ID がぶつからないように）。genId＝新しい ID を作る関数 */
  M.importNote = function (doc, origin, genId) {
    let body = doc.body; const images = {};
    Object.keys(doc.images || {}).forEach((old) => {
      const nid = genId();
      images[nid] = doc.images[old];
      body = body.replace(new RegExp('img:' + old + '(?![a-z0-9])', 'g'), 'img:' + nid);
    });
    return { title: doc.title || '無題のノート', date: doc.date || '', body, images, origin: M.checkOrigin(origin) };
  };
  M.parsePostTo = function (hash) {
    const p = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
    if (p[0] === 'import') return /^[a-z0-9]{12,40}$/.test(p[1] || '') && (p[2] === 'root' || M.isFolderId(p[2])) && M.isFolderId(p[3]) ? { import: { sid: p[1], fid: p[2], pid: p[3] } } : {};
    if (p[0] !== 'post') return null;
    if (p[1] === 'manage') return { manage: true };
    if (/^[a-z0-9]{12,40}$/.test(p[1] || '')) return { sid: p[1], fid: p[2] === 'root' || M.isFolderId(p[2]) ? p[2] : 'root' };
    return {};
  };

  /** フォルダの直下の項目（{ id, type, name, created, … }）を並べる。フォルダが先、そのあと投稿。mode＝'new'（新着順）・'name'（名前順）・'likes'（いいね順。likes＝{ 投稿ID: 数 }。同じ数なら新着順） */
  M.sortEntries = function (list, mode, likes) {
    const rank = (e) => (e.type === 'folder' ? 0 : 1);
    const byNew = (a, b) => String(b.created || '').localeCompare(String(a.created || ''));
    const n = (e) => Number((likes || {})[e.id]) || 0;
    const cmp = mode === 'name'
      ? (a, b) => String(a.name).localeCompare(String(b.name), 'ja')
      : mode === 'likes' ? (a, b) => n(b) - n(a) || byNew(a, b) : byNew;
    return list.slice().sort((a, b) => rank(a) - rank(b) || cmp(a, b) || String(a.id).localeCompare(String(b.id)));
  };

  /* ---------- 段階4：いいね（週に1回の集計） ----------
   * 押す：自分の likes/{uid} の nids に、投稿IDを足す・消す。数えるのは、管理者の端末が、週に1回（棚の rankedAt から7日以上たったとき、または「今すぐ集計」）。
   * 数え方：同じ人は1回・自分の投稿への分は数えない・締め出された人の分は数えない・消えた投稿の分は捨てる。 */
  M.TALLY_DAYS = 7;
  M.POPULAR_MIN = 3;        // 「人気」の印：いいねが3件以上で、
  M.POPULAR_RATIO = 0.2;    // かつ、棚のメンバーの2割以上
  M.isPopular = (count, members) => count >= M.POPULAR_MIN && count >= Math.ceil((Number(members) || 0) * M.POPULAR_RATIO);
  M.tallyDue = (rankedAt, now) => { const t = Date.parse(rankedAt || ''); return !(t > 0) || (now - t) >= M.TALLY_DAYS * 86400000; };
  /** members＝[{ id, banned }]、likes＝[{ id（押した人）, nids:{ 投稿ID:true } }]、folders＝[{ id, children:{ 項目ID: 項目 }, likes:{ 投稿ID: 数 } }]
   *  → { counts:{ 投稿ID: 数 }, updates:[{ id（フォルダ）, likes（新しい集計） }]（いまの集計と違うフォルダだけ）} */
  M.tally = function (o) {
    const ok = new Set((o.members || []).filter((m) => !m.banned).map((m) => m.id));
    const where = {};
    (o.folders || []).forEach((f) => Object.keys(f.children || {}).forEach((id) => { const e = f.children[id]; if (e && e.type === 'post') where[id] = { fid: f.id, by: e.createdBy }; }));
    const counts = {};
    (o.likes || []).forEach((l) => {
      if (!ok.has(l.id)) return;
      Object.keys(l.nids || {}).slice(0, 1000).forEach((pid) => { const w = where[pid]; if (w && w.by !== l.id) counts[pid] = (counts[pid] || 0) + 1; });
    });
    const updates = [];
    (o.folders || []).forEach((f) => {
      const next = {};
      Object.keys(counts).forEach((pid) => { if (where[pid].fid === f.id) next[pid] = counts[pid]; });
      const cur = f.likes || {};
      const same = Object.keys(next).length === Object.keys(cur).length && Object.keys(next).every((k) => Number(cur[k]) === next[k]);
      if (!same) updates.push({ id: f.id, likes: next });
    });
    return { counts, updates };
  };
  /* ---------- 投稿（段階3）：ファイルの種類・大きさ・中身の検査 ---------- */
  const OOXML = 'application/vnd.openxmlformats-officedocument.';
  /** 投稿できる種類（規則 kindOk と同じ表）。must＝中身(zip)に必ずある名前 */
  M.KINDS = {
    pdf: { label: 'PDF', ext: 'pdf', mime: 'application/pdf' },
    docx: { label: 'Word', ext: 'docx', mime: OOXML + 'wordprocessingml.document', must: 'word/document.xml' },
    xlsx: { label: 'Excel', ext: 'xlsx', mime: OOXML + 'spreadsheetml.sheet', must: 'xl/workbook.xml' },
    pptx: { label: 'PowerPoint', ext: 'pptx', mime: OOXML + 'presentationml.presentation', must: 'ppt/presentation.xml' },
    note: { label: 'ノート', ext: 'json', mime: 'application/json' },
  };
  M.MAX_POST_BYTES = 20971520;   // 20MB
  M.POST_TITLE_MAX = 80;
  M.kindLabel = (k) => (M.KINDS[k] ? M.KINDS[k].label : 'ファイル');
  const extOf = (name) => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '').trim()); return m ? m[1].toLowerCase() : ''; };
  M.fmtSize = function (bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (Math.round(n / 104857.6) / 10) + ' MB';
  };

  /** 選んだファイルが、投稿できる種類・大きさか（名前と大きさだけで判断）。{ ok:true, kind, mime, ext } か { ok:false, error } */
  M.checkPostFile = function (f) {
    const ext = extOf(f && f.name), size = Number(f && f.size) || 0;
    const kind = Object.keys(M.KINDS).find((k) => k !== 'note' && M.KINDS[k].ext === ext);
    if (!kind) {
      if (ext === 'doc' || ext === 'xls' || ext === 'ppt') return { ok: false, error: '古い形式（.doc・.xls・.ppt）は、まだ使えません。Office で「.docx」「.xlsx」「.pptx」として保存し直してください。' };
      if (ext === 'docm' || ext === 'xlsm' || ext === 'pptm') return { ok: false, error: 'マクロ付きのファイルは、投稿できません。' };
      return { ok: false, error: '投稿できるのは、Word（.docx）・Excel（.xlsx）・PowerPoint（.pptx）・PDF（.pdf）です。' };
    }
    if (size <= 0) return { ok: false, error: 'ファイルが空です。' };
    if (size > M.MAX_POST_BYTES) return { ok: false, error: 'ファイルが大きすぎます（' + M.fmtSize(M.MAX_POST_BYTES) + 'まで。いまは ' + M.fmtSize(size) + ' です）。' };
    return { ok: true, kind, mime: M.KINDS[kind].mime, ext };
  };

  /** zip の中のファイル名の一覧（末尾の「中央ディレクトリ」を読む）。zip でなければ null */
  M.zipNames = function (u8) {
    const n = u8 ? u8.length : 0;
    if (n < 22 || u8[0] !== 0x50 || u8[1] !== 0x4b) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, n);
    let e = -1;
    for (let i = n - 22; i >= Math.max(0, n - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) return null;
    let count = dv.getUint16(e + 10, true), pos = dv.getUint32(e + 16, true);
    if (count === 0xffff || pos === 0xffffffff || pos >= n) return null;
    const dec = new TextDecoder('utf-8'), names = [];
    for (let i = 0; i < count && i < 20000; i++) {
      if (pos + 46 > n || dv.getUint32(pos, true) !== 0x02014b50) return null;
      const nl = dv.getUint16(pos + 28, true), xl = dv.getUint16(pos + 30, true), cl = dv.getUint16(pos + 32, true);
      if (pos + 46 + nl > n) return null;
      names.push(dec.decode(u8.subarray(pos + 46, pos + 46 + nl)));
      pos += 46 + nl + xl + cl;
    }
    return names;
  };
  /** 中身が、名乗っている種類と合っているか（PDF の頭・Office の zip の中身・マクロが無いこと）。{ ok:true } か { ok:false, error } */
  M.sniffPostFile = function (u8, kind) {
    const bad = { ok: false, error: 'このファイルは、拡張子と中身が合いません（壊れているか、別の種類のファイルです）。' };
    const k = M.KINDS[kind];
    if (!k || !u8 || !u8.length) return bad;
    if (kind === 'pdf') {
      const head = Array.from(u8.subarray(0, 1024)).map((b) => String.fromCharCode(b)).join('');
      return head.indexOf('%PDF-') >= 0 ? { ok: true } : bad;
    }
    const names = M.zipNames(u8);
    if (!names || names.indexOf('[Content_Types].xml') < 0 || names.indexOf(k.must) < 0) return bad;
    if (names.some((x) => /(^|\/)vbaProject\.bin$/i.test(x) || /\.(exe|dll|bat|cmd|js|vbs|ps1)$/i.test(x))) return { ok: false, error: 'マクロや実行ファイルを含むファイルは、投稿できません。' };
    return { ok: true };
  };

  /* ---------- ノート形式（kind: note）：投稿するときの文書の形と、読み取り時の検査 ----------
   * このアプリのノート1つを、JSON にして、ドライブに置く。画像は、貼ってある分だけを、文書の中に（data:image…）持たせる。
   * 読むときは、他人が作ったものなので、形・大きさ・画像の種類を検査し、正しくないものは捨てる（SVG の画像は使わない）。 */
  M.NOTE_MAX_BODY = 5000000;
  const IMG_ID_RE = /^[a-z0-9]{1,64}$/, IMG_DATA_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  M.isNoteImage = (id, data) => typeof id === 'string' && IMG_ID_RE.test(id) && typeof data === 'string' && data.length < 30000000 && IMG_DATA_RE.test(data);
  /** 本文の中で使われている画像の ID（![](img:ID)） */
  M.noteImageIds = function (body) {
    const out = [], re = /img:([a-z0-9]{1,64})/g; let m;
    const s = String(body || '');
    while ((m = re.exec(s))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  };
  /** ノート（{ title, date, body }）と、画像の一覧（ID → data:image…）から、投稿する文書を作る */
  M.buildNoteDoc = function (note, images) {
    const body = String((note && note.body) || '');
    const imgs = {};
    M.noteImageIds(body).forEach((id) => { if (images && M.isNoteImage(id, images[id])) imgs[id] = images[id]; });
    return {
      app: 'lecture-notes', kind: 'note', format: 1,
      title: String((note && note.title) || '').slice(0, 200), date: /^\d{4}-\d{2}-\d{2}$/.test((note && note.date) || '') ? note.date : '',
      body, images: imgs,
    };
  };
  /** ドライブから読んだ文字 → 検査ずみのノート { title, date, body, images }。正しくなければ { ok:false, error } */
  M.parseNoteDoc = function (text) {
    const bad = { ok: false, error: 'ノートの形式が正しくないため、表示できません。' };
    if (typeof text !== 'string' || text.length > M.MAX_POST_BYTES + 1024) return bad;
    let j; try { j = JSON.parse(text); } catch (e) { return bad; }
    if (!j || typeof j !== 'object' || j.app !== 'lecture-notes' || j.kind !== 'note' || j.format !== 1 || typeof j.body !== 'string' || j.body.length > M.NOTE_MAX_BODY) return bad;
    const images = {};
    if (j.images && typeof j.images === 'object') Object.keys(j.images).slice(0, 300).forEach((id) => { if (M.isNoteImage(id, j.images[id])) images[id] = j.images[id]; });
    return { ok: true, title: typeof j.title === 'string' ? j.title.slice(0, 200) : '', date: typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : '', body: j.body, images };
  };

  M.checkPostTitle = function (raw) {
    const s = oneLine(raw);
    if (!s) return { ok: false, error: 'タイトルを入力してください。' };
    if (s.length > M.POST_TITLE_MAX) return { ok: false, error: 'タイトルは' + M.POST_TITLE_MAX + '文字以内にしてください（いまは' + s.length + '文字です）。' };
    return { ok: true, title: s };
  };
  /** ファイル名 → タイトルの初期値（拡張子を除き、長すぎれば切る） */
  M.titleFromFile = (name) => oneLine(String(name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '')).slice(0, M.POST_TITLE_MAX);
  /** ドライブに置くファイル名（ダウンロードしたときの名前になる）。使えない記号は「_」に */
  M.driveFileName = (title, kind) => (oneLine(title).replace(/[\\/:*?"<>|]/g, '_') || 'ファイル') + '.' + (M.KINDS[kind] ? M.KINDS[kind].ext : 'bin');
  M.editLabel = (edit) => (edit === 'ok' ? '編集OK' : '編集しないで');
  M.newPostId = M.newFolderId;

  /** ドライブの実際のファイル情報（種類・大きさ）が、目次の登録と合っているか。meta＝{ mimeType, size, trashed } */
  M.checkDriveMeta = function (entry, meta) {
    if (!meta || meta.trashed) return { ok: false, reason: 'gone' };
    const k = M.KINDS[entry && entry.kind];
    if (!k || meta.mimeType !== k.mime || meta.mimeType !== entry.mime) return { ok: false, reason: 'mime' };
    const size = Number(meta.size);
    if (!(size > 0) || size > M.MAX_POST_BYTES) return { ok: false, reason: 'size' };
    return { ok: true };
  };

  M.joinLink = (base, code) => String(base || '').replace(/#.*$/, '') + '#/join/' + code;
  M.shelfLink = (base, sid) => String(base || '').replace(/#.*$/, '') + '#/s/' + sid;

  /** LINE に貼る文面 */
  M.shareText = (name, code, link) => '「' + name + '」の棚に参加できます。\n招待コード：' + M.formatCode(code) + '\n' + link;

  M.fmtDay = function (iso) {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0');
  };
  M.shelvesLeft = (shelfCount) => Math.max(0, M.MAX_SHELVES - (Number(shelfCount) || 0));
})(typeof window !== 'undefined' ? window : globalThis);
