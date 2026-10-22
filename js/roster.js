/* ニックネーム名簿：運営に見えるのは、ニックネーム・登録日・最後に使った日・停止の有無だけ。Google アカウント（メールアドレス・名前）は、運営に届かない。
 *
 *  - 利用者の識別：Google のアカウントID（sub）を、この端末の中で SHA-256 にかけた「番号」（40桁）。元のアカウントには戻せない。
 *    メールアドレス・名前・ログインのトークンは、名簿には一切送らない。
 *  - 保存先：Firebase の Firestore（コレクション members、文書名＝番号）。通信は REST。利用者側は、ログインなしで、自分の番号の記録だけを読み書きする
 *    （番号を知っている人だけ。一覧は取れない。「停止」の欄は、利用者側からは書けない＝運営の規則で拒否）。
 *  - 停止（BAN）：運営が banned を true にする。アプリは、ログインのたびに確認して、停止中なら使えなくする。
 *  - 名簿に届かなかった（オフライン・未設定）だけなら、利用は止めない。ニックネームは、この端末に控えて、あとで送る。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const R = (LN.roster = {});
  const FB = LN.fbConfig || {};
  const SALT = 'ln-roster-v1:';
  const MAX = 20;

  R.MAX = MAX;
  R.cfg = { timeoutMs: 8000 };

  /** Google のアカウントID → 番号（40桁の16進数）。この端末の中だけで計算する */
  R.pidOf = async function (sub) {
    const subtle = root.crypto && root.crypto.subtle;
    if (!subtle) throw new Error('no-crypto');
    if (typeof sub !== 'string' || !sub) throw new Error('no-sub');
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(SALT + sub));
    return Array.from(new Uint8Array(buf)).slice(0, 20).map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  /** ニックネームの検査。{ ok:true, nick } か { ok:false, error } */
  R.checkNick = function (raw) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/[\s　]+/g, ' ').trim();
    const len = Array.from(s).length;
    if (!len) return { ok: false, error: 'ニックネームを入力してください。' };
    if (len > MAX) return { ok: false, error: 'ニックネームは ' + MAX + ' 文字以内にしてください（いまは ' + len + ' 文字です）。' };
    if (/@|＠/.test(s) || /https?:|www\.|\.com|\.jp/i.test(s)) return { ok: false, error: 'メールアドレスやホームページのアドレスは入れないでください。' };
    if (/[0-9０-９]{7,}/.test(s)) return { ok: false, error: '電話番号のような長い数字は入れないでください。' };
    if (/運営|管理者|管理人|公式|admin|administrator|moderator/i.test(s)) return { ok: false, error: '「運営」「管理者」「公式」などを含む名前は使えません（運営と間違えられるため）。' };
    return { ok: true, nick: s };
  };

  const hexOk = (pid) => typeof pid === 'string' && /^[0-9a-f]{40}$/.test(pid);
  const base = (conf) => (conf && conf.url) || FB.roster;
  const keyQ = (conf, first) => { const k = (conf && conf.key) || FB.apiKey; return k ? (first ? '?' : '&') + 'key=' + encodeURIComponent(k) : ''; };
  const str = (f) => (f && typeof f.stringValue === 'string' ? f.stringValue : '');
  const when = (f) => (f && (f.timestampValue || f.stringValue) ? String(f.timestampValue || f.stringValue) : '');

  async function call(url, init) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), R.cfg.timeoutMs) : 0;
    try {
      const r = await fetch(url, Object.assign({ credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined }, init || {}));
      let j = null; try { j = await r.json(); } catch (e) { /* 本文なし */ }
      return { status: r.status, ok: r.ok, json: j };
    } finally { if (timer) clearTimeout(timer); }
  }
  const errOf = (r) => 'http' + r.status + (r.json && r.json.error && r.json.error.status ? ':' + r.json.error.status : '');

  /** 自分の番号の記録を読む。{ ok:true, exists:false } / { ok:true, exists:true, nick, banned, first, last } / { ok:false, error } */
  R.get = async function (pid, conf) {
    try {
      if (!hexOk(pid)) return { ok: false, error: 'bad-pid' };
      const r = await call(base(conf) + '/' + pid + keyQ(conf, true), { method: 'GET' });
      if (r.status === 404) return { ok: true, exists: false };
      if (!r.ok) return { ok: false, error: errOf(r) };
      const f = (r.json && r.json.fields) || {};
      return { ok: true, exists: true, nick: str(f.nick), banned: !!(f.banned && f.banned.booleanValue === true), first: when(f.first), last: when(f.last) };
    } catch (e) { return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'network' }; }
  };

  /** はじめての登録（作るだけ。すでにあれば exists:true を返す） */
  R.create = async function (pid, nick, conf) {
    try {
      if (!hexOk(pid)) return { ok: false, error: 'bad-pid' };
      const c = R.checkNick(nick); if (!c.ok) return { ok: false, error: 'bad-nick' };
      const t = new Date().toISOString();
      const r = await call(base(conf) + '?documentId=' + pid + keyQ(conf, false), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { nick: { stringValue: c.nick }, first: { timestampValue: t }, last: { timestampValue: t } } }),
      });
      if (r.status === 409) return { ok: true, exists: true };
      return r.ok ? { ok: true, exists: false } : { ok: false, error: errOf(r) };
    } catch (e) { return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'network' }; }
  };

  /** ニックネーム（省略可）と「最後に使った日」の更新。送るのは、この2つだけ */
  R.touch = async function (pid, nick, conf) {
    try {
      if (!hexOk(pid)) return { ok: false, error: 'bad-pid' };
      const fields = { last: { timestampValue: new Date().toISOString() } };
      let mask = 'updateMask.fieldPaths=last';
      if (nick != null) { const c = R.checkNick(nick); if (!c.ok) return { ok: false, error: 'bad-nick' }; fields.nick = { stringValue: c.nick }; mask += '&updateMask.fieldPaths=nick'; }
      const r = await call(base(conf) + '/' + pid + '?' + mask + '&currentDocument.exists=true' + keyQ(conf, false), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }) });
      return r.ok ? { ok: true } : { ok: false, error: errOf(r), missing: r.status === 404 };
    } catch (e) { return { ok: false, error: (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'network' }; }
  };
})(window);
