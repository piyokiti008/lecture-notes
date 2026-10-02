/* 「表示の設定」画面：目的から選ぶ・テーマ・明るさ・文字の大きさ・角の丸み・画面の種類・夜の自動切り替え。
 * 選ぶとすぐ反映される（保存ボタンは無い）。スマホ用のメニューには、同じ内容の簡易版（quickHtml）を置く。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const T = LN.theme;
  const d = (LN.display = { init() {}, quickHtml() { return ''; } });
  if (!T) return;
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const seg = (k, items) => '<div class="seg full">' + items.map((it) =>
    '<button type="button" data-act="disp-set" data-k="' + k + '" data-v="' + it[0] + '" class="' + (T.get()[k] === it[0] ? 'on' : '') + '">' + it[1] + '</button>').join('') + '</div>';
  const field = (label, body, note) => '<div class="dlg-field"><label class="l">' + label + '</label>' + body + (note ? '<div class="opt-note" style="margin-top:5px">' + note + '</div>' : '') + '</div>';
  const swatch = (t) => '<span class="th-sw" style="--l:' + t.sw[0] + ';--d:' + t.sw[1] + ';--a:' + t.sw[2] + '"><i></i></span>';
  const card = (t, cur) => '<button type="button" class="th-card' + (cur === t.id ? ' on' : '') + '" data-act="disp-set" data-k="theme" data-v="' + t.id + '">' +
    swatch(t) + '<b>' + esc(t.name) + '</b><small>' + esc(t.tag) + '</small></button>';

  function fullHtml() {
    const p = T.get(), cur = p.theme, info = T.THEMES.find((t) => t.id === cur) || T.THEMES[0];
    const purpose = T.THEMES.filter((t) => t.group === 'purpose'), base = T.THEMES.filter((t) => t.group === 'base');
    return field('目的から選ぶ', '<div class="scenes">' + T.SCENES.map((s) =>
      '<button type="button" class="scene' + (cur === s.theme ? ' on' : '') + '" data-act="disp-scene" data-id="' + s.id + '">' + esc(s.label) + '</button>').join('') + '</div>') +
      '<div class="dlg-field"><label class="l">テーマ（色の組み合わせ）</label>' +
      '<div class="th-group">目的別</div><div class="th-grid">' + purpose.map((t) => card(t, cur)).join('') + '</div>' +
      '<div class="th-group">基本</div><div class="th-grid">' + base.map((t) => card(t, cur)).join('') + '</div>' +
      '<div class="th-info"><b>' + esc(info.name) + '</b>　<span>' + esc(info.tag) + '</span><br>' + esc(info.why) + '<br><small>色の感じ方や効果には個人差があります。気軽に試して、合うものを選んでください。</small></div></div>' +
      field('明るさ', seg('mode', [['light', 'ライト'], ['dark', 'ダーク'], ['auto', '端末に合わせる']])) +
      field('夜は自動で「夜」テーマにする', seg('night', [['off', 'しない'], ['on', 'する']]), '21時から朝5時までは、選んだテーマにかかわらず「夜」テーマ（暖色で、まぶしさを抑えた配色）になります。朝になると元に戻ります。') +
      field('文字の大きさ（ノートの本文）', seg('size', [['s', '小'], ['m', '標準'], ['l', '大']])) +
      field('角の丸み', seg('round', [['s', '角ばった'], ['m', '標準'], ['l', '丸い']])) +
      field('画面の種類', seg('layout', [['auto', '自動'], ['pc', 'パソコン用'], ['phone', 'スマホ用']]), '自動：画面の幅で切り替わります。この設定は、この端末（ブラウザ）だけに保存されます。');
  }

  /** スマホ用メニューの中に置く、デザインの簡易な枠（テーマを横に並べて選ぶ＋明るさ） */
  function quickHtml() {
    const cur = T.get().theme;
    return '<div class="dlg-field"><label class="l">デザイン</label><div class="th-chips">' + T.THEMES.map((t) =>
      '<button type="button" class="th-chip' + (cur === t.id ? ' on' : '') + '" data-act="disp-set" data-k="theme" data-v="' + t.id + '">' + swatch(t) + '<span>' + esc(t.name) + '</span></button>').join('') + '</div>' +
      seg('mode', [['light', 'ライト'], ['dark', 'ダーク'], ['auto', '端末に合わせる']]) +
      '<button type="button" class="btn block" style="margin-top:8px" data-act="m-go" data-go="display">くわしい設定…（目的から選ぶ・文字の大きさ など）</button></div>';
  }
  d.quickHtml = quickHtml;

  const REDRAW = { full: fullHtml, quick: quickHtml };
  function redraw() { root.document.querySelectorAll('[data-disp]').forEach((box) => { const f = REDRAW[box.dataset.disp]; if (f) box.innerHTML = f(); }); }

  d.init = function (U) {
    const A = U.actions;
    A['display'] = () => U.ask({ title: '表示の設定', ok: '閉じる', hideCancel: true, body: '<div class="disp-box" data-disp="full">' + fullHtml() + '</div>' });

    /* 「メニュー」：パソコン用でもスマホ用でも同じ。先頭にデザインの枠、その下にログイン・ガイド・バックアップ・フィードバック */
    A['m-menu'] = () => {
      const items = [];
      if (LN.cloud) items.push(['cloud', LN.cloud.label ? LN.cloud.label() : 'ログインと自動保存', LN.cloud.attention && LN.cloud.attention()]);
      if (LN.ai) items.push(['ai-settings', 'AIアシスタント', false]);
      items.push(['help', '書き方ガイド', false], ['backup', 'バックアップ', !!(U.needsBackup && U.needsBackup() && !(LN.cloud && LN.cloud.enabled && LN.cloud.enabled()))]); // ドライブに自動保存している人には、バックアップの催促を出さない
      if (LN.feedback && LN.feedback.available) items.push(['feedback', 'フィードバック', false]);
      U.ask({
        title: 'メニュー', ok: '閉じる', hideCancel: true,
        body: '<div class="disp-box" data-disp="quick">' + quickHtml() + '</div><div class="m-menu">' +
          items.map((it) => '<button type="button" class="m-item" data-act="m-go" data-go="' + it[0] + '">' + esc(it[1]) + (it[2] ? '<span class="dotwarn"></span>' : '') + '</button>').join('') + '</div>',
      });
    };
    // メニューの項目：メニューを閉じてから、その操作を始める（開いたままだと次のダイアログが開けない）
    A['m-go'] = (el) => {
      const dlg = root.document.getElementById('dlg'); if (dlg.open) dlg.close();
      const f = A[el.dataset.go]; if (f) f(el);
    };
    A['disp-set'] = (el) => { T.set(el.dataset.k, el.dataset.v); redraw(); }; // 開いたまま、選択状態だけ更新する
    A['disp-scene'] = (el) => {
      const s = T.SCENES.find((x) => x.id === el.dataset.id);
      if (s) { T.set('theme', s.theme); redraw(); }
    };
  };
})(window);
