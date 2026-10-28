/* 棚の「列」の画面の部品（段階A）。棚 → フォルダ → フォルダ … と深く入れ子になっても、横に収まるように、列の並べ方を決める。
 *  - 列は、フォルダ1つにつき1本（そのフォルダの中身＝フォルダと投稿の一覧）。いちばん奥（いま開いているフォルダ）の列と、その手前の列が、画面の幅に収まる数だけ開く。
 *  - 収まらない手前の列は、細い帯（縦書きの名前つき）にしまう。帯は、押すとひらく。しまう列が3本以上続くときは、「…」1本にまとめる（押すと、上の階層の一覧が出る）。
 *  - この中の C.plan・C.capacity・C.colorIndex は、画面を使わない純粋な関数（Node でテストできる）。DOM を作る部品（icon・foldBtn・strip）は、ui.js から渡される h（DOM を作る道具）を使う。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const C = (S.cols = {});
  const doc = root.document;

  C.COL_W = 240;       // 開いた列の幅（css/shelf.css の .list-col と同じ）
  C.STRIP_W = 38;      // しまった帯の幅（css/app.css の .fold-strip の列と同じ）
  C.VIEW_MIN = 480;    // 右の表示の、これ以上は狭くしたくない幅
  C.MAX_STRIPS = 2;    // 続けてしまう列が、これを超えたら「…」にまとめる
  C.PALETTE = 8;       // 棚の色の数（ノートの教科の色と同じ8色。css/shelf.css の .sc0〜.sc7）

  /** 棚の色の番号（0〜7）。棚の ID から決める（同じ棚は、いつも同じ色。どこにも保存しない） */
  C.colorIndex = function (sid) {
    let n = 7; const s = String(sid);
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return n % C.PALETTE;
  };
  C.colorClass = (sid) => 'sc' + C.colorIndex(sid);

  /** 列が n 本あるとき、幅 width（列と右の表示を並べられる幅）に、開いたまま置ける列の数。右の表示の最小幅を守る（最低1本。0本のときは0） */
  C.capacity = function (n, width) {
    if (!(n > 0)) return 0;
    const w = Number(width) > 0 ? Number(width) : 1000;
    for (let k = n; k > 1; k--) if (k * C.COL_W + Math.min(n - k, C.MAX_STRIPS) * C.STRIP_W + C.VIEW_MIN <= w) return k;
    return 1;
  };

  /** 列の並びを決める。
   *  ids＝最上位から、いま開いているフォルダまでの、フォルダの ID（最上位は 'root'）
   *  opt.width＝列と右の表示を並べられる幅（px）／opt.open＝利用者が「ひらく」を選んだ列（古い順）／opt.closed＝利用者が「しまう」を選んだ列
   *  → ids の順に、[{ kind: 'col', id }（開く）| { kind: 'strip', id }（帯）| { kind: 'merge', ids }（「…」にまとめた帯。ids は、まとめた列）] */
  C.plan = function (ids, opt) {
    opt = opt || {};
    const n = ids.length, cap = C.capacity(n, opt.width);
    const closed = new Set((opt.closed || []).filter((id) => ids.includes(id)));
    const pinned = (opt.open || []).filter((id) => ids.includes(id) && !closed.has(id)).reverse().slice(0, cap);   // 新しく「ひらく」を選んだ順
    const open = new Set(pinned);
    // 自動で開く列は、いちばん奥から。利用者が「しまう」を選んだ列の分は、ほかの列で埋めない（右の表示を広げたいから）
    const lost = ids.slice(Math.max(0, n - cap)).filter((id) => closed.has(id)).length;
    const target = Math.max(pinned.length, cap - lost);
    for (let i = n - 1; i >= 0 && open.size < target; i--) if (!closed.has(ids[i])) open.add(ids[i]);
    const out = []; let run = [];
    const flush = () => {
      if (run.length > C.MAX_STRIPS) { out.push({ kind: 'merge', ids: run.slice(0, -1) }); out.push({ kind: 'strip', id: run[run.length - 1] }); }
      else run.forEach((id) => out.push({ kind: 'strip', id }));
      run = [];
    };
    ids.forEach((id) => { if (open.has(id)) { flush(); out.push({ kind: 'col', id }); } else run.push(id); });
    flush();
    return out;
  };

  /* ---------- 画面の部品（DOM） ---------- */
  const PATHS = {
    chev: 'M9 6l6 6-6 6', plus: 'M12 5v14M5 12h14', folder: 'M3 7h6l2 2h10v10H3z', book: 'M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4z|M9 9h6M9 13h6',
    edit: 'M4 20h4L19 9l-4-4L4 16v4z|M13.5 6.5l4 4', menu: 'M5 7h14M5 12h14M5 17h14', info: 'M12 8v.01M12 11v5',
  };
  /** 線画のアイコン（ノートアプリと同じ線の太さ・丸み。css/app.css の svg.i） */
  C.icon = function (name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'i'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    String(PATHS[name] || '').split('|').filter(Boolean).forEach((d) => { const p = doc.createElementNS(NS, 'path'); p.setAttribute('d', d); svg.appendChild(p); });
    if (name === 'info') { const c = doc.createElementNS(NS, 'circle'); c.setAttribute('cx', '12'); c.setAttribute('cy', '12'); c.setAttribute('r', '9'); svg.appendChild(c); }
    return svg;
  };

  /** しまう／ひらくのボタン（ノートアプリの .fold-btn と同じ）。o.open＝いま開いているか、o.title＝説明 */
  C.foldBtn = (h, o) => h('button', { type: 'button', class: 'fold-btn', 'aria-expanded': String(!!o.open), title: o.title, 'aria-label': o.title, onclick: o.onclick }, C.icon('chev'));

  /** しまった列の帯（縦書きの名前つき）。押すと o.onclick。o.merged＝「…」にまとめた帯 */
  C.strip = function (h, o) {
    const go = (e) => { e.stopPropagation(); o.onclick(e); };
    return h('section', { class: 'list-col sh-folded' + (o.merged ? ' sh-merged' : ''), 'data-fid': o.id },
      h('div', { class: 'fold-strip', role: 'button', tabindex: 0, title: (o.merged ? '上の階層を見る：' : 'ひらく：') + o.label, onclick: go,
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } } },
      C.foldBtn(h, { open: false, title: (o.merged ? '上の階層を見る：' : 'ひらく：') + o.label, onclick: go }), h('span', { class: 'fold-lbl', text: o.label })));
  };
})(window);
