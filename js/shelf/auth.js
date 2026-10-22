/* 棚のログイン：ログインID＋パスワード（Firebase Authentication の「メール/パスワード」。メール欄には、ログインIDから作った架空のアドレスを入れる）。
 *  - 通信は REST（identitytoolkit・securetoken）。Firebase の SDK は使わない。
 *  - 運営の一覧に出るのは架空のアドレスだけ。パスワードは Firebase が暗号化して持ち、運営にも見えない。忘れると復旧できない（メールがないため）。
 *  - 「この端末でログインを保つ」を選んだときだけ、更新用のトークンをこの端末（localStorage）に置く。ほかは、メモリだけ（ページを閉じると消える）。
 *    LINE の中のブラウザは、保存が残らないことがあるので、その場合は、開くたびにログインになる。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const M = S.model;
  const FB = LN.fbConfig || {};
  const AU = (S.auth = {
    cfg: {
      key: FB.apiKey,
      signUp: 'https://identitytoolkit.googleapis.com/v1/accounts:signUp',
      signIn: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword',
      refresh: 'https://securetoken.googleapis.com/v1/token',
      remove: 'https://identitytoolkit.googleapis.com/v1/accounts:delete',
      timeoutMs: 15000,
    },
  });
  const STORE_KEY = 'ln.shelf.session.v1';
  let ses = null;            // { uid, idToken, refreshToken, exp }
  let refreshing = null;

  const MSG = {
    EMAIL_EXISTS: 'そのログインIDは、すでに使われています。別のIDにしてください。',
    INVALID_LOGIN_CREDENTIALS: 'ログインIDまたはパスワードが違います。',
    EMAIL_NOT_FOUND: 'ログインIDまたはパスワードが違います。',
    INVALID_PASSWORD: 'ログインIDまたはパスワードが違います。',
    TOO_MANY_ATTEMPTS_TRY_LATER: '短い間に何度も失敗したため、しばらく待ってからやり直してください。',
    WEAK_PASSWORD: 'パスワードが弱すぎます。もっと長くしてください。',
    USER_DISABLED: 'このアカウントは、使えない状態になっています。',
    OPERATION_NOT_ALLOWED: 'いまは登録できません。しばらくしてからお試しください。',
  };

  async function call(url, init) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), AU.cfg.timeoutMs) : 0;
    try {
      const ach = S.appcheck ? await S.appcheck.headers() : {};
      const r = await fetch(url + '?key=' + encodeURIComponent(AU.cfg.key || ''), Object.assign({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined }, init, { headers: Object.assign({}, init && init.headers, ach) }));
      let j = null; try { j = await r.json(); } catch (e) { /* 本文なし */ }
      return { status: r.status, ok: r.ok, json: j || {} };
    } finally { if (timer) clearTimeout(timer); }
  }
  const codeOf = (j) => String((j && j.error && j.error.message) || '').split(/[\s:]/)[0];
  function failure(e) {
    return { ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'network', error: (e && e.name === 'AbortError') ? '通信に時間がかかりすぎました。もう一度お試しください。' : 'インターネットにつながりませんでした。' };
  }
  const json = (o) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

  function lsGet() { try { return JSON.parse(root.localStorage.getItem(STORE_KEY)); } catch (e) { return null; } }
  function lsSet(v) { try { if (v) root.localStorage.setItem(STORE_KEY, JSON.stringify(v)); else root.localStorage.removeItem(STORE_KEY); } catch (e) { /* 保存できなくても動く */ } }

  function take(j, remember) {
    ses = { uid: j.localId || j.user_id, idToken: j.idToken || j.id_token, refreshToken: j.refreshToken || j.refresh_token, exp: Date.now() + (Number(j.expiresIn || j.expires_in) || 3600) * 1000 };
    if (remember !== undefined) lsSet(remember ? { rt: ses.refreshToken } : null);
    else if (lsGet()) lsSet({ rt: ses.refreshToken });
    return { ok: true, uid: ses.uid };
  }

  async function enter(path, loginId, password, remember) {
    try {
      const email = await M.emailOf(loginId);
      const r = await call(AU.cfg[path], json({ email, password, returnSecureToken: true }));
      if (!r.ok || !r.json.idToken) { const c = codeOf(r.json); return { ok: false, code: c || 'http' + r.status, error: MSG[c] || 'ログインできませんでした（' + (c || r.status) + '）。' }; }
      return take(r.json, !!remember);
    } catch (e) { return failure(e); }
  }
  AU.signUp = (loginId, password, remember) => enter('signUp', loginId, password, remember);
  AU.signIn = (loginId, password, remember) => enter('signIn', loginId, password, remember);

  async function refresh(rt) {
    const r = await call(AU.cfg.refresh, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(rt) });
    if (!r.ok || !r.json.id_token) return false;
    take(r.json);
    return true;
  }

  /** 前回「保つ」を選んだ端末なら、更新用のトークンでログインし直す。できなければ false */
  AU.restore = async function () {
    const s = lsGet();
    if (!s || !s.rt) return false;
    try { if (await refresh(s.rt)) return true; } catch (e) { return false; }
    lsSet(null);
    return false;
  };

  /** 有効な idToken を返す（期限が近ければ更新する）。ログインしていなければ空文字 */
  AU.token = async function () {
    if (!ses) return '';
    if (ses.exp - Date.now() > 120000) return ses.idToken;
    if (!refreshing) refreshing = refresh(ses.refreshToken).catch(() => false).then((okk) => { refreshing = null; if (!okk) ses = null; return okk; });
    await refreshing;
    return ses ? ses.idToken : '';
  };
  /** ログインのアカウントそのものを消す（Firebase の accounts:delete。ログイン中の本人だけが、自分のアカウントを消せる）。消えたらログアウトする */
  AU.deleteAccount = async function () {
    const tok = await AU.token();
    if (!tok) return { ok: false, code: 'login', error: 'ログインが切れました。もう一度ログインしてください。' };
    try {
      const r = await call(AU.cfg.remove, json({ idToken: tok }));
      if (!r.ok) return { ok: false, code: 'http' + r.status, error: 'アカウントを消せませんでした（' + (codeOf(r.json) || r.status) + '）。' };
      AU.signOut();
      return { ok: true };
    } catch (e) { return failure(e); }
  };
  AU.uid = () => (ses ? ses.uid : '');
  AU.signOut = function () { ses = null; lsSet(null); };
})(window);
