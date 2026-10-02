/* ホームページ（index.html の #landing）の動き：
 *   「パソコン版」「スマホ版」を選ぶ → 画面の種類を設定 → Google でログイン → 成功したらアプリを開く
 *   「ログインせずに使う」 → ログインなしでアプリを開く（ノートはこの端末のブラウザの中だけ）
 * ログイン済みの人・ログインなしを選んだ人には、最初から出さない（theme.js が html の data-landing を決める）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const doc = root.document;
  const L = (LN.landing = { choose() {}, close() {} });
  const $ = (s) => doc.querySelector(s);
  const buttons = () => Array.from(doc.querySelectorAll('#landing [data-ld]'));

  function msg(t) { const m = $('#ldMsg'); if (!m) return; m.textContent = t || ''; m.hidden = !t; }
  function busy(on, which) {
    buttons().forEach((b) => { b.disabled = on; });
    doc.querySelectorAll('#landing .ld-card').forEach((c) => c.classList.toggle('busy', on && c.dataset.ld === which));
  }
  function explain(code) {
    if (code === 'popup') return 'ログインが完了しませんでした。ブラウザがポップアップをブロックしていないか確認して、もう一度押してください。';
    if (code === 'blocked') return 'このアカウントは、現在ご利用いただけません。';
    if (code === 'cancel') return 'ログインを取りやめました。';
    if (code === 'scope') return 'Google ドライブへの保存が許可されませんでした。もう一度押して、許可の画面ですべての項目にチェックを入れてください（許可するのは「このアプリが作ったファイル」だけです）。';
    return 'ログインできませんでした。' + (code ? '（' + code + '）' : '') + 'インターネットの接続を確かめて、もう一度お試しください。';
  }

  L.close = function () {
    if (LN.theme && LN.theme.closeLanding) LN.theme.closeLanding();
    if (LN.mobile) LN.mobile.go('root');
    root.scrollTo && root.scrollTo(0, 0);
  };

  /** layout = 'pc' | 'phone'。選んだ画面の種類にして、Google でログインする */
  L.choose = async function (layout) {
    msg(''); busy(true, layout);
    if (LN.theme) LN.theme.set('layout', layout); // 先に切り替える（ログインの小窓を、クリックの直後に開くため、待たずに）
    let ok = false;
    try { ok = !!(LN.cloud && (await LN.cloud.startLogin())); } catch (e) { ok = false; }
    busy(false);
    if (ok) L.close(); else msg(explain(LN.cloud && LN.cloud.lastError));
    return ok;
  };

  L.guest = function () {
    if (LN.cloud && LN.cloud.skipLogin) LN.cloud.skipLogin();
    L.close();
  };

  // この端末に合うほうに「おすすめ」を付ける（画面が狭い・指で操作する端末ならスマホ版）
  function recommend() {
    const touch = !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches) || root.innerWidth <= 760;
    const card = $('#landing .ld-card[data-ld="' + (touch ? 'phone' : 'pc') + '"] .ld-rec');
    if (card) card.hidden = false;
  }

  doc.addEventListener('click', (e) => {
    const b = e.target.closest('#landing [data-ld]');
    if (!b || b.disabled) return;
    const v = b.dataset.ld;
    if (v === 'guest') L.guest(); else L.choose(v);
  });

  recommend();
  // 案内を出しているあいだに、Google のログイン部品を先に読み込んでおく（クリックの直後に小窓を開くため）
  if (doc.documentElement.dataset.landing === 'on' && LN.cloud && LN.cloud.preload) LN.cloud.preload();
})(window);
