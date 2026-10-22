/* App Check（荒らし対策。段階7）：「本物のこのアプリから来た通信」であることを、Firebase に証明する印（トークン）を取り、棚の通信（Firestore・ログイン）に付ける。
 *  - 仕組み：reCAPTCHA v3（利用者に操作を求めない）で証明を取り → Firebase の App Check に渡して、短い期間（約1時間）のトークンに替える → 通信のヘッダー X-Firebase-AppCheck に付ける。
 *  - 有効になるのは、js/fbconfig.js の appCheckSiteKey（reCAPTCHA のサイトキー）と appId（Firebase のウェブアプリの ID）の両方が入ったとき。空なら、何もしない（いまは空）。
 *  - 有効にする手順（Firebase・reCAPTCHA の設定と、CSP の追加）は、docs/運営の設定手順（棚）.md。取れなかったときは、印なしで送る（強制をオンにしていれば、通信は断られる）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const FB = LN.fbConfig || {};
  const AC = (S.appcheck = {
    cfg: {
      exchange: 'https://firebaseappcheck.googleapis.com/v1/projects/' + (FB.project || 'p-notes-4ed2b') + '/apps/',
      script: 'https://www.google.com/recaptcha/api.js?render=',
    },
  });
  let cached = null, pending = null;

  AC.enabled = () => !!(FB.appCheckSiteKey && FB.appId);

  function loadScript() {
    if (root.grecaptcha && root.grecaptcha.execute) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = root.document.createElement('script');
      s.src = AC.cfg.script + encodeURIComponent(FB.appCheckSiteKey); s.async = true;
      s.onload = () => res(); s.onerror = () => rej(new Error('recaptcha'));
      root.document.head.appendChild(s);
    });
  }
  async function fetchToken() {
    await loadScript();
    await new Promise((r) => root.grecaptcha.ready(r));
    const rt = await root.grecaptcha.execute(FB.appCheckSiteKey, { action: 'shelf' });
    const r = await fetch(AC.cfg.exchange + FB.appId + ':exchangeRecaptchaV3Token?key=' + encodeURIComponent(FB.apiKey || ''), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recaptcha_v3_token: rt }), credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!r.ok) throw new Error('appcheck ' + r.status);
    const j = await r.json();
    const ttl = parseInt(String(j.ttl || '3600s'), 10) || 3600;
    return { token: String(j.token || ''), exp: Date.now() + ttl * 1000 - 120000 };
  }
  /** 有効なトークン（無効・取得失敗なら空文字） */
  AC.token = async function () {
    if (!AC.enabled()) return '';
    if (cached && cached.exp > Date.now()) return cached.token;
    if (!pending) pending = fetchToken().then((t) => { cached = t; return t.token; }, () => '').then((v) => { pending = null; return v; });
    return pending;
  };
  /** 通信のヘッダーに足すもの */
  AC.headers = async function () { const t = await AC.token(); return t ? { 'X-Firebase-AppCheck': t } : {}; };
  AC._reset = () => { cached = null; pending = null; };
})(window);
