/* ブラウザ版の AI の窓口。デスクトップ版の preload が公開していた lnDesktop.ai と同じ形で、ai.js・materials.js はこの窓口だけを通して AI を使う。
 *
 * 通信は、このブラウザから、次の2か所へ「直接」行う。運営（このアプリの作者）のサーバーは経由しない。
 *   ・Google Gemini（https://generativelanguage.googleapis.com）… 利用者自身の API キー（無料枠）。スマホ向き。
 *   ・Ollama（http://127.0.0.1:11434）… この PC で動くローカル AI。内容が PC の外へ出ない。パソコン向き。
 *   ・Hugging Face（https://huggingface.co と、その配信先 *.hf.co）… 「このブラウザの中で動かす AI」のモデルのファイルを取るときだけ（最初の 1 回）。文章は送らない。
 * API キーは、このブラウザの中（localStorage）にだけ置く。ドライブにも、バックアップにも、運営にも送らない。
 * （デスクトップ版は OS の暗号化領域に保管していたが、ブラウザにはそれが無い。その代わり、通信先を CSP で上の2か所だけに限っている。）
 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  // 通信先（テストでは偽のサーバーに差し替える）。PDF の文字取り出し部品（Ollama 用）の場所
  const cfg = { gemini: 'https://generativelanguage.googleapis.com', ollama: 'http://127.0.0.1:11434', pdfjs: 'vendor/pdfjs/pdf.min.mjs', worker: 'vendor/pdfjs/pdf.worker.min.mjs', browser: { lib: 'vendor/transformers/transformers.web.min.js', ort: 'vendor/transformers/ort.webgpu.bundle.min.mjs', wasmDir: 'vendor/transformers/',
    // 自分たちで学習した AI の置き場所（id は「持ち主/名前」の形）。base：モデル（model.onnx＋model.onnx.data）のあるフォルダ、tokenizer：トークナイザのあるフォルダ名（localRoot の下）。
    // いまは、この PC の試験用の置き場（dev-models/。公開しない）。公開するときは、Hugging Face などの置き場の URL に替える
    local: { 'ln-tuned/qwen3.5-0.8b-diagram': { base: 'dev-models/qwen3.5_0.8b_onnx_webgpu/', localRoot: 'dev-models/', tokenizer: 'qwen3.5_0.8b_onnx_webgpu' } } } };
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
  const NEEDS_KEY = { gemini: true, ollama: false, browser: false };

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

  async function gStream({ key, model, system, messages, maxTokens, signal, send, schema }) {
    const ctx = { key, signal, uploaded: [], hasVideo: false };
    try {
      if (messages.some((m) => blocksOf(m.content).some((b) => b.type === 'media'))) send({ type: 'status', status: 'uploading' });
      const contents = [];
      for (const m of messages) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: await gParts(m.content, ctx) });
      const body = { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: maxTokens } };
      if (ctx.hasVideo) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
      if (schema) body.generationConfig.responseMimeType = 'application/json'; // JSON だけで答えさせる（形は、依頼文で示す）
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

  async function oStream({ model, system, messages, maxTokens, signal, send, config, vision, numCtx, schema }) {
    const base = ollamaBase(config);
    const opts = { vision: !!vision, droppedImages: 0 };
    const msgs = await oConvert(messages, opts);
    const predict = Math.min(maxTokens, 8192);
    const ctxMax = Math.min(Math.max(parseInt(numCtx, 10) || 16384, 4096), 131072);
    const need = estimateTokens(msgs, system) + predict;
    if (need > ctxMax * 1.15) throw new ProviderError('too_large', 'このパソコンのAI（コンテキスト長 ' + ctxMax + '）には長すぎます（見積り約' + need + '）。教材を減らすか、設定でコンテキスト長を大きくしてください。');
    const body = { model, stream: true, think: false, messages: [{ role: 'system', content: system }].concat(msgs), options: { num_ctx: Math.min(ctxMax, Math.max(4096, 2 ** Math.ceil(Math.log2(need)))), num_predict: predict, temperature: 0.4 } };
    if (schema) { body.format = schema; body.options.temperature = 0.2; } // 構造化出力：この形の JSON しか出せない（ゆらぎも小さく）
    send({ type: 'status', status: 'thinking' });
    if (opts.droppedImages) send({ type: 'note', text: '画像 ' + opts.droppedImages + ' 枚は、このモデルが画像に対応していないため送っていません。' });
    const res = await oCall(base, 'POST', '/api/chat', body, signal);
    if (!res.ok) throw await oModelError(res, model);
    let text = '', done = null, writing = false, last = null;
    try {
      await readNDJSON(res, (o) => {
        if (o.error) throw new ProviderError('bad_request', o.error);
        const c = o.message && o.message.content;
        if (c) { if (!writing) { writing = true; send({ type: 'status', status: 'writing' }); } text += c; send({ type: 'text', text: c }); }
        if (o.done) { done = o.done_reason || 'stop'; last = o; }
      });
    } catch (e) { throw e instanceof ProviderError ? e : fetchError(e, 'Ollama '); }
    // Ollama が返す実測の回数と時間（読み込み・書き出し）を、画面側に伝える。「かかる時間の見積もり」を、この PC の実測に合わせるために使う
    if (last && last.prompt_eval_count && last.prompt_eval_duration) send({ type: 'stats', pTok: last.prompt_eval_count, pSec: last.prompt_eval_duration / 1e9, oTok: last.eval_count || 0, oSec: (last.eval_duration || 0) / 1e9 });
    return { text, stopReason: done === 'length' ? 'max_tokens' : 'end_turn', model };
  }

  /* ================= このブラウザの中で動かす AI（WebGPU・Transformers.js） =================
   * AI のファイル（約 700MB）を、最初の 1 回だけ Hugging Face から読み込み、あとは、このブラウザの中だけで動かす（内容は外へ出ない・インストール不要）。
   * 部品（Transformers.js と ONNX Runtime）は、アプリに同梱している（vendor/transformers/）＝通信の許可（CSP）で、外のサイトからスクリプトを読み込まない。
   * 外へつながるのは、モデルのファイルを取るときの huggingface.co（と、その配信先 *.hf.co）だけ。
   * 部品の読み込み・モデルの読み込み・文章の生成は、下の「エンジン」にまとめてあり、試験では、偽のエンジンに差し替える（W.browserEngine）。 */
  const BR_MODEL_RE = /^[A-Za-z0-9][\w.\-]{0,60}\/[A-Za-z0-9][\w.\-]{0,100}$/;
  const BR_MAX_TOKENS_IN = 8000;   // この大きさ（見積り）を超える入力は、ブラウザの中の AI には渡さない（メモリと時間のため）
  const BR_MAX_NEW = 1500;         // 書き出しの上限（設計図は 400 トークン前後）
  const BR_DTYPE = 'q4';
  const brState = { T: null, lib: null, id: null, processor: null, model: null, loading: null };

  async function brGpu() {
    const nav = root.navigator;
    if (!nav || !nav.gpu) return { ok: false, reason: 'このブラウザは WebGPU に対応していません（Chrome・Edge の新しい版が必要です）。' };
    try {
      const a = await nav.gpu.requestAdapter();
      if (!a) return { ok: false, reason: 'このパソコンの GPU を、ブラウザが使えませんでした。' };
      const info = a.info || {};
      return { ok: true, vendor: info.vendor || '', arch: info.architecture || '', f16: !!(a.features && a.features.has('shader-f16')) };
    } catch (e) { return { ok: false, reason: 'GPU の確認に失敗しました。' }; }
  }
  async function brLib() {
    if (brState.T) return brState.T;
    if (!brState.lib) {
      brState.lib = import(new URL(cfg.browser.lib, root.document.baseURI).href).then((T) => {
        T.env.allowLocalModels = false;
        T.env.useBrowserCache = true;
        T.env.useWasmCache = false;                                   // wasm を、blob にしない（CSP で blob: を許可しなくて済むように）
        const w = T.env.backends.onnx.wasm;
        const dir = new URL(cfg.browser.wasmDir, root.document.baseURI).href;
        w.wasmPaths = { mjs: dir + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: dir + 'ort-wasm-simd-threaded.asyncify.wasm' }; // Transformers.js が WebGPU で使う版（既定は CDN）を、同梱のファイルに
        w.numThreads = 1; w.proxy = false;                            // 複数スレッド（別スレッド）は使わない
        brState.T = T;
        return T;
      });
      brState.lib.catch(() => { brState.lib = null; });
    }
    return brState.lib;
  }
  /** モデルのファイルが、このブラウザに保存済みか（読み込みが速いか）の目安。分からなければ false */
  async function brCached(id) {
    try {
      if (!root.caches) return false;
      const c = await root.caches.open('transformers-cache');
      const keys = await c.keys();
      return keys.some((r) => r.url.includes('/' + id + '/') && /decoder_model_merged_q4\.onnx_data/.test(r.url));
    } catch (e) { return false; }
  }
  async function brStatus(config) {
    const id = (config && config.model) || '';
    return { webgpu: await brGpu(), loaded: !!(brState.model && brState.id === id), cached: BR_MODEL_RE.test(id) ? await brCached(id) : false };
  }
  /** モデルを読み込む。進み具合は、onProgress({ loaded, total })（MB の合計）で伝える。読み込み済みなら、すぐ返る */
  async function brLoad(id, onProgress) {
    if (brState.model && brState.id === id) return;
    if (brState.loading && brState.loadingId === id) return brState.loading;
    const gpu = await brGpu();
    if (!gpu.ok) throw new ProviderError('bad_request', gpu.reason);
    brState.loadingId = id;
    brState.loading = (async () => {
      let T;
      try { T = await brLib(); } catch (e) { throw new ProviderError('other', 'AI を動かす部品を読み込めませんでした。ページを開き直してください。'); }
      const files = {};
      const cb = (p) => {
        if (p && p.status === 'progress' && p.file && onProgress) {
          files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
          const sum = Object.values(files).reduce((a, f) => ({ loaded: a.loaded + f.loaded, total: a.total + f.total }), { loaded: 0, total: 0 });
          onProgress(sum);
        }
      };
      try {
        const processor = await T.AutoProcessor.from_pretrained(id, { progress_callback: cb });
        const model = await T.Qwen3_5ForConditionalGeneration.from_pretrained(id, { dtype: { embed_tokens: BR_DTYPE, vision_encoder: BR_DTYPE, decoder_model_merged: BR_DTYPE }, device: 'webgpu', progress_callback: cb });
        brState.processor = processor; brState.model = model; brState.id = id;
      } catch (e) {
        throw new ProviderError('network', 'AI のファイルを読み込めませんでした。インターネットに接続しているか、確認してください。（' + ((e && e.message) || e) + '）');
      }
    })();
    try { await brState.loading; } finally { brState.loading = null; brState.loadingId = null; }
  }
  /** 小さな AI は、同じ短い並びを延々と繰り返す癖がある（「光、暗、光、暗、…」）。繰り返しが始まっていたら、「1 回ぶんを残した、その終わり」の位置を返す（無ければ -1） */
  function brLoopAt(s) {
    if (s.length < 80) return -1;
    const tail = s.slice(-200);
    for (let u = 2; u <= 24; u++) {
      const unit = tail.slice(-u);
      let n = 0;
      while (n < 20 && tail.endsWith(unit.repeat(n + 1))) n++;
      if (n >= 6 && u * n >= 36) {
        let start = s.length;
        while (start - u >= 0 && s.slice(start - u, start) === unit) start -= u;
        return start + u; // 1 回ぶんは残す
      }
    }
    return -1;
  }
  /** 途中で切れた JSON（文字列の途中・括弧が閉じていない）を、後ろを少しずつ削りながら閉じて、読める形にする。できなければ null */
  function brRepairJson(text) {
    const i0 = text.indexOf('{');
    if (i0 < 0) return null;
    let s = text.slice(i0);
    const close = (src) => {
      const stack = []; let inStr = false, esc = false;
      for (const ch of src) {
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; }
        else if (ch === '"') inStr = true;
        else if (ch === '{') stack.push('}');
        else if (ch === '[') stack.push(']');
        else if (ch === '}' || ch === ']') stack.pop();
      }
      return (inStr ? src + '"' : src).replace(/,\s*$/, '') + stack.reverse().join('');
    };
    for (let i = 0; i < 60 && s.length > 1; i++) {
      const c = close(s);
      try { JSON.parse(c); return c; } catch (e) { /* もう少し削る */ }
      const k = Math.max(s.lastIndexOf(','), s.lastIndexOf('{'), s.lastIndexOf('['));
      if (k <= 0) break;
      s = s.slice(0, s[k] === ',' ? k : k + 1);
    }
    return null;
  }
  const jsonOk = (t) => { try { JSON.parse(t); return true; } catch (e) { return false; } };

  /** 文章を書かせる。onText(文字) を、できた分から呼ぶ。signal が止まったら、そこで終える。同じ言葉の繰り返しが始まったら、そこで打ち切る。戻り値の text は、繰り返しを切り落とした最終の文章 */
  async function brGenerate({ id, system, messages, maxNew, signal, onText }) {
    const T = brState.T, tok = brState.processor.tokenizer;
    const chat = [{ role: 'system', content: system }].concat(messages);
    const prompt = tok.apply_chat_template(chat, { add_generation_prompt: true, tokenize: false, enable_thinking: false });
    const inputs = await brState.processor(prompt);
    const nIn = inputs.input_ids.dims.at(-1);
    const stop = new T.InterruptableStoppingCriteria();
    if (signal) { if (signal.aborted) stop.interrupt(); else signal.addEventListener('abort', () => stop.interrupt(), { once: true }); }
    let nOut = 0, acc = '', looped = false, since = 0;
    const streamer = new T.TextStreamer(tok, {
      skip_prompt: true, skip_special_tokens: true,
      callback_function: (s) => {
        if (!s || looped) return;
        acc += s; onText(s); since += s.length;
        if (since >= 12) { since = 0; if (brLoopAt(acc) >= 0) { looped = true; stop.interrupt(); } }
      },
      token_callback_function: () => { nOut++; },
    });
    // 毎回、いちばん確からしい語だけを選ぶ（揺らさない）。揺らしたり、「繰り返しにペナルティ」をかけると、JSON の記号（「"」など）まで避けて、
    // 「detail": 」のように、引用符が抜けた壊れた JSON が出た（実測）。繰り返しに落ちたときは、下の「繰り返しの打ち切り」と「途中で切れた JSON の補修」で救う
    const t0 = Date.now();
    await brState.model.generate(Object.assign({}, inputs, { do_sample: false, max_new_tokens: maxNew, streamer, stopping_criteria: stop }));
    const cut = brLoopAt(acc);
    return { text: cut >= 0 ? acc.slice(0, cut) : acc, looped, nIn, nOut, sec: (Date.now() - t0) / 1000, truncated: nOut >= maxNew };
  }
  /* ---- 自分たちで学習した AI（ONNX Runtime GenAI のモデルビルダーで変換した形）を、onnxruntime-web で直接動かす部分 ----
   * この形は、Transformers.js が読む公式の形（embed_tokens＋decoder_model_merged。キャッシュの名前も違う）とは別なので、実行部を自前で持つ：
   *   モデル（model.onnx＋model.onnx.data）を取り込み（このブラウザに保存して、2 回目からは読み直さない）→ 1 回の依頼ごとに、
   *   ①文章を、Transformers.js のトークナイザで数字にし ②「最後の 1 トークン以外」を先に流して記憶（キャッシュ）だけ作り（logits は求めない）
   *   ③最後のトークンから 1 トークンずつ、いちばん確からしい語を選んで書き足す（キャッシュは GPU の上に置いたまま回す）。
   * 入力：input_ids［1,n］・attention_mask［1,全体の長さ］・position_ids［3,1,n］＋ past_key_values.N.key|value（注意の層）・past.N.conv|recurrent（線形注意の層）。
   * 出力：logits［1,n,語彙］・present.*（次の past になる）。 */
  const brOrt = { ort: null, lib: null, id: null, session: null, tok: null, past: null, presentNames: null, eos: null, loading: null, loadingId: null };
  const brLocal = (id) => (cfg.browser.local && cfg.browser.local[id]) || null;
  const brAbs = (u) => new URL(u, root.document.baseURI).href;
  async function brOrtLib() {
    if (brOrt.ort) return brOrt.ort;
    if (!brOrt.lib) {
      brOrt.lib = import(brAbs(cfg.browser.ort)).then((ort) => {
        const dir = brAbs(cfg.browser.wasmDir);
        ort.env.wasm.wasmPaths = { mjs: dir + 'ort-wasm-simd-threaded.asyncify.mjs', wasm: dir + 'ort-wasm-simd-threaded.asyncify.wasm' };
        ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
        brOrt.ort = ort;
        return ort;
      });
      brOrt.lib.catch(() => { brOrt.lib = null; });
    }
    return brOrt.lib;
  }
  /** ファイルを取り込む。保存済みなら、そこから（通信しない）。なければ通信で取り、このブラウザの Cache Storage に保存する（次から読み直さない）。onBytes(取れた量, 全体) */
  async function brFetchBytes(url, onBytes) {
    let cache = null;
    try { cache = root.caches ? await root.caches.open('ln-ai-models') : null; } catch (e) { cache = null; }
    if (cache) {
      try { const hit = await cache.match(url); if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); if (onBytes) onBytes(b.length, b.length); return b; } } catch (e) { /* 読めなければ、取り直す */ }
    }
    let res;
    try { res = await fetch(url); } catch (e) { throw new ProviderError('network', 'AI のファイルを取得できません。インターネットに接続しているか、確認してください。'); }
    if (!res.ok) throw new ProviderError('network', 'AI のファイルを取得できませんでした（' + res.status + '）。');
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    let buf = total ? new Uint8Array(total) : null, got = 0; const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (buf && got + value.length <= buf.length) buf.set(value, got); else { if (buf) { chunks.push(buf.slice(0, got)); buf = null; } chunks.push(value); }
      got += value.length;
      if (onBytes) onBytes(got, total || got);
    }
    if (!buf) { buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; } }
    else if (got < buf.length) buf = buf.slice(0, got);
    if (cache) { try { await cache.put(url, new Response(buf, { headers: { 'content-length': String(got) } })); } catch (e) { /* 保存できなくても動く */ } }
    return buf;
  }
  async function brOrtStatus(config) {
    const id = (config && config.model) || '', loc = brLocal(id);
    let cached = false;
    try { if (loc && root.caches) cached = !!(await (await root.caches.open('ln-ai-models')).match(brAbs(loc.base + 'model.onnx.data'))); } catch (e) { cached = false; }
    return { webgpu: await brGpu(), loaded: !!(brOrt.session && brOrt.id === id), cached };
  }
  async function brOrtLoad(id, onProgress) {
    if (brOrt.session && brOrt.id === id) return;
    if (brOrt.loading && brOrt.loadingId === id) return brOrt.loading;
    const gpu = await brGpu();
    if (!gpu.ok) throw new ProviderError('bad_request', gpu.reason);
    const loc = brLocal(id);
    brOrt.loadingId = id;
    brOrt.loading = (async () => {
      let ort, T;
      try { [ort, T] = await Promise.all([brOrtLib(), brLib()]); } catch (e) { throw new ProviderError('other', 'AI を動かす部品を読み込めませんでした。ページを開き直してください。'); }
      const base = brAbs(loc.base);
      // 進み具合：モデル本体（約 490MB）が、ほぼすべて。トークナイザ（約 20MB）の分も足す
      let dataGot = 0, dataTotal = 0, tokGot = 0;
      const report = () => { if (onProgress) onProgress({ loaded: dataGot + tokGot, total: (dataTotal || 492 * 1048576) + 20 * 1048576 }); };
      try {
        const tokP = (async () => {
          const prevLocal = T.env.allowLocalModels, prevPath = T.env.localModelPath;
          T.env.allowLocalModels = true; T.env.localModelPath = new URL(loc.localRoot, root.document.baseURI).pathname; // 「/…/」の形（http:// から始まる形だと、Transformers.js が、つなぎ目の「//」を崩す）
          try { return await T.AutoTokenizer.from_pretrained(loc.tokenizer, { progress_callback: (p) => { if (p && p.status === 'progress' && p.loaded != null) { tokGot = Math.max(tokGot, p.loaded); report(); } } }); }
          finally { T.env.allowLocalModels = prevLocal; T.env.localModelPath = prevPath; }
        })();
        // ビルダーの出力は、会話の書式（chat_template）を、tokenizer_config.json の中ではなく、別のファイル（chat_template.jinja）に置く。Transformers.js は後者を読まないので、自分で読む
        const tmplP = fetch(base + 'chat_template.jinja').then((r) => { if (!r.ok) throw new Error('chat_template.jinja ' + r.status); return r.text(); });
        const [modelBytes, dataBytes] = await Promise.all([brFetchBytes(base + 'model.onnx'), brFetchBytes(base + 'model.onnx.data', (g, t) => { dataGot = g; dataTotal = t; report(); })]);
        const tok = await tokP, template = await tmplP;
        const session = await ort.InferenceSession.create(modelBytes, { executionProviders: ['webgpu'], externalData: [{ path: 'model.onnx.data', data: dataBytes }], preferredOutputLocation: 'gpu-buffer', graphOptimizationLevel: 'all' });
        const present = session.outputNames.filter((n) => /^present\./.test(n));
        // 最初の「記憶」（キャッシュ）は、空：batch=1、過去の長さ=0、その他は、モデルが決めた大きさ
        const sizeOf = (d, name) => (typeof d === 'number' ? d : /past_sequence/.test(d) ? 0 : /batch/.test(d) ? 1 : (() => { throw new Error('知らない次元 ' + d + '（' + name + '）'); })());
        const pastMeta = session.inputMetadata.filter((m) => /^past/.test(m.name));
        const past = {};
        for (const m of pastMeta) {
          const dims = m.shape.map((d) => (typeof d === 'number' ? d : /kv_cache_dim/.test(d) ? 256 : sizeOf(d, m.name)));
          const n = dims.reduce((a, b) => a * b, 1);
          past[m.name] = new ort.Tensor(m.type, m.type === 'float16' ? new Uint16Array(n) : new Float32Array(n), dims);
        }
        const idOf = (s) => { try { const x = tok.encode(s, { add_special_tokens: false }); return x && x.length === 1 ? Number(x[0]) : null; } catch (e) { return null; } };
        brOrt.eos = new Set(['<|im_end|>', '<|endoftext|>'].map(idOf).filter((x) => x != null));
        Object.assign(brOrt, { id, session, tok, past, presentNames: present, template });
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw new ProviderError('other', 'AI を準備できませんでした：' + ((e && e.message) || e));
      }
    })();
    try { await brOrt.loading; } finally { brOrt.loading = null; brOrt.loadingId = null; }
  }
  /** fp16（半精度）の logits から、いちばん大きい値の位置を返す（Uint16Array のままなら、並びを保つ変換で比べる） */
  function brArgmax(d) {
    let best = 0;
    if (typeof Uint16Array !== 'undefined' && d instanceof Uint16Array) {
      let bk = -1;
      for (let i = 0; i < d.length; i++) { const h = d[i], k = (h & 0x8000) ? (~h & 0xFFFF) : (h | 0x8000); if (k > bk) { bk = k; best = i; } }
    } else { let bv = -Infinity; for (let i = 0; i < d.length; i++) if (d[i] > bv) { bv = d[i]; best = i; } }
    return best;
  }
  async function brOrtGenerate({ id, system, messages, maxNew, signal, onText }) {
    const S = brOrt, ort = S.ort, tok = S.tok, sess = S.session;
    const chat = [{ role: 'system', content: system }].concat(messages);
    const prompt = tok.apply_chat_template(chat, { chat_template: S.template, add_generation_prompt: true, tokenize: false, enable_thinking: false });
    const enc = tok(prompt, { add_special_tokens: false });
    const promptIds = Array.from(enc.input_ids.data, Number);
    const nIn = promptIds.length;
    let past = S.past, owned = false; // owned：past が、前回の出力（GPU 上）か。最初の空の記憶は、使い捨てにしない（S.past に残す）
    const run = async (ids, start, wantLogits) => {
      const n = ids.length, total = start + n;
      const pos = new BigInt64Array(3 * n);
      for (let r = 0; r < 3; r++) for (let i = 0; i < n; i++) pos[r * n + i] = BigInt(start + i);
      const feeds = Object.assign({
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, n]),
        attention_mask: new ort.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
        position_ids: new ort.Tensor('int64', pos, [3, 1, n]),
      }, past);
      const out = await sess.run(feeds, S.presentNames.concat(wantLogits ? ['logits'] : []));
      const next = {};
      for (const name of S.presentNames) next[name.replace(/^present\.(\d+)\.key$/, 'past_key_values.$1.key').replace(/^present\.(\d+)\.value$/, 'past_key_values.$1.value').replace(/^present\./, 'past.')] = out[name];
      if (owned) for (const k of Object.keys(past)) { try { past[k].dispose(); } catch (e) { /* 解放できなくても続ける */ } }
      past = next; owned = true;
      let next_id = null;
      if (wantLogits) { const d = await out.logits.getData(); next_id = brArgmax(d); try { out.logits.dispose(); } catch (e) { /* 無視 */ } }
      return next_id;
    };
    const t0 = Date.now();
    let acc = '', emitted = '', looped = false, since = 0, nOut = 0, pos0 = 0;
    const gen = [];
    try {
      // ②記憶だけ作る（最後の 1 トークンは残す）。長い入力は、128 トークンずつ
      const head = promptIds.slice(0, -1);
      for (let i = 0; i < head.length; i += 128) { if (signal && signal.aborted) break; const part = head.slice(i, i + 128); await run(part, pos0, false); pos0 += part.length; }
      // ③最後のトークンから 1 トークンずつ書く
      let cur = [promptIds[promptIds.length - 1]];
      while (nOut < maxNew && !(signal && signal.aborted) && !looped) {
        const nid = await run(cur, pos0, true);
        pos0 += cur.length; nOut++;
        if (S.eos.has(nid)) break;
        gen.push(nid);
        const full = tok.decode(gen, { skip_special_tokens: true });
        if (full.length > emitted.length && full.startsWith(emitted) && !full.endsWith('�')) { const piece = full.slice(emitted.length); emitted = full; acc = full; onText(piece); since += piece.length; if (since >= 12) { since = 0; if (brLoopAt(acc) >= 0) looped = true; } }
        cur = [nid];
      }
    } finally {
      if (owned) for (const k of Object.keys(past)) { try { past[k].dispose(); } catch (e) { /* 無視 */ } }
    }
    const cut = brLoopAt(acc);
    return { text: cut >= 0 ? acc.slice(0, cut) : acc, looped, nIn, nOut, sec: (Date.now() - t0) / 1000, truncated: nOut >= maxNew };
  }
  /** このサイトに、AI を動かす部品（と、自作の学習済み AI のファイル）が置いてあるか。置いていなければ「準備中」として案内する（公開版では、まだ置いていない間、読み込みの失敗を見せない） */
  async function brAvail(config) {
    try {
      const loc = brLocal(config && config.model);
      const urls = [brAbs(cfg.browser.lib)].concat(loc ? [brAbs(loc.base + 'model.onnx')] : []);
      for (const u of urls) { const r = await root.fetch(u, { method: 'HEAD', cache: 'no-store' }); if (!r.ok) return false; }
      return true;
    } catch (e) { return false; }
  }
  const brRealEngine = {
    gpu: brGpu,
    status: async (c) => Object.assign(await (brLocal(c && c.model) ? brOrtStatus(c) : brStatus(c)), { available: await brAvail(c) }),
    load: (id, cb) => (brLocal(id) ? brOrtLoad(id, cb) : brLoad(id, cb)),
    generate: (o) => (brLocal(o.id) ? brOrtGenerate(o) : brGenerate(o)),
  };
  W.browserEngine = brRealEngine;

  async function bStream({ model, system, messages, maxTokens, signal, send, schema }) {
    const E = W.browserEngine;
    const msgs = await oConvert(messages, { vision: false, droppedImages: 0 }); // PDF は文字にして渡す。画像・音声・動画は渡さない
    const need = estimateTokens(msgs, system);
    if (need > BR_MAX_TOKENS_IN) throw new ProviderError('too_large', 'ブラウザの中の AI には長すぎます（見積り約' + need + 'トークン。上限 約' + BR_MAX_TOKENS_IN + '）。参考にする文章を減らすか、設定で別の AI を選んでください。');
    if (signal.aborted) throw fetchError({ name: 'AbortError' });
    const st = await E.status({ model });
    if (!st.loaded) {
      send({ type: 'status', status: 'loading', hint: '' });
      await E.load(model, (p) => send({ type: 'status', status: 'loading', hint: p.total ? Math.round(p.loaded / p.total * 100) + '%（' + (p.loaded / 1048576).toFixed(0) + ' / ' + (p.total / 1048576).toFixed(0) + ' MB）' : '' }));
    }
    if (signal.aborted) throw fetchError({ name: 'AbortError' });
    send({ type: 'status', status: 'thinking' });
    let text = '', writing = false;
    let r;
    try {
      r = await E.generate({ id: model, system, messages: msgs, maxNew: Math.min(Math.max(maxTokens || 800, 64), BR_MAX_NEW), signal, onText: (s) => { if (!writing) { writing = true; send({ type: 'status', status: 'writing' }); } text += s; send({ type: 'text', text: s }); } });
    } catch (e) { throw e instanceof ProviderError ? e : new ProviderError('other', 'ブラウザの中の AI が止まりました：' + ((e && e.message) || e)); }
    if (signal.aborted) throw fetchError({ name: 'AbortError' });
    text = typeof r.text === 'string' ? r.text : text;                 // 繰り返しを切り落とした最終の文章
    // JSON を求められている（図解）のに、途中で切れている（長すぎ・繰り返しで打ち切り）ときは、閉じて読める形にする
    if (schema && text && !jsonOk(text)) { const fixed = brRepairJson(text); if (fixed) { text = fixed; send({ type: 'note', text: 'AI の出力が途中で切れていたため、読める範囲だけを使いました。' }); } }
    send({ type: 'stats', pTok: r.nIn, pSec: 0, oTok: r.nOut, oSec: r.sec });
    return { text, stopReason: r.truncated ? 'max_tokens' : 'end_turn', model };
  }

  /* ================= 窓口（lnDesktop.ai と同じ形） ================= */
  const listeners = new Set();
  const running = new Map();
  const MODEL_RE = { gemini: /^[\w.\-]{3,80}$/, ollama: /^[\w.\-:/]{1,120}$/, browser: BR_MODEL_RE };
  const BLOCKS = new Set(['text', 'image', 'document', 'media']);
  const supported = (p) => p === 'gemini' || p === 'ollama' || p === 'browser';
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
    // 「この形（JSON の形）でしか答えない」指定。大きすぎるものや、JSON にできないものは受け付けない
    let schema;
    if (p.schema !== undefined && p.schema !== null) {
      let ok = false;
      try { ok = typeof p.schema === 'object' && !Array.isArray(p.schema) && JSON.stringify(p.schema).length <= 20000; } catch (e) { ok = false; }
      if (!ok) throw bad('schema が不正です');
      schema = JSON.parse(JSON.stringify(p.schema));
    }
    return { provider: p.provider, model: p.model, system: p.system, messages, maxTokens: Math.min(Math.max(parseInt(p.maxTokens, 10) || 8000, 256), 32000), config: { baseUrl: typeof c.baseUrl === 'string' && c.baseUrl.length < 300 ? c.baseUrl : undefined }, vision: !!c.vision, numCtx: c.numCtx, schema };
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
  /** ブラウザの中で動かす AI として選べるモデル（Hugging Face の置き場所）。先頭が、既定 */
  const BR_MODELS = [
    { id: 'ln-tuned/qwen3.5-0.8b-diagram', label: '図解用に学習した Qwen3.5 0.8B（約 510MB）', size: 512 * 1048576, tuned: true },
    { id: 'onnx-community/Qwen3.5-0.8B-ONNX-OPT', label: 'Qwen3.5 0.8B（公式・学習前。約 700MB）', size: 701 * 1048576 },
  ];
  W.models = async (provider, config) => {
    try {
      if (!supported(provider)) throw new ProviderError('bad_request', '未対応の AI です');
      if (provider === 'browser') return { ok: true, models: BR_MODELS.slice() };
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
      if (provider === 'gemini') await gTest(key, model);
      else if (provider === 'browser') {
        await W.browserEngine.load(model); // 読み込み済みなら、すぐ返る（まだなら、ここで読み込む）
        let t = '';
        await W.browserEngine.generate({ id: model, system: 'ユーザーの指示に従って、短く答えてください。', messages: [{ role: 'user', content: 'OK とだけ返してください。' }], maxNew: 8, onText: (s) => { t += s; } });
        if (!t.trim()) throw new ProviderError('other', 'AI から返事がありませんでした。');
      } else await oTest(config, model);
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
      const args = Object.assign({}, v, { signal: ctl.signal, send });
      return v.provider === 'gemini' ? await gStream(Object.assign(args, { key })) : v.provider === 'browser' ? await bStream(args) : await oStream(args);
    } catch (e) { return { error: wire(e) }; } finally { running.delete(id); }
  };
  /** ブラウザの中の AI の状態：WebGPU が使えるか／いま読み込み済みか／ファイルがこのブラウザに保存済みか */
  W.browserStatus = async (config) => { try { return await W.browserEngine.status(config || {}); } catch (e) { return { webgpu: { ok: false, reason: '状態を確認できませんでした。' }, loaded: false, cached: false }; } };
  /** モデルを読み込む（設定画面の「AI を読み込む」）。進み具合は、{type:'pull', status, total, completed} で伝える */
  W.browserLoad = async (id, config) => {
    const send = (ev) => listeners.forEach((cb) => cb(Object.assign({ id }, ev)));
    const ctl = new AbortController();
    running.set(id, ctl);
    try {
      const model = config && config.model;
      if (typeof model !== 'string' || !BR_MODEL_RE.test(model)) throw new ProviderError('bad_request', 'モデル名が不正です。');
      send({ type: 'pull', status: 'AI を読み込んでいます…', total: 0, completed: 0 });
      await W.browserEngine.load(model, (p) => send({ type: 'pull', status: 'AI のファイルを読み込んでいます…', total: p.total, completed: p.loaded }));
      return { ok: true };
    } catch (e) { return { ok: false, error: wire(e) }; } finally { running.delete(id); }
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
  W.ai = { status: W.status, setKey: W.setKey, clearKey: W.clearKey, models: W.models, test: W.test, start: W.start, cancel: W.cancel, ollamaStatus: W.ollamaStatus, ollamaPull: W.ollamaPull, browserStatus: W.browserStatus, browserLoad: W.browserLoad, onEvent: W.onEvent };
  W.pdfText = (b64) => pdfToText(b64); // PDF の文字を、このブラウザの中で取り出す（長い教材を区切って作るときに、ai.js が使う）
  W._test = { pdfToText, keyOf, mem, brLoopAt, brRepairJson, brArgmax, realEngine: brRealEngine };
})(window);
