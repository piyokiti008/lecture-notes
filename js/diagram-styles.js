/* 図の「描画パターン」（見た目）。配置（diagram.js）が作った部品の一覧を、パターンごとの色・線・形・飾りで SVG にする。
   パターンを足すときは STYLES に 1 つ書くだけ（配置のコードは触らない）。
   部品（プリミティブ）：rect（shape = rect/pill/ellipse/diamond/hex）／circle／text／path／arrow。役割（role）ごとに、look() が色・線を決める。
   使うのは rect / ellipse / polygon / path / circle / text / defs / linearGradient / stop だけ（svg.js の許可リストの範囲内）。
   文字の色は、すべての色・役割の組み合わせで、地との明暗差 4.5 以上になるようにする（test/test-diagram.js が確かめる）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const FONT = 'Yu Gothic, Meiryo, Hiragino Sans, Noto Sans CJK JP, sans-serif';
  const GREY = '#cdd5df';

  /* ---------- 色の組：f=淡い塗り / s=線 / t=淡い塗りの上の文字 / d=濃い塗り（白文字を載せても読める濃さ） ---------- */
  const PAL = [ // 鮮やか（図形強調・立体）
    { f: '#e6effd', s: '#4a86e8', t: '#173d7a', d: '#2a62c4' }, // 青
    { f: '#fdeedc', s: '#ee9a3a', t: '#6b3c05', d: '#b25b00' }, // 橙
    { f: '#e3f4e8', s: '#3aa468', t: '#14502f', d: '#1f7a45' }, // 緑
    { f: '#eee8fa', s: '#9066d6', t: '#43267a', d: '#6f45b8' }, // 紫
    { f: '#fce6ea', s: '#e0566f', t: '#721a2b', d: '#bf3350' }, // 赤
    { f: '#dcf3f3', s: '#2aa4a4', t: '#0c4a4a', d: '#147777' }, // 青緑
  ];
  const PAL_FLAT = [ // 落ち着いた単色（シンプルフラット）。濃い塗りに白文字
    { f: '#e4edf3', s: '#3d6b8e', t: '#1f3a4f', d: '#3d6b8e' }, // 鋼青
    { f: '#e5eee8', s: '#4d7c5f', t: '#244233', d: '#4d7c5f' }, // 若草
    { f: '#f3e9d6', s: '#9a6a1c', t: '#5a3d0b', d: '#9a6a1c' }, // 黄土
    { f: '#ece3ea', s: '#7a5576', t: '#45304a', d: '#7a5576' }, // 藤
    { f: '#e6e9ec', s: '#5c6773', t: '#2a3239', d: '#5c6773' }, // 灰青
    { f: '#dfecec', s: '#2f7a7a', t: '#17403f', d: '#2f7a7a' }, // 青緑
  ];
  const PAL_DUSTY = [ // くすみ（淡い面＋やや濃い縁）
    { f: '#e3eaee', s: '#7c97a8', t: '#2f4756', d: '#4d6d80' },
    { f: '#e5ebdf', s: '#8da57f', t: '#3d5232', d: '#58724a' },
    { f: '#f1e9d8', s: '#c4a86d', t: '#5c4718', d: '#8a6d2c' },
    { f: '#f1e1e1', s: '#b98585', t: '#6a3636', d: '#8f5252' },
    { f: '#e8e3ef', s: '#9a8bb5', t: '#46386a', d: '#6b5a8e' },
    { f: '#dcebea', s: '#6fa3a0', t: '#27504d', d: '#3f7a76' },
  ];
  const PAL_MARKER = [ // 蛍光ペン（手書き）。濃い文字
    { f: '#fff0a0', s: '#3f3a34', t: '#2b2724', d: '#3f3a34' },
    { f: '#cde4ff', s: '#3f3a34', t: '#2b2724', d: '#3f3a34' },
    { f: '#ffd3de', s: '#3f3a34', t: '#2b2724', d: '#3f3a34' },
    { f: '#d3efc4', s: '#3f3a34', t: '#2b2724', d: '#3f3a34' },
    { f: '#e2d6ff', s: '#3f3a34', t: '#2b2724', d: '#3f3a34' },
    { f: '#ffdfbd', s: '#3f3a34', t: '#2b2724', d: '#3f3a34' },
  ];
  const NEUTRAL = { f: '#f3f4f6', s: '#4b5563', t: '#111827', d: '#374151' };
  const ACC = { f: '#e8f0fe', s: '#1d5fd1', t: '#0b2e6b', d: '#1d5fd1' };
  const pal = (P, p) => P[(p.c || 0) % P.length];

  const mix = (a, b, t) => { // 2 つの #rrggbb を、t の割合で混ぜる
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16)), pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
  };

  const SHAPES = { process: 'rect', start: 'rect', end: 'rect', decision: 'diamond', tree: 'rect', map: 'ellipse', cycle: 'rect' };
  const mk = (o) => Object.assign({ font: FONT, edge: { col: '#64748b', w: 1.8 }, titleCol: '#111827', rule: true, ruleColor: '#4a86e8', badges: false, shadow: false, gloss: false, sketch: false },
    o, { m: Object.assign({ fs: 16, fsDetail: 13, fsTitle: 22, pad: 14, padY: 10, minW: 96, minH: 46, radius: 10 }, o.m), shapes: Object.assign({}, SHAPES, o.shapes) });

  /* look(role, p) → { f:塗り, fo:塗りの透明度, s:線, sw:線の太さ, t:文字, t2:補足文字, dash:破線, fc:[塗りの代表色（検査用）] }
     role: node（箱）/ head・rowhead・cell（表）/ card（年表のカード）/ dot / badge / when / axis / legend / elabel / venn
     p: c（色番号）lvl（深さ・行）g（グループ）root（階層の根）hl（強調）*/
  const STYLES = {
    /* ① シンプルフラット：落ち着いた単色の面。飾りなし。どんな内容にも使える定番 */
    flat: mk({
      id: 'flat', label: 'シンプルフラット', desc: '落ち着いた単色の面と白い文字。飾りなしで、どんな内容にも合う定番',
      m: { radius: 10 }, edge: { col: '#6b7785', w: 1.9 }, titleCol: '#1f2a37', ruleColor: '#3d6b8e', badges: false,
      shapes: { start: 'pill', end: 'pill', map: 'pill' },
      look(role, p) {
        const c = pal(PAL_FLAT, p);
        switch (role) {
          case 'head': return { f: c.d, s: c.d, sw: 1, t: '#fff', t2: '#fff' };
          case 'rowhead': return { f: '#eaeff3', s: GREY, sw: 1, t: '#1e293b', t2: '#334155' };
          case 'cell': return { f: p.lvl % 2 ? '#f7f9fb' : '#fff', s: GREY, sw: 1, t: '#1f2937', t2: '#475569' };
          case 'dot': return { f: c.d, s: '#fff', sw: 3 };
          case 'badge': return { f: '#fff', s: c.d, sw: 2, t: c.d };
          case 'when': return { t: c.d };
          case 'axis': return { s: '#9aa6b3', sw: 3 };
          case 'legend': return { f: c.d, s: c.d, sw: 1, t: '#1f2937' };
          case 'elabel': return { f: '#fff', t: '#334155' };
          case 'venn': return { f: c.d, fo: 0.3, s: c.d, sw: 2, t: '#1f2937' };
          default: return p.hl ? { f: '#b3541e', s: '#b3541e', sw: 1, t: '#fff', t2: '#fff' } : { f: c.d, s: c.d, sw: 1, t: '#fff', t2: '#fff' };
        }
      },
    }),

    /* ③ くすみカラー：くすんだ淡い面に、少し太めの濃い縁（個性のある線） */
    dusty: mk({
      id: 'dusty', label: 'くすみカラー', desc: 'くすんだ淡い色の面と、少し太めの縁。落ち着きと読みやすさをあわせ持つ',
      m: { radius: 12 }, edge: { col: '#6f7f8c', w: 2 }, titleCol: '#2b3a44', ruleColor: '#7c97a8',
      shapes: { start: 'pill', end: 'pill', map: 'ellipse' },
      look(role, p) {
        const c = pal(PAL_DUSTY, p);
        switch (role) {
          case 'head': return { f: c.d, s: c.d, sw: 1, t: '#fff', t2: '#fff' };
          case 'rowhead': return { f: c.f, s: c.s, sw: 1.2, t: c.t, t2: c.t };
          case 'cell': return { f: p.lvl % 2 ? '#f8f8f6' : '#fff', s: '#cfd5d6', sw: 1, t: '#26323a', t2: '#4a5860' };
          case 'dot': return { f: c.s, s: '#fff', sw: 3 };
          case 'badge': return { f: c.d, s: '#fff', sw: 1.5, t: '#fff' };
          case 'when': return { t: c.d };
          case 'axis': return { s: '#b3bcc2', sw: 3 };
          case 'legend': return { f: c.f, s: c.s, sw: 2, t: '#26323a' };
          case 'elabel': return { f: '#fff', t: '#3a4a54' };
          case 'venn': return { f: c.s, fo: 0.3, s: c.s, sw: 2.4, t: '#26323a' };
          default: return p.hl ? { f: c.s, s: c.d, sw: 3.4, t: '#1b242a', t2: '#1b242a' } : { f: c.f, s: c.s, sw: 2.2, t: c.t, t2: '#3a4a54' };
        }
      },
    }),

    /* ④ モノトーン＋アクセント：灰色と、1 色だけのアクセント（強調した項目だけ色が付く）。白黒コピーでも読める */
    accent: mk({
      id: 'accent', label: 'モノトーン＋アクセント', desc: '灰色の線と、1 色だけの強調。いちばん大事な項目だけ色が付くので、白黒コピーでも要点が伝わる',
      m: { radius: 3 }, edge: { col: '#4b5563', w: 1.8 }, titleCol: '#111827', ruleColor: '#1d5fd1', badges: true,
      shapes: { map: 'ellipse' },
      look(role, p) {
        switch (role) {
          case 'head': return { f: '#374151', s: '#374151', sw: 1, t: '#fff', t2: '#fff' };
          case 'rowhead': return { f: '#eef0f3', s: '#b9c0c9', sw: 1, t: '#111827', t2: '#374151' };
          case 'cell': return { f: p.lvl % 2 ? '#f7f8fa' : '#fff', s: '#c4cad2', sw: 1, t: '#111827', t2: '#374151' };
          case 'dot': return { f: '#fff', s: '#4b5563', sw: 3 };
          case 'badge': return { f: '#fff', s: '#4b5563', sw: 1.8, t: '#111827' };
          case 'when': return { t: '#111827' };
          case 'axis': return { s: '#6b7280', sw: 2.4 };
          case 'legend': return { f: '#9ca3af', s: '#4b5563', sw: 1.4, t: '#111827' };
          case 'elabel': return { f: '#fff', t: '#111827' };
          case 'venn': return { f: '#6b7280', fo: 0.16, s: '#4b5563', sw: 2, t: '#111827' };
          default:
            if (p.hl) return { f: ACC.d, s: ACC.d, sw: 1, t: '#fff', t2: '#fff' };
            if (p.root) return { f: '#374151', s: '#374151', sw: 1, t: '#fff', t2: '#fff' };
            return { f: '#f3f4f6', s: '#4b5563', sw: 1.7, t: '#111827', t2: '#374151' };
        }
      },
    }),

    /* ⑥ 手書き：ゆらぐ線・蛍光ペンの塗り・開いた矢じり（ノートに書いたような見た目。線のゆらぎは、位置で決まるので毎回同じ） */
    sketch: mk({
      id: 'sketch', label: '手書き', desc: 'ノートに手で描いたような、ゆらぐ線と蛍光ペン風の色。気軽に使えるカジュアルな見た目',
      m: { radius: 4, pad: 15 }, edge: { col: '#3f3a34', w: 1.9 }, titleCol: '#2b2724', ruleColor: '#3f3a34', sketch: true, badges: false,
      shapes: { start: 'pill', end: 'pill', map: 'ellipse' },
      look(role, p) {
        const c = pal(PAL_MARKER, p);
        switch (role) {
          case 'head': return { f: c.f, s: '#3f3a34', sw: 1.4, t: '#2b2724', t2: '#2b2724' };
          case 'rowhead': return { f: '#fff7cf', s: '#8a847a', sw: 1, t: '#2b2724', t2: '#3f3a34' };
          case 'cell': return { f: '#fff', s: '#8a847a', sw: 1, t: '#2b2724', t2: '#3f3a34' };
          case 'dot': return { f: c.f, s: '#3f3a34', sw: 2 };
          case 'badge': return { f: c.f, s: '#3f3a34', sw: 1.6, t: '#2b2724' };
          case 'when': return { t: '#2b2724' };
          case 'axis': return { s: '#3f3a34', sw: 2.4 };
          case 'legend': return { f: c.f, s: '#3f3a34', sw: 1.4, t: '#2b2724' };
          case 'elabel': return { f: '#fff', t: '#2b2724' };
          case 'venn': return { f: c.f, fo: 0.75, s: '#3f3a34', sw: 2, t: '#2b2724' };
          default: return p.hl ? { f: '#ffe14d', s: '#3f3a34', sw: 2.8, t: '#2b2724', t2: '#2b2724' } : { f: c.f, s: '#3f3a34', sw: 1.9, t: '#2b2724', t2: '#3f3a34' };
        }
      },
    }),

    /* ⑦ 図形強調：六角形・ひし形・丸などの形と、鮮やかな塗り。番号つきで、手順が目に入る */
    shape: mk({
      id: 'shape', label: '図形強調', desc: '六角形・ひし形・丸などの形と、鮮やかな塗り。番号つきで、手順や分類がはっきり見える',
      m: { radius: 8 }, edge: { col: '#334155', w: 2.2 }, titleCol: '#0f172a', ruleColor: '#2a62c4', badges: true, shadow: true,
      shapes: { process: 'hex', start: 'pill', end: 'pill', decision: 'diamond', tree: 'ellipse', map: 'pill', cycle: 'pill' },
      look(role, p) {
        const c = pal(PAL, p);
        switch (role) {
          case 'head': return { f: c.d, s: c.d, sw: 1, t: '#fff', t2: '#fff' };
          case 'rowhead': return { f: '#e8edf3', s: GREY, sw: 1, t: '#1e293b', t2: '#334155' };
          case 'cell': return { f: '#fff', s: GREY, sw: 1, t: '#1f2937', t2: '#475569' };
          case 'dot': return { f: c.d, s: '#fff', sw: 3 };
          case 'badge': return { f: '#fff', s: c.d, sw: 2.2, t: c.d };
          case 'when': return { t: c.d };
          case 'axis': return { s: '#334155', sw: 3.4 };
          case 'legend': return { f: c.d, s: c.d, sw: 1, t: '#1f2937' };
          case 'elabel': return { f: '#fff', t: '#1e293b' };
          case 'venn': return { f: c.d, fo: 0.26, s: c.d, sw: 2.4, t: '#1f2937' };
          default: return p.hl ? { f: c.d, s: '#facc15', sw: 4, t: '#fff', t2: '#fff' } : { f: c.d, s: c.d, sw: 1, t: '#fff', t2: '#fff' };
        }
      },
    }),

    /* ⑧ 立体：淡いグラデーション・光沢・影。画面で見る・発表向き */
    glossy: mk({
      id: 'glossy', label: '立体', desc: '淡いグラデーションと光沢、やわらかい影で、少し立体的に。画面で見る・発表用に',
      m: { radius: 12 }, edge: { col: '#64748b', w: 2 }, titleCol: '#172033', ruleColor: '#4a86e8', badges: false, shadow: true, gloss: true,
      shapes: { start: 'pill', end: 'pill', map: 'ellipse' },
      look(role, p) {
        const c = pal(PAL, p), top = mix(c.f, '#ffffff', 0.55), bot = mix(c.f, c.s, 0.3);
        switch (role) {
          case 'head': return { f: c.d, s: c.d, sw: 1, t: '#fff', t2: '#fff' };
          case 'rowhead': return { f: '#eef2f8', s: GREY, sw: 1, t: '#1e293b', t2: '#334155' };
          case 'cell': return { f: p.lvl % 2 ? '#f6f8fb' : '#fff', s: GREY, sw: 1, t: '#1f2937', t2: '#475569' };
          case 'dot': return { f: c.s, s: '#fff', sw: 3 };
          case 'badge': return { f: c.d, s: '#fff', sw: 1.5, t: '#fff' };
          case 'when': return { t: c.d };
          case 'axis': return { s: '#a5b1c2', sw: 3.4 };
          case 'legend': return { f: c.s, s: c.s, sw: 1, t: '#1f2937' };
          case 'elabel': return { f: '#fff', t: '#334155' };
          case 'venn': return { f: c.s, fo: 0.3, s: c.s, sw: 2.4, t: '#1f2937' };
          default: return { f: 'url(#g' + ((p.c || 0) % PAL.length) + ')', fc: [top, bot], s: p.hl ? c.d : c.s, sw: p.hl ? 3.4 : 1.8, t: c.t, t2: '#334155' };
        }
      },
      /* グラデーションの定義：色ごとに 1 つ（上が明るく、下がやや濃い）＋光沢用の白 */
      defs() {
        return '<defs>' + PAL.map((c, i) => '<linearGradient id="g' + i + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + mix(c.f, '#ffffff', 0.55) + '"/><stop offset="1" stop-color="' + mix(c.f, c.s, 0.3) + '"/></linearGradient>').join('') +
          '<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.7"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient></defs>';
      },
    }),

    /* 白黒印刷：白・灰色・黒だけ。濃さと線の種類（実線／破線）で区別でき、白黒コピーしても読める */
    mono: mk({
      id: 'mono', label: '白黒印刷', desc: '白・グレー・黒だけ。濃さと線の種類（実線／破線）で区別でき、白黒コピーしても読める',
      m: { radius: 4 }, edge: { col: '#000', w: 2 }, titleCol: '#000', ruleColor: '#000', badges: true,
      shapes: { start: 'pill', end: 'pill', map: 'ellipse' },
      look(role, p) {
        const shade = ['#ffffff', '#ececec', '#d9d9d9'][(p.lvl || 0) % 3];
        const dash = p.g >= 0 ? [null, '7 4', '2 3'][p.g % 3] : null;
        switch (role) {
          case 'head': return { f: '#000', s: '#000', sw: 1, t: '#fff', t2: '#fff' };
          case 'rowhead': return { f: '#e2e2e2', s: '#000', sw: 1.2, t: '#000', t2: '#222' };
          case 'cell': return { f: '#fff', s: '#000', sw: 1.2, t: '#000', t2: '#222' };
          case 'card': return { f: '#fff', s: '#000', sw: 2, t: '#000', t2: '#111' };
          case 'dot': return { f: '#000', s: '#fff', sw: 2.5 };
          case 'badge': return { f: '#000', s: '#fff', sw: 1.5, t: '#fff' };
          case 'when': return { t: '#000' };
          case 'axis': return { s: '#000', sw: 3 };
          case 'legend': return { f: '#fff', s: '#000', sw: 1.8, t: '#000', dash };
          case 'elabel': return { f: '#fff', t: '#000' };
          case 'venn': return { f: '#000', fo: 0.1, s: '#000', sw: 2.2, t: '#000', dash: [null, '8 5', '2 4'][(p.g >= 0 ? p.g : p.c || 0) % 3] };
          default: return p.hl ? { f: '#000', s: '#000', sw: 2, t: '#fff', t2: '#fff' } : { f: shade, s: '#000', sw: 2, t: '#000', t2: '#111', dash };
        }
      },
    }),
  };
  const ORDER = ['flat', 'dusty', 'accent', 'sketch', 'shape', 'glossy', 'mono'];
  const list = () => ORDER.map((id) => ({ id: id, label: STYLES[id].label, desc: STYLES[id].desc }));
  const get = (id) => STYLES[id] || STYLES.flat;
  const shapeFor = (S, kind) => S.shapes[kind] || 'rect';

  /* ---------- 図形・手書き風の線 ---------- */
  const fx = (v) => String(Math.round(v * 10) / 10);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dashAttr = (d) => (d ? ' stroke-dasharray="' + d + '"' : '');

  /** 六角形の「欠け」の大きさ（配置とそろえる） */
  const hexCut = (w, h) => Math.min(h * 0.3, w * 0.2);
  function polyPts(p) {
    const x = p.x, y = p.y, w = p.w, h = p.h;
    if (p.shape === 'diamond') return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]];
    if (p.shape === 'hex') { const c = hexCut(w, h); return [[x + c, y], [x + w - c, y], [x + w, y + h / 2], [x + w - c, y + h], [x + c, y + h], [x, y + h / 2]]; }
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  }
  /** 図形の要素（dx, dy ずらして描く。attrs は塗り・線の属性） */
  function geomEl(p, r, attrs, dx, dy) {
    dx = dx || 0; dy = dy || 0;
    if (p.shape === 'ellipse') return '<ellipse cx="' + fx(p.x + p.w / 2 + dx) + '" cy="' + fx(p.y + p.h / 2 + dy) + '" rx="' + fx(p.w / 2) + '" ry="' + fx(p.h / 2) + '" ' + attrs + '/>';
    if (p.shape === 'diamond' || p.shape === 'hex') return '<polygon points="' + polyPts(p).map((q) => fx(q[0] + dx) + ',' + fx(q[1] + dy)).join(' ') + '" stroke-linejoin="round" ' + attrs + '/>';
    const rr = p.shape === 'pill' ? p.h / 2 : r;
    return '<rect x="' + fx(p.x + dx) + '" y="' + fx(p.y + dy) + '" width="' + fx(p.w) + '" height="' + fx(p.h) + '" rx="' + fx(rr) + '" ' + attrs + '/>';
  }
  function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const hash = (...v) => v.reduce((h, x) => (Math.imul(h ^ Math.round(x * 10), 16777619) >>> 0), 2166136261);
  /** 図形の輪郭を、一定間隔の点で表す（手書き風のゆらぎをつけるため） */
  function outlinePts(p, r, step) {
    const x = p.x, y = p.y, w = p.w, h = p.h, pts = [];
    if (p.shape === 'ellipse') {
      const n = Math.max(24, Math.ceil(Math.PI * (w + h) / 2 / step));
      for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n - Math.PI / 2; pts.push([x + w / 2 + (w / 2) * Math.cos(a), y + h / 2 + (h / 2) * Math.sin(a)]); }
      return pts;
    }
    if (p.shape === 'diamond' || p.shape === 'hex') {
      const vs = polyPts(p);
      vs.forEach((a, i) => { const b = vs[(i + 1) % vs.length], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let j = 0; j < k; j++) pts.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]); });
      return pts;
    }
    const rr = Math.min(p.shape === 'pill' ? h / 2 : r, w / 2, h / 2);
    const line = (x1, y1, x2, y2) => { const k = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step)); for (let j = 0; j < k; j++) pts.push([x1 + ((x2 - x1) * j) / k, y1 + ((y2 - y1) * j) / k]); };
    const arc = (cx, cy, a0) => { const k = Math.max(2, Math.ceil((rr * Math.PI) / 2 / step)); for (let j = 0; j < k; j++) { const a = a0 + ((Math.PI / 2) * j) / k; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); } };
    line(x + rr, y, x + w - rr, y); arc(x + w - rr, y + rr, -Math.PI / 2);
    line(x + w, y + rr, x + w, y + h - rr); arc(x + w - rr, y + h - rr, 0);
    line(x + w - rr, y + h, x + rr, y + h); arc(x + rr, y + h - rr, Math.PI / 2);
    line(x, y + h - rr, x, y + rr); arc(x + rr, y + rr, Math.PI);
    return pts;
  }
  /** 手書き風の輪郭（ゆるやかなゆらぎ。seed が同じなら、いつも同じ形） */
  function wobblePath(p, r, seed, amp) {
    const pts = outlinePts(p, r, 11), rnd = mulberry(seed), cx = p.x + p.w / 2, cy = p.y + p.h / 2;
    const f1 = 2 + Math.floor(rnd() * 2), f2 = 5 + Math.floor(rnd() * 3), ph1 = rnd() * 6.28, ph2 = rnd() * 6.28, n = pts.length;
    let d = '';
    pts.forEach((q, i) => {
      const t = i / n, off = amp * (0.75 * Math.sin(6.283 * f1 * t + ph1) + 0.45 * Math.sin(6.283 * f2 * t + ph2));
      const vx = q[0] - cx, vy = q[1] - cy, len = Math.hypot(vx, vy) || 1;
      d += (i ? ' L' : 'M') + fx(q[0] + (vx / len) * off) + ' ' + fx(q[1] + (vy / len) * off);
    });
    return d + ' Z';
  }

  function paint(S, p) {
    switch (p.k) {
      case 'rect': {
        const L = S.look(p.role, p);
        const r = p.rx != null ? p.rx : S.m.radius;
        const isNode = p.role === 'node' || p.role === 'card', isVenn = p.role === 'venn';
        let out = '';
        if (S.shadow && isNode) out += geomEl(p, r, 'fill="#000" fill-opacity="0.11"', 2, 3.5);
        const fo = L.fo != null ? ' fill-opacity="' + L.fo + '"' : '';
        if (S.sketch && (isNode || isVenn)) {
          // 手書き風：蛍光ペンの塗り（少しずらす）＋ゆらぐ輪郭を 2 回なぞる
          const seed = hash(p.x, p.y, p.w, p.h);
          out += geomEl(p, r, 'fill="' + L.f + '"' + fo + ' stroke="none"', 1.6, 1.6);
          out += '<path d="' + wobblePath(p, r, seed, 1.3) + '" fill="none" stroke="' + L.s + '" stroke-width="' + L.sw + '" stroke-linecap="round" stroke-linejoin="round"' + dashAttr(L.dash) + '/>';
          out += '<path d="' + wobblePath(p, r, seed + 977, 1.5) + '" fill="none" stroke="' + L.s + '" stroke-width="1" stroke-opacity="0.5" stroke-linecap="round" stroke-linejoin="round"/>';
          return out;
        }
        const attrs = 'fill="' + L.f + '"' + fo + ' stroke="' + (L.s || 'none') + '" stroke-width="' + (L.sw || 0) + '"' + dashAttr(L.dash);
        out += geomEl(p, r, attrs, 0, 0);
        if (S.gloss && isNode && (p.shape === 'rect' || p.shape === 'pill' || p.shape === 'ellipse' || !p.shape)) {
          out += p.shape === 'ellipse'
            ? '<ellipse cx="' + fx(p.x + p.w / 2) + '" cy="' + fx(p.y + p.h * 0.3) + '" rx="' + fx(p.w * 0.38) + '" ry="' + fx(p.h * 0.22) + '" fill="url(#gl)"/>'
            : '<rect x="' + fx(p.x + 3) + '" y="' + fx(p.y + 2) + '" width="' + fx(p.w - 6) + '" height="' + fx(p.h * 0.42) + '" rx="' + fx(Math.max(2, (p.shape === 'pill' ? p.h / 2 : r) - 3)) + '" fill="url(#gl)"/>';
        }
        return out;
      }
      case 'circle': {
        const L = S.look(p.role, p);
        if (p.role === 'badge' && !S.badges) return '';
        return '<circle cx="' + fx(p.cx) + '" cy="' + fx(p.cy) + '" r="' + fx(p.r) + '" fill="' + L.f + '" stroke="' + L.s + '" stroke-width="' + L.sw + '"/>';
      }
      case 'text': {
        if (p.own === 'badge' && !S.badges) return '';
        const L = S.look(p.own, p);
        const col = p.detail ? L.t2 || L.t : L.t;
        let out = '';
        p.lines.forEach((line, i) => {
          const y = p.y + i * p.lh + p.lh / 2 + p.fs * 0.35;
          out += '<text x="' + fx(p.x) + '" y="' + fx(y) + '" font-size="' + p.fs + '" text-anchor="' + (p.a || 'middle') + '" fill="' + col + '"' + (p.b ? ' font-weight="700"' : '') + '>' + esc(line) + '</text>';
        });
        return out;
      }
      case 'path': {
        if (p.role === 'axis') {
          const L = S.look('axis', p);
          return '<path d="' + p.d + '" fill="none" stroke="' + L.s + '" stroke-width="' + L.sw + '" stroke-linecap="round"/>';
        }
        const w = p.thin ? Math.max(1, S.edge.w - 0.6) : S.edge.w;
        const one = '<path d="' + p.d + '" fill="none" stroke="' + S.edge.col + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round"' + dashAttr(p.dash ? '6 4' : null) + '/>';
        // 手書き風：もう 1 本、少しずらして薄くなぞる
        return S.sketch ? one + '<path d="' + p.d + '" transform="translate(0.9 -0.8)" fill="none" stroke="' + S.edge.col + '" stroke-width="1" stroke-opacity="0.45" stroke-linecap="round" stroke-linejoin="round"/>' : one;
      }
      case 'arrow': {
        const col = p.role === 'axis' ? S.look('axis', p).s : S.edge.col;
        if (S.sketch) { // 開いた矢じり（V 字）
          const q = p.pts;
          return '<path d="M' + fx(q[2]) + ' ' + fx(q[3]) + ' L' + fx(q[0]) + ' ' + fx(q[1]) + ' L' + fx(q[4]) + ' ' + fx(q[5]) + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
        }
        return '<polygon points="' + p.pts.map(fx).join(' ') + '" fill="' + col + '"/>';
      }
      default: return '';
    }
  }

  /** 題名の下の飾り線（手書きは波線） */
  function ruleSvg(S, cx, y) {
    if (S.sketch) return '<path d="M' + fx(cx - 40) + ' ' + fx(y + 2) + ' q10 -5 20 0 t20 0 t20 0 t20 0" fill="none" stroke="' + S.ruleColor + '" stroke-width="2.2" stroke-linecap="round"/>';
    return '<rect x="' + fx(cx - 28) + '" y="' + fx(y) + '" width="56" height="4" rx="2" fill="' + S.ruleColor + '"/>';
  }

  LN.diagramStyles = { list, get, paint, shapeFor, ruleSvg, hexCut, PAL, FONT, esc, fx };
})(window);
