/* 見た目の設定：テーマ・明るさ・文字の大きさ・角の丸み・画面の種類・夜の自動切り替え。
 * この端末のブラウザ（localStorage）にだけ保存する。ノートの内容とは別で、ドライブには同期しない（パソコンとスマホで別々にしたいため）。
 * <head> で最初に読み込み、画面を描く前に正しい見た目にする（ちらつき防止）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const KEY = 'ln.ui.v1';

  /* テーマ一覧。sw = [ライトの背景, ダークの背景, 強調色]（設定画面の見本用）。
   * tag = 使う場面、why = ねらい。効果の言い切りは避け、「〜しやすい配色」と書く（色の効き方には個人差があるため）。 */
  const THEMES = [
    { id: 'calm', group: 'purpose', name: '集中', tag: '集中したいとき', sw: ['#edf0f3', '#11161c', '#3f6f9a'],
      why: '落ち着いた青灰色で、色の主張を抑えました。長く文字を読む作業で、気が散りにくい配色です。' },
    { id: 'marker', group: 'purpose', name: '暗記', tag: '覚えたいとき', sw: ['#f2f2ef', '#161618', '#b3125f'],
      why: '全体は控えめにして、重要マークと穴埋め・用語だけを鮮やかにしました。要点が目に入りやすく、暗記モードでの確認もしやすい配色です。' },
    { id: 'mint', group: 'purpose', name: 'リラックス', tag: '落ち着きたいとき', sw: ['#e8f2ee', '#0e1816', '#1f7a6d'],
      why: 'やわらかなミントグリーンと、大きめの丸み。試験前など、気持ちを落ち着けたいときに使いやすい配色です。' },
    { id: 'sunrise', group: 'purpose', name: '朝・やる気', tag: '気分を上げたいとき', sw: ['#faefe6', '#1d1411', '#c4472b'],
      why: '暖かいコーラル色。朝や、気分を上げて取りかかりたいときの配色です。' },
    { id: 'night', group: 'purpose', name: '夜', tag: '夜に使うとき', sw: ['#eadfc8', '#15110c', '#8a5a1c'],
      why: '暖色で、まぶしさと青い光を抑えました。夜、寝る前に見返すときに。ライトにすると、ランプ明かりの下の紙のような色になります。' },
    { id: 'clear', group: 'purpose', name: '見やすさ重視', tag: '見えにくいとき・屋外', sw: ['#ffffff', '#000000', '#005a9e'],
      why: '文字と背景の差を最大にしました。赤と緑に頼らず、青とオレンジ（ダークでは黄色）で区別するので、色の見分けにくい方にも使いやすい配色です。明るい屋外にも。' },
    { id: 'std', group: 'base', name: 'スタンダード', tag: 'これまでの青', sw: ['#f4f3ef', '#17171a', '#2f5bea'], why: 'これまでの、青を基調にした配色です。' },
    { id: 'moss', group: 'base', name: 'ナチュラル', tag: 'クリームとモスグリーン', sw: ['#f2ecdf', '#1b1a17', '#5a7549'], why: 'クリーム色の紙のような地に、モスグリーン。やさしい印象の配色です。' },
    { id: 'navy', group: 'base', name: 'ディープブルー', tag: '紺と水色のアカデミック', sw: ['#eaf0f8', '#0a1730', '#143a73'], why: '紺と水色の、引き締まった配色です。' },
    { id: 'sun', group: 'base', name: 'フォーカスイエロー', tag: '白とチャコールに黄色', sw: ['#f1f2f3', '#17181b', '#f5bd1f'], why: '白とチャコールに、黄色の強調。操作する場所が分かりやすい配色です。' },
  ];

  /* 「目的から選ぶ」：その場面に合うテーマを、ワンタッチで選ぶ */
  const SCENES = [
    { id: 'focus', label: '集中したい', theme: 'calm' },
    { id: 'memorize', label: '暗記したい', theme: 'marker' },
    { id: 'relax', label: '落ち着きたい', theme: 'mint' },
    { id: 'energy', label: 'やる気を出したい', theme: 'sunrise' },
    { id: 'night', label: '夜に使う', theme: 'night' },
    { id: 'clear', label: '見えにくい・屋外', theme: 'clear' },
  ];

  const OPTIONS = {
    theme: THEMES.map((t) => t.id),
    mode: ['auto', 'light', 'dark'],
    size: ['s', 'm', 'l'],
    round: ['s', 'm', 'l'],
    layout: ['auto', 'pc', 'phone'],
    night: ['off', 'on'], // 夜（21時〜朝5時）は、自動で「夜」テーマにする
  };
  const DEFAULTS = { theme: 'std', mode: 'auto', size: 'm', round: 'm', layout: 'auto', night: 'off' };

  function read() {
    try {
      const j = JSON.parse(root.localStorage.getItem(KEY)) || {};
      const out = {};
      Object.keys(DEFAULTS).forEach((k) => { out[k] = OPTIONS[k].includes(j[k]) ? j[k] : DEFAULTS[k]; }); // 不正な値は標準に戻す
      return out;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  let prefs = read();

  // 幅が狭い（スマホ）、または横向きのスマホ（高さが低くて、指で操作する端末）
  const mq = root.matchMedia ? root.matchMedia('(max-width: 760px), (pointer: coarse) and (max-height: 520px)') : null;
  const isPhone = () => prefs.layout === 'phone' || (prefs.layout === 'auto' && !!mq && mq.matches);

  const isNight = () => { const h = T.clock(); return h >= 21 || h < 5; };
  /** いま実際に使うテーマ（夜の自動切り替えがオンで、夜の時間なら「夜」） */
  const effectiveTheme = () => (prefs.night === 'on' && isNight() ? 'night' : prefs.theme);

  function apply() {
    const d = root.document.documentElement;
    d.dataset.theme = effectiveTheme(); d.dataset.mode = prefs.mode; d.dataset.size = prefs.size; d.dataset.round = prefs.round;
    d.classList.toggle('is-phone', isPhone());
  }

  const T = (LN.theme = {
    THEMES, SCENES, OPTIONS, DEFAULTS,
    clock: () => new Date().getHours(), // テスト用に差し替えられる
    get: () => Object.assign({}, prefs),
    effective: effectiveTheme,
    isPhone,
    onLayoutChange: null, // app.js が、画面の種類が変わったときの再描画を登録する
    /** 時刻による自動切り替えを、いま一度確かめ直す */
    refresh() { apply(); },
    /** ホームページ（アプリの説明と、パソコン版／スマホ版の選択）を閉じて、アプリを見せる */
    closeLanding() { root.document.documentElement.dataset.landing = 'off'; },
    set(k, v) {
      if (!OPTIONS[k] || !OPTIONS[k].includes(v) || prefs[k] === v) return false;
      const was = isPhone();
      prefs[k] = v;
      try { root.localStorage.setItem(KEY, JSON.stringify(prefs)); } catch (e) { /* 保存できなくても、この回は反映される */ }
      apply();
      if (was !== isPhone() && T.onLayoutChange) T.onLayoutChange();
      return true;
    },
  });
  apply();

  /* ホームページを出すか：ログイン済みの人、「ログインせずに使う」を選んだ人には出さない（それ以外＝初めての人に出す）。
   * 画面を描く前にここで決める（アプリが一瞬見えて切り替わるちらつきを防ぐ）。 */
  (function () {
    let state = 'on';
    try {
      const b = JSON.parse(root.localStorage.getItem('ln.cloud.v1') || 'null');
      if ((b && b.enabled) || JSON.parse(root.localStorage.getItem('ln.cloud.skip') || 'null')) state = 'off';
    } catch (e) { /* 読めなければ、案内を出す */ }
    root.document.documentElement.dataset.landing = state;
  })();

  if (mq && mq.addEventListener) mq.addEventListener('change', () => {
    const was = root.document.documentElement.classList.contains('is-phone');
    apply();
    if (was !== isPhone() && T.onLayoutChange) T.onLayoutChange();
  });
  // 夜の自動切り替え：開いたまま時間がたっても、切り替わるように
  root.setInterval(() => { if (prefs.night === 'on') apply(); }, 5 * 60 * 1000);
  root.document.addEventListener('visibilitychange', () => { if (!root.document.hidden && prefs.night === 'on') apply(); });
})(window);
