/* ホームページ（index.html の #landing）の動き：
 *   「パソコン版」「スマホ版」を選ぶ → 画面の種類を設定 → Google でログイン → 成功したらアプリを開く
 *   「ログインせずに使う」 → ログインなしでアプリを開く（ノートはこの端末のブラウザの中だけ）
 *   サンプル画面のスライド（横にスライド・矢印・上の見出し・キーボード・マウスのドラッグ・画像の拡大）
 * ログイン済みの人・ログインなしを選んだ人には、最初から出さない（theme.js が html の data-landing を決める）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const doc = root.document;
  const L = (LN.landing = { choose() {}, close() {} });
  const $ = (s) => doc.querySelector(s);
  const buttons = () => Array.from(doc.querySelectorAll('#landing [data-ld]'));

  function msg(t) { doc.querySelectorAll('#landing .ld-msg').forEach((m) => { m.textContent = t || ''; m.hidden = !t; }); }
  function busy(on, which) {
    buttons().forEach((b) => { b.disabled = on; });
    doc.querySelectorAll('#landing .ld-card, #landing .ld-go').forEach((c) => c.classList.toggle('busy', on && c.dataset.ld === which));
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
    const which = touch ? 'phone' : 'pc';
    const card = $('#landing .ld-card[data-ld="' + which + '"] .ld-rec');
    if (card) card.hidden = false;
    const go = $('#landing .ld-go[data-ld="' + which + '"]');
    if (go) go.classList.add('on');
  }

  doc.addEventListener('click', (e) => {
    const b = e.target.closest('#landing [data-ld]');
    if (!b || b.disabled) return;
    const v = b.dataset.ld;
    if (v === 'guest') L.guest(); else L.choose(v);
  });

  /* ---------------- サンプル画面のスライド ---------------- */
  function showcase() {
    const track = $('#ldTrack');
    if (!track) return;
    const slides = Array.from(track.children);
    const tabs = Array.from(doc.querySelectorAll('#ldTabs .ld-tab'));
    const prev = $('#ldPrev'), next = $('#ldNext');
    const clamp = (i) => Math.max(0, Math.min(slides.length - 1, i));
    const reduce = () => !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const left = (i) => slides[i].offsetLeft - slides[0].offsetLeft;
    let cur = 0, raf = 0;

    const nearest = () => {
      let best = 0, d = Infinity;
      slides.forEach((s, i) => { const x = Math.abs(left(i) - track.scrollLeft); if (x < d) { d = x; best = i; } });
      return best;
    };
    function mark() {
      cur = nearest();
      tabs.forEach((t, k) => t.setAttribute('aria-current', k === cur ? 'true' : 'false'));
      if (prev) prev.disabled = cur === 0;
      if (next) next.disabled = cur === slides.length - 1;
      const t = tabs[cur], bar = t && t.parentNode; // 上の見出しの帯だけを動かす（ページは動かさない）
      if (bar && bar.scrollWidth > bar.clientWidth) bar.scrollTo({ left: t.offsetLeft - (bar.clientWidth - t.offsetWidth) / 2, behavior: 'auto' });
    }
    function go(i) { track.scrollTo({ left: left(clamp(i)), behavior: reduce() ? 'auto' : 'smooth' }); }
    L.slideTo = go;

    track.addEventListener('scroll', () => { if (!raf) raf = root.requestAnimationFrame(() => { raf = 0; mark(); }); }, { passive: true });
    tabs.forEach((t, i) => t.addEventListener('click', () => go(i)));
    if (prev) prev.addEventListener('click', () => go(cur - 1));
    if (next) next.addEventListener('click', () => go(cur + 1));
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(cur + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(cur - 1); }
    });

    // マウスで、つかんでスライド（指・ペンは、ブラウザの標準のスライドに任せる）
    let drag = null, suppress = false;
    track.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { x: e.clientX, left: track.scrollLeft, start: cur, moved: false, id: e.pointerId };
    });
    track.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) > 6) { drag.moved = true; track.classList.add('drag'); try { track.setPointerCapture(drag.id); } catch (err) { /* 無視 */ } }
      if (drag.moved) track.scrollLeft = drag.left - dx;
    });
    const endDrag = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved) return;
      suppress = true; root.setTimeout(() => { suppress = false; }, 0);
      track.classList.remove('drag');
      const dx = e.clientX - d.x;
      go(Math.abs(dx) > 60 ? d.start + (dx < 0 ? 1 : -1) : d.start);
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
    track.addEventListener('click', (e) => { if (suppress) { e.preventDefault(); e.stopPropagation(); } }, true);

    // 画像の拡大
    let lb = null, opener = null;
    function closeLb() { if (!lb) return; lb.remove(); lb = null; if (opener && opener.focus) opener.focus(); opener = null; }
    doc.addEventListener('click', (e) => {
      const z = e.target.closest('#landing .ld-zoom');
      if (z && !suppress) {
        const img = z.querySelector('img'); if (!img) return;
        opener = z;
        lb = doc.createElement('div'); lb.className = 'ld-lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', '拡大した画面');
        const big = doc.createElement('img'); big.src = img.currentSrc || img.src; big.alt = img.alt;
        const x = doc.createElement('button'); x.type = 'button'; x.setAttribute('aria-label', '閉じる'); x.textContent = '×';
        lb.appendChild(big); lb.appendChild(x); doc.body.appendChild(lb); x.focus();
        return;
      }
      if (lb && e.target.closest('.ld-lb')) closeLb();
    });
    doc.addEventListener('keydown', (e) => { if (lb && e.key === 'Escape') { e.stopPropagation(); closeLb(); } }, true);
    mark();
  }

  recommend();
  showcase();
  // 案内を出しているあいだに、Google のログイン部品を先に読み込んでおく（クリックの直後に小窓を開くため）
  if (doc.documentElement.dataset.landing === 'on' && LN.cloud && LN.cloud.preload) LN.cloud.preload();
})(window);
