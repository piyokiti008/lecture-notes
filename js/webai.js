/* ブラウザ版の AI の窓口。デスクトップ版の preload が公開していた lnDesktop.ai と同じ形で、ai.js・materials.js はこの窓口だけを通して AI を使う。
 *
 * 通信は、このブラウザから、次の2か所へ「直接」行う。運営（このアプリの作者）のサーバーは経由しない。
 *   ・Google Gemini（https://generativelanguage.googleapis.com）… 利用者自身の API キー（無料枠）。スマホ向き。
 *   ・Ollama（http://127.0.0.1:11434）… この PC で動くローカル AI。内容が PC の外へ出ない。パソコン向き。
 * API キーは、このブラウザの中（localStorage）にだけ置く。ドライブにも、バックアップにも、運営にも送らない。
 * （デスクトップ版は OS の暗号化領域に保管していたが、ブラウザにはそれが無い。その代わり、通信先を CSP で上の2か所だけに限っている。）
 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  // 通信先（テストでは偽のサーバーに差し替える）。PDF の文字取り出し部品（Ollama 用）の場所
  const cfg = { gemini: 'https://generativelanguage.googleapis.com', ollama: 'http://127.0.0.1:11434', pdfjs: 'vendor/pdfjs/pdf.min.mjs', worker: 'vendor/pdfjs/pdf.worker.min.mjs' };
  const W = (LN.webAi = { cfg, remember: true });

  class ProviderError extends Error { constructor(kind, message) { super(message); this.kind = kind; } }
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
  });
  const blocksOf = (content) => (typeof content === 'string' ? [{ type: 'text', text: content }] : content);

  /** SSE（data: 行）を 1 イベントずつ読む */
  async function readSSE(res, onData) {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    const dataOf = (raw) => raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      for (let m = /\r?\n\r?\n/.exec(buf); m; m = /\r?\n\r?\n/.exec(buf)) {
        const d = dataOf(buf.slice(0, m.index));
        buf = buf.slice(m.index + m[0].length);
        if (d) onData(d);
      }
    }
    const tail = dataOf(buf);
    if (tail) onData(tail);
  }
  /** NDJSON（1 行 1 JSON）を読む */
  async function readNDJSON(res, onObj) {
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    const flush = (line) => { if (line.trim()) onObj(JSON.parse(line)); };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 1); }
    }
    flush(buf);
  }
  /** HTTP エラー応答を ProviderError にする */
  async function httpError(res, hint) {
    let body = '';
    try { body = await res.text(); } catch (e) { /* 本文なし */ }
    let msg = body.slice(0, 300);
    try { const j = JSON.parse(body); msg = (j.error && (j.error.message || j.error)) || j.message || msg; } catch (e) { /* JSON でない */ }
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    const s = res.status;
    if (s === 401 || s === 403) return new ProviderError('auth', (hint && hint.auth) || 'キーが正しくないか、権限がありません。');
    if (s === 429) return new ProviderError('rate', (hint && hint.rate) || '利用の上限に達しました。しばらく待ってからお試しください。');
    if (s === 413) return new ProviderError('too_large', '送信する内容が大きすぎます。');
    if (s >= 500) return new ProviderError('overloaded', 'AI のサーバーが混み合っています。少し待ってから、もう一度お試しください。');
    return new ProviderError('bad_request', '依頼を処理できませんでした（' + s + '）：' + msg);
  }
  function fetchError(e, where) {
    if (e instanceof ProviderError) return e;
    if (e && e.name === 'AbortError') return new ProviderError('cancelled', '停止しました。');
    return new ProviderError('network', (where || 'AI のサーバー') + 'に接続できません。' + (where ? '' : 'インターネット接続を確認してください。'));
  }

  /* ================= API キーの保管（このブラウザの中だけ） ================= */
  const KEYS_LS = 'ln.ai.keys.v1', REMEMBER_LS = 'ln.ai.remember';
  const lsGet = (k) => { try { return JSON.parse(root.localStorage.getItem(k)); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { root.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };
  const mem = {};                                   // 「記憶しない」を選んだときの置き場（ブラウザを閉じると消える）
  W.remember = lsGet(REMEMBER_LS) !== false;        // 初期設定は「このブラウザに記憶する」
  const stored = () => lsGet(KEYS_LS) || {};
  const keyOf = (p) => mem[p] || stored()[p] || null;
  const KEY_FORMAT = { gemini: [/^[\w.\-]{20,200}$/, 'Gemini の API キーの形式が正しくありません（英数字とハイフンなどの文字列です）。'] };
  const NEEDS_KEY = { gemini: true, ollama: false };

  /** 「記憶する」の切り替え。いまあるキーも、新しい置き場へ移す（オフにしたら、保存してあるキーを消してメモリだけに） */
  W.setRemember = function (on) {
    on = !!on;
    if (on === W.remember) return;
    const st = stored();
    if (on) { Object.keys(mem).forEach((p) => { st[p] = mem[p]; delete mem[p]; }); lsSet(KEYS_LS, st); }
    else { Object.keys(st).forEach((p) => { mem[p] = st[p]; }); lsSet(KEYS_LS, {}); }
    W.remember = on; lsSet(REMEMBER_LS, on);
  };

  const wire = (e) => {
    if (e instanceof ProviderError) return { kind: e.kind, message: e.message };
    if (e && e.name === 'AbortError') return { kind: 'cancelled', message: '停止しました。' };
    return { kind: 'other', message: 'エラーが発生しました：' + ((e && e.message) || String(e)) };
  };

  /* ================= 音声・動画ファイル（File を、トークンで AI 呼び出しに渡す） ================= */
  const MEDIA_MIME = {
    mp3: 'audio/mp3', m4a: 'audio/m4a', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mov', webm: 'video/webm', mpeg: 'video/mpeg', mpg: 'video/mpeg', avi: 'video/avi', wmv: 'video/wmv', '3gp': 'video/3gpp',
  };
  const grants = new Map(); // token -> { file, mime }
  W.mediaToken = async function (file) {
    const ext = (/\.([a-z0-9]+)$/i.exec((file && file.name) || '') || [])[1];
    const mime = MEDIA_MIME[(ext || '').toLowerCase()];
    if (!file || !mime || file.size > 2 * 1024 ** 3) return null; // Gemini の Files API は 1 ファイル 2GB まで
    const token = (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    grants.set(token, { file, mime });
    return { token, size: file.size, mime };
  };
  const resolveMedia = (token) => {
    const g = grants.get(token);
    if (!g) throw new ProviderError('bad_request', '音声・動画ファイルが見つかりません。もう一度追加してください。');
    return g;
  };

  /* ================= Google Gemini ================= */
  const G_HINT = {
    auth: 'Gemini の API キーが正しくないか、無効です。',
    rate: '無料枠の上限（1 分あたり / 1 日あたりの回数）に達しました。少し待つか、明日また試してください。「軽量（lite）」のモデルを選ぶと、1 日に使える回数が多くなります。',
  };
  const G_FINISH = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens' };
  const gHdr = (key) => ({ 'x-goog-api-key': key, 'content-type': 'application/json' });
  const INLINE_LIMIT = 18 * 1024 * 1024; // 通信が使えないときの、音声・動画のそのまま送信の上限

  async function gApi(base, key, method, url, body, signal) {
    let res;
    try { res = await fetch(base + url, { method, headers: gHdr(key), body: body ? JSON.stringify(body) : undefined, signal }); } catch (e) { throw fetchError(e); }
    if (!res.ok) {
      const err = await httpError(res, G_HINT);
      if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(err.message)) throw new ProviderError('auth', G_HINT.auth);
      throw err;
    }
    return res.json();
  }
  async function gModels(key, signal) {
    const j = await gApi(cfg.gemini, key, 'GET', '/v1beta/models?pageSize=200', null, signal);
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /^models\/gemini-/.test(m.name) && !/(embedding|tts|image|live|robotics|aqa|audio|computer-use|customtools|transcribe)/i.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, '') }));
  }
  async function gTest(key, model, signal) {
    await gApi(cfg.gemini, key, 'POST', '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { contents: [{ role: 'user', parts: [{ text: 'OK とだけ返してください。' }] }], generationConfig: { maxOutputTokens: 32 } }, signal);
  }

  /** Files API へアップロード（音声・動画など大きなファイル用）。完了後に削除する */
  async function gUpload({ key, file, mimeType, signal }) {
    const base = cfg.gemini;
    let start;
    try {
      start = await fetch(base + '/upload/v1beta/files', {
        method: 'POST', signal,
        headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(file.size), 'X-Goog-Upload-Header-Content-Type': mimeType, 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: { display_name: file.name } }),
      });
    } catch (e) { throw fetchError(e); }
    if (!start.ok) throw await httpError(start, G_HINT);
    const url = start.headers.get('x-goog-upload-url');
    if (!url) { const e = new ProviderError('other', 'アップロード先を取得できませんでした。'); e.noUpload = true; throw e; }
    let up;
    try { up = await fetch(url, { method: 'POST', signal, headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: file }); } catch (e) { throw fetchError(e); }
    if (!up.ok) throw await httpError(up, G_HINT);
    let f = (await up.json()).file;
    for (let i = 0; f.state && f.state !== 'ACTIVE' && i < 150; i++) {
      if (f.state === 'FAILED') throw new ProviderError('bad_request', 'Gemini がこのファイルを処理できませんでした。');
      await sleep(2000, signal);
      f = await gApi(base, key, 'GET', '/v1beta/' + f.name, null, signal);
    }
    return { uri: f.uri, mimeType: f.mimeType || mimeType, name: f.name };
  }
  const gDelete = (key, name) => { if (name) fetch(cfg.gemini + '/v1beta/' + name, { method: 'DELETE', headers: gHdr(key) }).catch(() => {}); };
  const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });

  async function gParts(content, ctx) {
    const parts = [];
    for (const b of blocksOf(content)) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image' || b.type === 'document') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      else if (b.type === 'media') {
        const { file, mime } = resolveMedia(b.token);
        const isVideo = /^video\//.test(mime);
        let part;
        try {
          const f = await gUpload({ key: ctx.key, file, mimeType: mime, signal: ctx.signal });
          ctx.uploaded.push(f.name);
          part = { fileData: { mimeType: f.mimeType, fileUri: f.uri } };
          if (isVideo) { ctx.hasVideo = true; if (b.fps) part.fileData.videoMetadata = { fps: b.fps }; }
        } catch (e) {
          // 大きなファイルの専用アップロードが使えない場合の代わりの方法（小さいファイルだけ、そのまま送る）
          if (e && e.noUpload && file.size <= INLINE_LIMIT) part = { inlineData: { mimeType: mime, data: await toBase64(file) } };
          else throw e;
        }
        parts.push(part);
      }
    }
    return parts;
  }

  async function gStream({ key, model, system, messages, maxTokens, signal, send }) {
    const ctx = { key, signal, uploaded: [], hasVideo: false };
    try {
      if (messages.some((m) => blocksOf(m.content).some((b) => b.type === 'media'))) send({ type: 'status', status: 'uploading' });
      const contents = [];
      for (const m of messages) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: await gParts(m.content, ctx) });
      const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: maxTokens } };
      if (ctx.hasVideo) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
      send({ type: 'status', status: 'thinking' });
      let res;
      try { res = await fetch(cfg.gemini + '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', { method: 'POST', headers: gHdr(key), body: JSON.stringify(body), signal }); } catch (e) { throw fetchError(e); }
      if (!res.ok) {
        const err = await httpError(res, G_HINT);
        if (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(err.message)) throw new ProviderError('auth', G_HINT.auth);
        throw err;
      }
      let text = '', finish = null, blocked = null, writing = false;
      try {
        await readSSE(res, (data) => {
          const j = JSON.parse(data);
          if (j.promptFeedback && j.promptFeedback.blockReason) blocked = j.promptFeedback.blockReason;
          const c = j.candidates && j.candidates[0];
          if (!c) return;
          for (const p of (c.content && c.content.parts) || []) {
            if (typeof p.text === 'string' && !p.thought) {
              if (!writing) { writing = true; send({ type: 'status', status: 'writing' }); }
              text += p.text; send({ type: 'text', text: p.text });
            }
          }
          if (c.finishReason) finish = c.finishReason;
        });
      } catch (e) { throw fetchError(e); }
      const stopReason = blocked || (finish && !G_FINISH[finish] && /SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish)) ? 'refusal' : G_FINISH[finish] || 'end_turn';
      return { text, stopReason, model };
    } finally { ctx.uploaded.forEach((n) => gDelete(key, n)); }
  }

  /* ================= Ollama（この PC のローカル AI） ================= */
  const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
  /** 接続先は、この PC の Ollama の標準の場所だけ（ページの通信の許可〔CSP〕も、ここだけ） */
  function ollamaBase(config) {
    const u = (config && config.baseUrl) || cfg.ollama || OLLAMA_DEFAULT;
    let x;
    try { x = new URL(String(u)); } catch (e) { throw new ProviderError('bad_request', '接続先のアドレスが正しくありません。'); }
    if (cfg.ollama !== OLLAMA_DEFAULT) return cfg.ollama; // テスト用の差し替え
    if (!(x.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(x.hostname) && (x.port || '80') === '11434')) {
      throw new ProviderError('bad_request', 'ブラウザ版では、Ollama の標準の接続先（http://127.0.0.1:11434）だけ使えます。');
    }
    return x.origin;
  }
  /** 届かなかった理由を調べる：返事は来るが、このページからの接続が許可されていない（cors）／そもそも届かない（down） */
  async function ollamaReason(base) {
    try { await fetch(base + '/api/version', { mode: 'no-cors' }); return 'cors'; } catch (e) { return 'down'; }
  }
  const ollamaDown = async (base) => ((await ollamaReason(base)) === 'cors'
    ? new ProviderError('cors', 'Ollama は起動していますが、このサイトからの接続が、まだ許可されていません。「メニュー」→「AIアシスタント」で「Ollama」を選び、案内に従って、1回だけ設定してください。')
    : new ProviderError('network', 'Ollama に接続できません。Ollama が起動していない、または、ブラウザが「ローカルネットワークへの接続」を許可していない可能性があります。「メニュー」→「AIアシスタント」の案内を見てください。'));

  async function oCall(base, method, url, body, signal) {
    try { return await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal }); }
    catch (e) { throw e && e.name === 'AbortError' ? fetchError(e) : await ollamaDown(base); }
  }
  async function oStatus(config) {
    const base = ollamaBase(config);
    try {
      const res = await fetch(base + '/api/version');
      return res.ok ? { running: true, version: (await res.json()).version || '' } : { running: false, version: '', reason: 'http' };
    } catch (e) { return { running: false, version: '', reason: await ollamaReason(base) }; }
  }
  async function oModels(config, signal) {
    const base = ollamaBase(config);
    const res = await oCall(base, 'GET', '/api/tags', null, signal);
    if (!res.ok) throw await httpError(res);
    return ((await res.json()).models || []).map((m) => ({ id: m.name, label: m.name + (m.details && m.details.parameter_size ? '（' + m.details.parameter_size + '）' : ''), size: m.size || 0 }));
  }
  async function oModelError(res, model) {
    const err = await httpError(res);
    if (res.status === 404 || /not found/i.test(err.message)) return new ProviderError('model_missing', 'モデル「' + model + '」がこの PC にありません。設定の「モデルをダウンロード」から取得してください。');
    return err;
  }
  async function oTest(config, model, signal) {
    const res = await oCall(ollamaBase(config), 'POST', '/api/chat', { model, stream: false, think: false, messages: [{ role: 'user', content: 'OK とだけ返してください。' }], options: { num_predict: 16 } }, signal);
    if (!res.ok) throw await oModelError(res, model);
  }
  async function oPull({ config, model, signal, send }) {
    const res = await oCall(ollamaBase(config), 'POST', '/api/pull', { model, stream: true }, signal);
    if (!res.ok) throw await httpError(res);
    let last = '';
    await readNDJSON(res, (o) => {
      if (o.error) throw new ProviderError('bad_request', 'モデルを取得できませんでした：' + o.error);
      last = o.status || last;
      send({ type: 'pull', status: o.status || '', total: o.total || 0, completed: o.completed || 0 });
    });
    return { ok: true, status: last };
  }

  /* PDF から文字だけを取り出す（PDF を直接読めない AI 用）。このブラウザの中だけで処理し、必要になったときだけ部品を読み込む */
  let pdfjsP = null;
  function loadPdfjs() {
    if (!pdfjsP) {
      pdfjsP = import(new URL(cfg.pdfjs, root.document.baseURI).href).then((m) => { m.GlobalWorkerOptions.workerSrc = new URL(cfg.worker, root.document.baseURI).href; return m; });
      pdfjsP.catch(() => { pdfjsP = null; });
    }
    return pdfjsP;
  }
  async function pdfToText(base64) {
    let pdfjs;
    try { pdfjs = await loadPdfjs(); } catch (e) { throw new ProviderError('other', 'PDF を読み取る部品を読み込めませんでした。'); }
    const bin = atob(base64), data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    let doc, task;
    try {
      task = pdfjs.getDocument({ data, useSystemFonts: true, disableFontFace: true, isEvalSupported: false, verbosity: 0 });
      doc = await task.promise;
    } catch (e) { throw new ProviderError('bad_request', 'PDF を読み取れませんでした。パスワード付き・壊れたファイルの可能性があります。'); }
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const tc = await (await doc.getPage(n)).getTextContent();
      let line = '', out = '';
      for (const it of tc.items) { line += it.str; if (it.hasEOL) { out += line.trim() + '\n'; line = ''; } }
      out += line.trim();
      if (out.trim()) pages.push('（p.' + n + '）\n' + out.trim());
    }
    for (let i = 0; i < pages.length; i++) pages[i] = pages[i].replace(/[⺀-⿟]/g, (c) => c.normalize('NFKC')).normalize('NFC'); // 見た目が同じ別の文字（康熙部首など）を、通常の漢字に直す
    const numPages = doc.numPages;
    try { await task.destroy(); } catch (e) { /* 後始末の失敗は無視 */ }
    return { text: pages.join('\n\n'), pages: numPages, hasText: pages.length > 0 };
  }

  async function oConvert(messages, opts) {
    const out = [];
    for (const m of messages) {
      const texts = [], images = [];
      for (const b of blocksOf(m.content)) {
        if (b.type === 'text') texts.push(b.text);
        else if (b.type === 'image') { if (opts.vision) images.push(b.source.data); else opts.droppedImages++; }
        else if (b.type === 'document') {
          const r = await pdfToText(b.source.data);
          texts.push(r.hasText ? '（PDF の本文。約' + r.pages + 'ページ）\n' + r.text : '（この PDF には読み取れる文字がありませんでした。スキャン画像の PDF の可能性があります）');
        } else if (b.type === 'media') throw new ProviderError('bad_request', '音声・動画ファイルは、この AI では扱えません。設定で Gemini（無料）を選ぶか、動画の代表フレーム方式をお使いください。');
      }
      const msg = { role: m.role, content: texts.join('\n\n') };
      if (images.length) msg.images = images;
      out.push(msg);
    }
    return out;
  }
  const estimateTokens = (msgs, system) => Math.ceil((msgs.reduce((s, m) => s + m.content.length, 0) + system.length) / 1.1) + msgs.reduce((s, m) => s + (m.images ? m.images.length * 1200 : 0), 0);

  async function oStream({ model, system, messages, maxTokens, signal, send, config, vision, numCtx }) {
    const base = ollamaBase(config);
    const opts = { vision: !!vision, droppedImages: 0 };
    const msgs = await oConvert(messages, opts);
    const predict = Math.min(maxTokens, 8192);
    const ctxMax = Math.min(Math.max(parseInt(numCtx, 10) || 16384, 4096), 131072);
    const need = estimateTokens(msgs, system) + predict;
    if (need > ctxMax * 1.15) throw new ProviderError('too_large', 'このパソコンのAI（コンテキスト長 ' + ctxMax + '）には長すぎます（見積り約' + need + '）。教材を減らすか、設定でコンテキスト長を大きくしてください。');
    const body = { model, stream: true, think: false, messages: [{ role: 'system', content: system }].concat(msgs), options: { num_ctx: Math.min(ctxMax, Math.max(4096, 2 ** Math.ceil(Math.log2(need)))), num_predict: predict, temperature: 0.4 } };
    send({ type: 'status', status: 'thinking' });
    if (opts.droppedImages) send({ type: 'note', text: '画像 ' + opts.droppedImages + ' 枚は、このモデルが画像に対応していないため送っていません。' });
    const res = await oCall(base, 'POST', '/api/chat', body, signal);
    if (!res.ok) throw await oModelError(res, model);
    let text = '', done = null, writing = false;
    try {
      await readNDJSON(res, (o) => {
        if (o.error) throw new ProviderError('bad_request', o.error);
        const c = o.message && o.message.content;
        if (c) { if (!writing) { writing = true; send({ type: 'status', status: 'writing' }); } text += c; send({ type: 'text', text: c }); }
        if (o.done) done = o.done_reason || 'stop';
      });
    } catch (e) { throw e instanceof ProviderError ? e : fetchError(e, 'Ollama '); }
    return { text, stopReason: done === 'length' ? 'max_tokens' : 'end_turn', model };
  }

  /* ================= 窓口（lnDesktop.ai と同じ形） ================= */
  const listeners = new Set();
  const running = new Map();
  const MODEL_RE = { gemini: /^[\w.\-]{3,80}$/, ollama: /^[\w.\-:/]{1,120}$/ };
  const BLOCKS = new Set(['text', 'image', 'document', 'media']);
  const supported = (p) => p === 'gemini' || p === 'ollama';
  const needKey = (p, key) => { if (NEEDS_KEY[p] && !key) throw new ProviderError('auth', 'API キーが登録されていません。'); };

  function validate(p) {
    const bad = (m) => new ProviderError('bad_request', m);
    if (!p || !supported(p.provider)) throw bad('未対応の AI です');
    if (typeof p.model !== 'string' || !MODEL_RE[p.provider].test(p.model)) throw bad('モデル名が不正です');
    if (typeof p.system !== 'string' || p.system.length > 60000) throw bad('system が不正です');
    if (!Array.isArray(p.messages) || !p.messages.length || p.messages.length > 12) throw bad('messages が不正です');
    let bytes = 0;
    const messages = p.messages.map((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') throw bad('role が不正です');
      if (typeof m.content === 'string') { bytes += m.content.length; return { role: m.role, content: m.content }; }
      if (!Array.isArray(m.content) || !m.content.every((b) => b && BLOCKS.has(b.type))) throw bad('content が不正です');
      return {
        role: m.role,
        content: m.content.map((b) => {
          if (b.type === 'text') { if (typeof b.text !== 'string') throw bad('text が不正です'); bytes += b.text.length; return { type: 'text', text: b.text }; }
          if (b.type === 'media') {
            if (typeof b.token !== 'string') throw bad('添付データが不正です');
            resolveMedia(b.token); // 無ければ例外（形式は、トークンを発行したときに確認済み）
            return { type: 'media', token: b.token, fps: typeof b.fps === 'number' && b.fps > 0 && b.fps <= 5 ? b.fps : undefined };
          }
          if (!b.source || typeof b.source.data !== 'string' || typeof b.source.media_type !== 'string') throw bad('添付データが不正です');
          bytes += b.source.data.length;
          return { type: b.type, source: { type: 'base64', media_type: b.source.media_type, data: b.source.data } };
        }),
      };
    });
    if (bytes > 90 * 1024 * 1024) throw new ProviderError('too_large', '送信する内容が大きすぎます。');
    const c = p.config || {};
    return { provider: p.provider, model: p.model, system: p.system, messages, maxTokens: Math.min(Math.max(parseInt(p.maxTokens, 10) || 8000, 256), 32000), config: { baseUrl: typeof c.baseUrl === 'string' && c.baseUrl.length < 300 ? c.baseUrl : undefined }, vision: !!c.vision, numCtx: c.numCtx };
  }

  W.status = async () => ({ encrypted: false, web: true, remember: W.remember, keys: { gemini: !!keyOf('gemini'), anthropic: false, openai: false } });
  W.setKey = async (provider, key) => {
    const f = KEY_FORMAT[provider];
    if (!f) return { ok: false, error: '未対応の AI です。' };
    if (typeof key !== 'string' || !f[0].test(key.trim())) return { ok: false, error: f[1] };
    const k = key.trim();
    if (W.remember) { const st = stored(); st[provider] = k; if (!lsSet(KEYS_LS, st)) { mem[provider] = k; return { ok: true, note: 'このブラウザには保存できなかったため、ブラウザを閉じるまでの間だけ使えます。' }; } delete mem[provider]; }
    else { mem[provider] = k; }
    return { ok: true };
  };
  W.clearKey = async (provider) => {
    delete mem[provider];
    const st = stored(); if (st[provider]) { delete st[provider]; lsSet(KEYS_LS, st); }
    return { ok: true };
  };
  W.models = async (provider, config) => {
    try {
      if (!supported(provider)) throw new ProviderError('bad_request', '未対応の AI です');
      const key = keyOf(provider); needKey(provider, key);
      return { ok: true, models: provider === 'gemini' ? await gModels(key) : await oModels(config) };
    } catch (e) { return { ok: false, error: wire(e) }; }
  };
  W.test = async (provider, config) => {
    try {
      if (!supported(provider)) throw new ProviderError('bad_request', '未対応の AI です');
      const key = keyOf(provider); needKey(provider, key);
      const model = config && config.model;
      if (typeof model !== 'string' || !MODEL_RE[provider].test(model)) throw new ProviderError('bad_request', 'モデルを選んでください。');
      if (provider === 'gemini') await gTest(key, model); else await oTest(config, model);
      return { ok: true };
    } catch (e) { return { ok: false, error: wire(e) }; }
  };
  W.start = async (id, payload) => {
    const send = (ev) => listeners.forEach((cb) => cb(Object.assign({ id }, ev)));
    const ctl = new AbortController();
    running.set(id, ctl);
    try {
      const v = validate(payload);
      const key = keyOf(v.provider); needKey(v.provider, key);
      return v.provider === 'gemini' ? await gStream(Object.assign({}, v, { key, signal: ctl.signal, send })) : await oStream(Object.assign({}, v, { signal: ctl.signal, send }));
    } catch (e) { return { error: wire(e) }; } finally { running.delete(id); }
  };
  W.cancel = async (id) => { const c = running.get(id); if (c) c.abort(); return true; };
  W.ollamaStatus = async (config) => { try { return await oStatus(config); } catch (e) { return { running: false, version: '', reason: 'down', error: wire(e) }; } };
  W.ollamaPull = async (id, config) => {
    const send = (ev) => listeners.forEach((cb) => cb(Object.assign({ id }, ev)));
    const ctl = new AbortController();
    running.set(id, ctl);
    try {
      const model = config && config.model;
      if (typeof model !== 'string' || !MODEL_RE.ollama.test(model)) throw new ProviderError('bad_request', 'モデル名が不正です。');
      return Object.assign({ ok: true }, await oPull({ config, model, signal: ctl.signal, send }));
    } catch (e) { return { ok: false, error: wire(e) }; } finally { running.delete(id); }
  };
  W.onEvent = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };

  /** 外部のページを新しいタブで開くのは、案内用の固定サイトだけ */
  const EXTERNAL_HOSTS = new Set(['aistudio.google.com', 'ollama.com']);
  W.openExternal = async (url) => {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !EXTERNAL_HOSTS.has(u.hostname)) return false;
      root.open(u.href, '_blank', 'noopener,noreferrer');
      return true;
    } catch (e) { return false; }
  };

  // 画面側（ai.js）が「この AI の窓口」として使う
  W.ai = { status: W.status, setKey: W.setKey, clearKey: W.clearKey, models: W.models, test: W.test, start: W.start, cancel: W.cancel, ollamaStatus: W.ollamaStatus, ollamaPull: W.ollamaPull, onEvent: W.onEvent };
  W._test = { pdfToText, keyOf, mem };
})(window);
