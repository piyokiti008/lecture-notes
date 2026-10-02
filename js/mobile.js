/* スマホ用の画面（画面が狭い端末、または「表示の設定」で「スマホ用」を選んだとき）。
 * パソコン用と同じ部品・同じデータを使い、見せ方だけを変える：
 *   ・1画面に1つだけ見せる（教科 → ノート一覧 → ノート本文／考査 → 範囲 → まとめ・プリント）
 *   ・下に3つの切り替え（ノート／考査対策／メニュー）
 * どの画面を見せているかは m.pane（'root' | 'mid' | 'detail'）。CSS（phone.css）が #app の data-mpane を見て出し分ける。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const doc = root.document;
  const m = (LN.mobile = { pane: 'root', init() {}, go() {}, sync() {}, back() {} });
  const ORDER = ['root', 'mid', 'detail'];
  let U = null;
  const isPhone = () => !!(LN.theme && LN.theme.isPhone());

  const I = (p) => '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">' + p + '</svg>';
  const ICON = {
    book: I('<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z"/><path d="M9 9h6M9 13h6"/>'),
    exam: I('<path d="M9 4h6v3H9z"/><path d="M6 5h12v16H6z"/><path d="M9 14l2 2 4-4"/>'),
    menu: I('<path d="M5 7h14M5 12h14M5 17h14"/>'),
  };

  m.go = function (pane) { m.pane = ORDER.includes(pane) ? pane : 'root'; m.sync(); };
  m.back = function () { m.go(ORDER[Math.max(0, ORDER.indexOf(m.pane) - 1)]); };

  /** いま見せる画面を決めて、画面（#app）と下のバーに反映する */
  m.sync = function () {
    const app = doc.getElementById('app');
    if (!app || !U) return;
    let pane = m.pane;
    // 教科も考査も無いときは、「はじめに」の案内（main 側）を見せる
    if (U.ui.view === 'notes' ? !U.st().subjects.length : (!U.st().subjects.length || !U.curExam())) pane = 'mid';
    app.dataset.mpane = isPhone() ? pane : '';
    const nav = doc.getElementById('mNav');
    if (!nav) return;
    nav.hidden = !isPhone();
    const warn = !!(LN.cloud && LN.cloud.attention && LN.cloud.attention());
    nav.innerHTML =
      '<button type="button" data-act="nav" data-view="notes" class="' + (U.ui.view === 'notes' ? 'on' : '') + '">' + ICON.book + '<span>ノート</span></button>' +
      '<button type="button" data-act="nav" data-view="exam" class="' + (U.ui.view === 'exam' ? 'on' : '') + '">' + ICON.exam + '<span>考査対策</span></button>' +
      '<button type="button" data-act="m-menu">' + ICON.menu + '<span>メニュー</span>' + (warn ? '<span class="dotwarn"></span>' : '') + '</button>';
  };

  /* キーボードが出たときに、見えている範囲に画面をぴったり合わせる（入力欄とツールバーが隠れないように） */
  function fit() {
    const vv = root.visualViewport, h = vv ? vv.height : root.innerHeight, de = doc.documentElement;
    de.style.setProperty('--app-h', Math.round(h) + 'px');
    de.style.setProperty('--app-top', Math.round(vv ? vv.offsetTop : 0) + 'px');
    de.classList.toggle('kb-open', !!vv && root.innerHeight - vv.height > 140);
  }

  m.init = function (ui) {
    U = ui;
    const A = U.actions;
    if (!doc.getElementById('mNav')) {
      const nav = doc.createElement('nav');
      nav.id = 'mNav'; nav.className = 'm-nav'; nav.hidden = true;
      doc.getElementById('app').appendChild(nav);
    }
    A['m-back'] = () => m.back();
    A['m-next'] = () => m.go('detail');
    // 「メニュー」（m-menu）と、その項目を押したときの動き（m-go）は、パソコン用・スマホ用で共通なので display.js にある
    if (LN.cloud) LN.cloud.onStatus = () => m.sync(); // 同期の状態が変わったら、メニューの警告マークを更新
    fit();
    if (root.visualViewport) { root.visualViewport.addEventListener('resize', fit); root.visualViewport.addEventListener('scroll', fit); }
    root.addEventListener('resize', fit);
    m.sync();
  };
})(window);
