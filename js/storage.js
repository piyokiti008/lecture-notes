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
    }
    LN.images = await readAll('images');
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

  /** 設定はそのままに、中身だけを置き換える */
  LN.replaceContent = async function (content) {
    const c = LN.contentOf(content || {});
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
    if (data.app !== 'lecture-notes' || !data.state || !Array.isArray(data.state.notes)) throw new Error('このファイルは講義ノートのバックアップではありません');
    const d = defaults();
    LN.state = Object.assign(d, data.state);
    LN.state.settings = Object.assign(d.settings, data.state.settings || {});
    LN.images = data.images || {};
    await tx('images', 'readwrite', (st) => st.clear());
    for (const id of Object.keys(LN.images)) await tx('images', 'readwrite', (st) => st.put(LN.images[id], id));
    dirty = true;
    await LN.flush();
  };
})(window);
