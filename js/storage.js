/* 保存層: IndexedDB（データ本体 + 画像）とバックアップの書き出し／読み込み */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const DB_NAME = 'lecture-notes';
  let dbp = null;

  function openDB() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('images'); };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return dbp;
  }

  function tx(store, mode, fn) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
      t.onerror = t.onabort = () => reject(t.error);
    }));
  }

  function readAll(store) {
    return openDB().then((db) => new Promise((resolve, reject) => {
      const out = {};
      const req = db.transaction(store, 'readonly').objectStore(store).openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { out[c.key] = c.value; c.continue(); } else resolve(out); };
      req.onerror = () => reject(req.error);
    }));
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => dateStr(new Date());

  const defaults = () => ({
    version: 1,
    subjects: [], // {id, name, color, order}
    units: [],    // {id, subjectId, name, order, summary}
    notes: [],    // {id, subjectId, unitId, title, date, body, star, review, createdAt, updatedAt}
    exams: [],    // {id, name, date, keys:[unitId | 'none:'+subjectId]}
    aiSheets: [], // {id, examId, title, request, markdown, createdAt, updatedAt}  AI が作ったプリント
    settings: { lastBackup: 0, ui: {}, sheet: {}, ai: { model: 'claude-opus-5' } },
  });

  LN.uid = uid;
  LN.today = today;
  LN.dateStr = dateStr;
  LN.state = defaults();
  LN.images = {};

  // 「容量が足りなくなっても、このサイトの保存データを勝手に消さないで」とブラウザに頼む。
  // 許可するかはブラウザが決める（Chrome/Edge は多くの場合、確認なしで許可する）。結果は LN.persisted（true/false）に入る
  LN.persisted = null;
  LN.requestPersist = async function () {
    try {
      if (!navigator.storage || !navigator.storage.persist) return (LN.persisted = false);
      if (navigator.storage.persisted && await navigator.storage.persisted()) return (LN.persisted = true);
      return (LN.persisted = await navigator.storage.persist());
    } catch (e) { return (LN.persisted = false); }
  };

  LN.load = async function () {
    const s = await tx('kv', 'readonly', (st) => st.get('state'));
    if (s) {
      const d = defaults();
      LN.state = Object.assign(d, s);
      LN.state.settings = Object.assign(d.settings, s.settings || {});
      // 保存済みのデータも、念のため検査する（正しいデータは変わらない。ほかのページに書き換えられた場合などの備え）
      try { const c = LN.sanitizeContent(LN.contentOf(LN.state)).content; CONTENT_KEYS.forEach((k) => { LN.state[k] = c[k]; }); } catch (e) { /* 大きすぎる場合は、そのまま使う（アプリが開けなくなるほうが困る） */ }
    }
    LN.images = LN.sanitizeImages(await readAll('images'));
  };

  let timer = null, dirty = false;
  LN.save = function () {
    dirty = true;
    if (LN.onSaveState) LN.onSaveState('saving');
    clearTimeout(timer);
    timer = setTimeout(LN.flush, 300);
  };
  LN.flush = async function () {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    try {
      await tx('kv', 'readwrite', (st) => st.put(LN.state, 'state'));
      if (LN.onSaveState) LN.onSaveState('saved');
      if (LN.onFlushed) { try { LN.onFlushed(); } catch (e) { /* 同期側の不具合で保存を止めない */ } }
    } catch (e) {
      dirty = true;
      if (LN.onSaveState) LN.onSaveState('error', e);
    }
  };
  root.addEventListener('pagehide', () => LN.flush());
  root.document && root.document.addEventListener('visibilitychange', () => { if (document.hidden) LN.flush(); });

  LN.putImage = async function (id, dataUrl) {
    if (!LN.isImageId(id) || !LN.isImageData(dataUrl)) return id; // 画像の形式（data:image/…;base64,…）でないものは、保存しない
    LN.images[id] = dataUrl;
    await tx('images', 'readwrite', (st) => st.put(dataUrl, id));
    return id;
  };
  LN.addImage = (dataUrl) => LN.putImage(uid(), dataUrl);

  /* ---------- ドライブ同期の部品 ---------- */
  // 同期するのは「中身」（教科・単元・ノート・考査・AIプリント）だけ。表示位置や各種設定（settings）は端末ごとのもので、同期しない
  const CONTENT_KEYS = ['subjects', 'units', 'notes', 'exams', 'aiSheets'];
  LN.contentOf = (state) => { const o = {}; CONTENT_KEYS.forEach((k) => { o[k] = Array.isArray(state[k]) ? state[k] : []; }); return o; };
  LN.contentJson = () => JSON.stringify(LN.contentOf(LN.state));
  LN.contentIsEmpty = (c) => CONTENT_KEYS.every((k) => !(c[k] || []).length);

  /* ---------- 入口での検査 ----------
   * 外から入ってくるデータ（バックアップのファイル・ドライブの内容）と、保存済みのデータは、画面に出す前に検査する。
   * 悪意のある（または壊れた）内容が、HTML の属性（id・色）や画像として、そのまま画面に入らないようにするため。
   * 正しいデータは、1文字も変えない（正しくない値だけを、安全な値に直す）。大きすぎるものは、読み込まずに断る（メモリを使い切らせる攻撃の対策）。 */
  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const IMG_ID_RE = /^[a-z0-9]{1,64}$/;
  const IMG_HEAD_RE = /^data:image\/[a-z0-9.+-]{1,30};base64,/;
  const IMG_BODY_RE = /^[A-Za-z0-9+/=\s]*$/;
  const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
  const MAX_ITEMS = 50000, MAX_SHORT = 1000, MAX_LONG = 5000000, MAX_IMAGE = 30000000;
  LN.limits = { MAX_ITEMS, MAX_SHORT, MAX_LONG, MAX_IMAGE };

  LN.isImageData = (v) => typeof v === 'string' && v.length <= MAX_IMAGE && IMG_HEAD_RE.test(v.slice(0, 100)) && IMG_BODY_RE.test(v.slice(v.indexOf(',') + 1));
  LN.isImageId = (id) => typeof id === 'string' && IMG_ID_RE.test(id);

  /** 画像の一覧から、形式が正しいものだけを残す */
  LN.sanitizeImages = function (map) {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    for (const id of Object.keys(map)) if (!DANGEROUS.has(id) && LN.isImageId(id) && LN.isImageData(map[id])) out[id] = map[id];
    return out;
  };

  /** 教科・単元・ノート・考査・AIプリントの検査。{ content, fixed（直した数）} を返す。大きすぎると例外。
   *  方針：正しい値は、そのまま。正しくない値だけを、安全な値に直す。項目が無いときは、足さない（同期の「変更されたか」の判定を、変えないため）。 */
  LN.sanitizeContent = function (input) {
    const src = input || {};
    let fixed = 0;
    const list = (a) => {
      if (!Array.isArray(a)) return [];
      if (a.length > MAX_ITEMS) throw new RangeError('項目が多すぎます');
      return a.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
    };
    const copy = (r) => { const o = {}; for (const k of Object.keys(r)) if (!DANGEROUS.has(k)) o[k] = r[k]; return o; };
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
    const used = new Set();
    const fresh = () => { let id; do { id = uid() + Math.random().toString(36).slice(2, 6); } while (used.has(id)); used.add(id); return id; };
    const maps = { s: new Map(), u: new Map(), e: new Map() };
    const setId = (o, map) => { // 自分の id：正しい形でなければ、新しい id に置き換える（参照のために、対応表を残す）
      const v = o.id;
      if (typeof v === 'string' && ID_RE.test(v)) { used.add(v); return; }
      fixed++; const id = fresh(); if (v !== undefined && v !== null) map.set(String(v), id); o.id = id;
    };
    const refOf = (v, map) => { // ほかの項目への参照（正しい形ならそのまま。正しくなければ、対応表で直すか、なし）
      if (v === null || v === '') return v;
      if (typeof v === 'string' && ID_RE.test(v)) return v;
      fixed++; return map.get(String(v)) || null;
    };
    const setRef = (o, k, map) => { if (has(o, k)) o[k] = refOf(o[k], map); };
    const setStr = (o, k, max) => { if (!has(o, k)) return; if (typeof o[k] !== 'string') { fixed++; o[k] = ''; } else if (o[k].length > max) throw new RangeError('文字が長すぎます'); };
    const setNum = (o, k, fb) => { if (has(o, k) && !(typeof o[k] === 'number' && isFinite(o[k]))) { fixed++; o[k] = fb; } };
    const validShared = (o) => { // 共同編集のノートの印（js/shelf/live.js）。形が正しくなければ、印を外して、ふつうのノートにする
      const s = o.shared;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
      if (!(/^[a-z0-9]{12,40}$/.test(s.sid || '') && (s.fid === 'root' || /^[a-z0-9]{12,32}$/.test(s.fid || '')) && /^[a-z0-9]{12,32}$/.test(s.pid || '') && Number.isInteger(s.rev) && s.rev >= 0 && typeof s.base === 'string' && s.base.length <= 200000)) return false;
      ['owner', 'startedBy', 'state'].forEach((k) => { if (k in s && (typeof s[k] !== 'string' || s[k].length > 64)) delete s[k]; });
      Object.keys(s).forEach((k) => { if (!['sid', 'fid', 'pid', 'rev', 'base', 'owner', 'startedBy', 'state'].includes(k)) delete s[k]; });
      return true;
    };
    const setDate = (o, k) => { if (has(o, k) && !(typeof o[k] === 'string' && (o[k] === '' || DATE_RE.test(o[k])))) { fixed++; o[k] = ''; } };

    const subjects = list(src.subjects).map((r, i) => {
      const o = copy(r); setId(o, maps.s); setStr(o, 'name', MAX_SHORT); setNum(o, 'order', i + 1);
      if (has(o, 'color') && !(typeof o.color === 'string' && COLOR_RE.test(o.color))) { fixed++; o.color = '#2f5bea'; }
      return o;
    });
    const units = list(src.units).map((r, i) => {
      const o = copy(r); setId(o, maps.u); setRef(o, 'subjectId', maps.s); setStr(o, 'name', MAX_SHORT); setStr(o, 'summary', MAX_LONG); setNum(o, 'order', i + 1);
      return o;
    });
    const notes = list(src.notes).map((r) => {
      const o = copy(r); setId(o, new Map()); setRef(o, 'subjectId', maps.s); setRef(o, 'unitId', maps.u);
      setStr(o, 'title', MAX_SHORT); setStr(o, 'body', MAX_LONG); setDate(o, 'date'); setNum(o, 'createdAt', Date.now()); setNum(o, 'updatedAt', Date.now());
      if (has(o, 'star') && ![0, 1, 2, 3].includes(o.star)) { fixed++; o.star = 0; }
      if (has(o, 'review') && typeof o.review !== 'boolean') { fixed++; o.review = !!o.review; }
      if (has(o, 'source') && o.source !== 'ai') { fixed++; delete o.source; }
      if (has(o, 'shared')) { o.shared = Object.assign({}, o.shared); if (!validShared(o)) { fixed++; delete o.shared; } }
      return o;
    });
    const exams = list(src.exams).map((r) => {
      const o = copy(r); setId(o, maps.e); setStr(o, 'name', MAX_SHORT); setDate(o, 'date');
      if (has(o, 'keys')) {
        o.keys = (Array.isArray(o.keys) ? o.keys : []).slice(0, MAX_ITEMS).map((k) => {
          if (typeof k !== 'string') { fixed++; return null; }
          const m = /^none:(.*)$/.exec(k), v = m ? m[1] : k, r2 = refOf(v, m ? maps.s : maps.u);
          return r2 ? (m ? 'none:' + r2 : r2) : null;
        }).filter(Boolean);
      }
      return o;
    });
    const aiSheets = list(src.aiSheets).map((r) => {
      const o = copy(r); setId(o, new Map()); setRef(o, 'examId', maps.e);
      setStr(o, 'title', MAX_SHORT); setStr(o, 'request', MAX_LONG); setStr(o, 'markdown', MAX_LONG); setNum(o, 'createdAt', Date.now()); setNum(o, 'updatedAt', Date.now());
      return o;
    });
    return { content: { subjects, units, notes, exams, aiSheets }, fixed };
  };

  /** 設定はそのままに、中身だけを置き換える */
  LN.replaceContent = async function (content) {
    const c = LN.sanitizeContent(LN.contentOf(content || {})).content;
    CONTENT_KEYS.forEach((k) => { LN.state[k] = c[k]; });
    dirty = true;
    await LN.flush();
  };

  /** 中身を置き換える前の安全コピー（直近3つ。ブラウザの中に残る）。置き換えを間違えても、ここから戻せる */
  LN.snapshotLocal = async function (reason, content, images) {
    const entry = { at: Date.now(), reason: String(reason || ''), json: JSON.stringify({ content: content || LN.contentOf(LN.state), images: images || usedImagesMap() }) };
    const list = ((await tx('kv', 'readonly', (st) => st.get('snapshots'))) || []);
    list.unshift(entry);
    await tx('kv', 'readwrite', (st) => st.put(list.slice(0, 3), 'snapshots'));
    return entry;
  };
  LN.listSnapshots = async () => (((await tx('kv', 'readonly', (st) => st.get('snapshots'))) || []).map((s) => ({ at: s.at, reason: s.reason, json: s.json })));

  /* ---------- バックアップ ---------- */
  function usedImageIds() {
    const ids = new Set();
    const scan = (t) => { String(t || '').replace(/img:([a-z0-9]+)/g, (_, id) => ids.add(id)); };
    LN.state.notes.forEach((n) => scan(n.body));
    LN.state.units.forEach((u) => scan(u.summary));
    return ids;
  }
  LN.usedImageIds = usedImageIds;
  LN.usedImageIdsOf = (content) => {
    const ids = new Set();
    const scan = (t) => { String(t || '').replace(/img:([a-z0-9]+)/g, (_, id) => ids.add(id)); };
    (content.notes || []).forEach((n) => scan(n.body));
    (content.units || []).forEach((u) => scan(u.summary));
    return ids;
  };
  function usedImagesMap() {
    const images = {};
    usedImageIds().forEach((id) => { if (LN.images[id]) images[id] = LN.images[id]; });
    return images;
  }

  /** バックアップ用 JSON 文字列（API キーなどの秘密情報は state に含まれない） */
  LN.backupJson = function () {
    const images = {};
    usedImageIds().forEach((id) => { if (LN.images[id]) images[id] = LN.images[id]; });
    return JSON.stringify({ app: 'lecture-notes', version: 1, exportedAt: new Date().toISOString(), state: LN.state, images });
  };

  LN.exportBackup = function () {
    LN.state.settings.lastBackup = Date.now();
    LN.save();
    const blob = new Blob([LN.backupJson()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'lecture-notes-backup-' + today() + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  LN.importBackup = async function (file) {
    const data = JSON.parse(await file.text());
    if (!data || data.app !== 'lecture-notes' || !data.state || !Array.isArray(data.state.notes)) throw new Error('このファイルは講義ノートのバックアップではありません');
    let clean;
    try { clean = LN.sanitizeContent(data.state); } catch (e) { throw new Error('このファイルは大きすぎるか、内容が正しくないため、読み込めません（' + e.message + '）'); }
    const d = defaults();
    CONTENT_KEYS.forEach((k) => { d[k] = clean.content[k]; });
    // 設定は、バックアップに入っている「表示の状態」と「印刷の設定」だけを引き継ぐ（AI の設定・同意など、端末ごとのものは、ファイルから変えさせない）
    const sIn = data.state.settings && typeof data.state.settings === 'object' ? data.state.settings : {};
    const plain = (o) => { const r = {}; if (o && typeof o === 'object' && !Array.isArray(o)) for (const k of Object.keys(o)) if (!DANGEROUS.has(k)) r[k] = o[k]; return r; };
    d.settings.ui = plain(sIn.ui); d.settings.sheet = plain(sIn.sheet);
    if (typeof sIn.lastBackup === 'number' && isFinite(sIn.lastBackup)) d.settings.lastBackup = sIn.lastBackup;
    d.settings.ai = LN.state.settings.ai; // いまの AI の設定は、そのまま残す
    LN.state = d;
    LN.images = LN.sanitizeImages(data.images);
    await tx('images', 'readwrite', (st) => st.clear());
    for (const id of Object.keys(LN.images)) await tx('images', 'readwrite', (st) => st.put(LN.images[id], id));
    dirty = true;
    await LN.flush();
  };
})(window);
