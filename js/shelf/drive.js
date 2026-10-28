/* 投稿ファイルとドライブ（段階3）。shelf.html（見る側）と index.html（投稿する側）の両方で使う。
 *  - 見る側（ログインなし）：Drive 専用の公開キー（driveKey）で、ファイルの種類・大きさだけを確かめる（目次の登録と食い違うものは見せない）。
 *    プレビュー枠・ダウンロードのアドレスを作る。ファイルの中身は、このアプリでは読まない（Google のプレビューか、ダウンロードで開く）。
 *  - 投稿する側（Google ログイン済み。アクセストークンは呼び出し側が渡す）：ファイルの作成（5MB までは1回、それより大きければ「再開可能な」方式）・
 *    「リンクを知る人は閲覧可」の設定・削除（削除すれば、公開も外れる）・自分が棚に出したファイルの一覧。
 *  - 返す値は、{ ok:true, … } か { ok:false, code, message }。code は login（トークンが切れた）/ denied / notfound / quota / timeout / network / httpNNN。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const FB = LN.fbConfig || {};
  const D = (S.drive = {
    cfg: {
      api: 'https://www.googleapis.com/drive/v3',
      upload: 'https://www.googleapis.com/upload/drive/v3',
      key: FB.driveKey,
      file: 'https://drive.google.com/file/d/',
      download: 'https://drive.google.com/uc?export=download&id=',
      timeoutMs: 20000,
      uploadTimeoutMs: 300000,
      multipartMax: 5 * 1024 * 1024,
    },
  });

  D.validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{10,80}$/.test(id);
  D.previewUrl = (id) => D.cfg.file + encodeURIComponent(id) + '/preview';
  D.openUrl = (id) => D.cfg.file + encodeURIComponent(id) + '/view';
  D.downloadUrl = (id) => D.cfg.download + encodeURIComponent(id);

  function explain(code, status) {
    return ({
      login: 'Google のログインが切れました。もう一度ログインしてください。',
      denied: 'ドライブに、この操作を許可されませんでした。',
      notfound: 'ファイルが見つかりませんでした。',
      quota: 'ドライブの空き容量が足りないか、短い間に操作が集中しました。しばらくしてからお試しください。',
      timeout: '通信に時間がかかりすぎました。もう一度お試しください。',
      network: 'インターネットにつながりませんでした。',
    })[code] || 'ドライブとの通信に失敗しました（' + (status || code) + '）。';
  }
  function fail(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body || {});
    const code = status === 401 ? 'login' : status === 404 ? 'notfound' : (status === 403 && /quota|rateLimit|storageQuota/i.test(text)) || status === 429 ? 'quota' : status === 403 ? 'denied' : 'http' + status;
    return { ok: false, code, status, message: explain(code, status) };
  }
  async function send(url, init, timeoutMs) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs || D.cfg.timeoutMs) : 0;
    try {
      const r = await fetch(url, Object.assign({ credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined }, init));
      return { r };
    } catch (e) {
      const t = e && e.name === 'AbortError';
      return { error: { ok: false, code: t ? 'timeout' : 'network', message: explain(t ? 'timeout' : 'network') } };
    } finally { if (timer) clearTimeout(timer); }
  }
  async function bodyOf(r) { try { return await r.text(); } catch (e) { return ''; } }

  /* ---------- 見る側：ログインなしで、ファイルの種類・大きさを確かめる ---------- */
  /** { ok:true, meta:{ id, mimeType, size, trashed } } か { ok:true, meta:null }（見つからない＝取り下げられた・公開されていない）か { ok:false, … } */
  D.inspect = async function (id) {
    if (!D.validId(id)) return { ok: true, meta: null };
    const x = await send(D.cfg.api + '/files/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent('id,mimeType,size,trashed') + '&key=' + encodeURIComponent(D.cfg.key || ''), { method: 'GET' });
    if (x.error) return x.error;
    if (x.r.status === 404) return { ok: true, meta: null };
    if (!x.r.ok) return fail(x.r.status, await bodyOf(x.r));
    let j = null; try { j = await x.r.json(); } catch (e) { /* 本文なし */ }
    return { ok: true, meta: j && typeof j === 'object' ? j : null };
  };

  /** 公開されたファイルの中身を、文字として読む（ノート形式の表示用）。ログインなし・公開キーつき。max バイトを超えるものは読まない */
  D.readText = async function (id, max) {
    if (!D.validId(id)) return { ok: false, code: 'notfound', message: explain('notfound') };
    const x = await send(D.cfg.api + '/files/' + encodeURIComponent(id) + '?alt=media&key=' + encodeURIComponent(D.cfg.key || ''), { method: 'GET' }, D.cfg.uploadTimeoutMs);
    if (x.error) return x.error;
    if (x.r.status === 404) return { ok: false, code: 'notfound', message: explain('notfound') };
    if (!x.r.ok) return fail(x.r.status, await bodyOf(x.r));
    const len = Number(x.r.headers.get('Content-Length'));
    if (max && len > max) return { ok: false, code: 'toobig', message: 'ファイルが大きすぎます。' };
    const text = await bodyOf(x.r);
    if (max && text.length > max) return { ok: false, code: 'toobig', message: 'ファイルが大きすぎます。' };
    return { ok: true, text };
  };

  /* ---------- 投稿する側：作成・公開・削除（token＝Google のアクセストークン） ---------- */
  const auth = (token, extra) => Object.assign({ Authorization: 'Bearer ' + token }, extra || {});

  /** ファイルを作る。file＝Blob（File）、o＝{ name, mime, parents:[フォルダID], appProperties } → { ok:true, id }
   *  5MB までは1回の送信（multipart）。それより大きければ「再開可能な送信」。ブラウザから送信先のアドレス（Location）を読めない・入口の通信が通らない場合は、multipart で送り直す。 */
  D.upload = async function (token, file, o) {
    const meta = { name: o.name, mimeType: o.mime };
    if (o.parents && o.parents.length) meta.parents = o.parents;
    if (o.appProperties) meta.appProperties = o.appProperties;
    const created = async (x) => {
      if (x.error) return x.error;
      if (!x.r.ok) return fail(x.r.status, await bodyOf(x.r));
      const j = await x.r.json().catch(() => null);
      return j && j.id ? { ok: true, id: j.id } : { ok: false, code: 'http200', message: explain('http200', 200) };
    };
    const multipart = async () => {
      const b = '----ln' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const body = new Blob(['--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n', JSON.stringify(meta), '\r\n--' + b + '\r\nContent-Type: ' + o.mime + '\r\n\r\n', file, '\r\n--' + b + '--']);
      return created(await send(D.cfg.upload + '/files?uploadType=multipart&fields=id', { method: 'POST', headers: auth(token, { 'Content-Type': 'multipart/related; boundary=' + b }), body }, D.cfg.uploadTimeoutMs));
    };
    if (file.size <= D.cfg.multipartMax) return multipart();
    // 大きいファイル：まず「再開可能な送信」の入口を作り、返ってきた送信先に、本体をまるごと送る
    const init = await send(D.cfg.upload + '/files?uploadType=resumable&fields=id', {
      method: 'POST', headers: auth(token, { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': o.mime, 'X-Upload-Content-Length': String(file.size) }), body: JSON.stringify(meta),
    });
    if (init.error) return init.error.code === 'network' ? multipart() : init.error;   // 入口の通信自体が通らない（ブラウザの制限など）なら、multipart で
    if (!init.r.ok) return fail(init.r.status, await bodyOf(init.r));
    const loc = init.r.headers.get('Location');
    if (!loc) return multipart();
    return created(await send(loc, { method: 'PUT', headers: { 'Content-Type': o.mime }, body: file }, D.cfg.uploadTimeoutMs));
  };

  /** 「リンクを知っている人は閲覧可」にする */
  D.share = async function (token, id) {
    const x = await send(D.cfg.api + '/files/' + encodeURIComponent(id) + '/permissions?fields=id', {
      method: 'POST', headers: auth(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }),
    });
    if (x.error) return x.error;
    return x.r.ok ? { ok: true } : fail(x.r.status, await bodyOf(x.r));
  };

  /** 既存のファイルの中身を、置き換える（共同編集の返却用。ファイルの ID・公開の設定は、そのまま）。text＝新しい中身 */
  D.update = async function (token, id, text, mime) {
    const x = await send(D.cfg.upload + '/files/' + encodeURIComponent(id) + '?uploadType=media&fields=' + encodeURIComponent('id,size'), {
      method: 'PATCH', headers: auth(token, { 'Content-Type': mime || 'application/json' }), body: text,
    }, D.cfg.uploadTimeoutMs);
    if (x.error) return x.error;
    return x.r.ok ? { ok: true } : fail(x.r.status, await bodyOf(x.r));
  };

  /** ファイルを消す（ドライブから完全に消える。公開も外れる）。すでに無ければ、成功として扱う */
  D.remove = async function (token, id) {
    const x = await send(D.cfg.api + '/files/' + encodeURIComponent(id), { method: 'DELETE', headers: auth(token) });
    if (x.error) return x.error;
    if (x.r.ok || x.r.status === 404) return { ok: true };
    return fail(x.r.status, await bodyOf(x.r));
  };

  /** このアプリが「棚への投稿」として作ったファイルの一覧（新しい順）。files＝[{ id, name, size, createdTime, appProperties:{ sid, fid, pid } }] */
  D.listMine = async function (token) {
    const out = []; let page = '';
    for (let i = 0; i < 10; i++) {
      const q = "appProperties has { key='ln' and value='post' } and trashed=false";
      const u = D.cfg.api + '/files?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent('nextPageToken,files(id,name,size,createdTime,appProperties)') + '&pageSize=100&orderBy=' + encodeURIComponent('createdTime desc') + '&spaces=drive' + (page ? '&pageToken=' + encodeURIComponent(page) : '');
      const x = await send(u, { method: 'GET', headers: auth(token) });
      if (x.error) return x.error;
      if (!x.r.ok) return fail(x.r.status, await bodyOf(x.r));
      const j = await x.r.json().catch(() => ({}));
      (j.files || []).forEach((f) => out.push(f));
      page = j.nextPageToken || ''; if (!page) break;
    }
    return { ok: true, files: out };
  };
})(window);
