/* 共同編集の部品（画面も通信も使わない、純粋な関数。Node でもテストできる）。
 *  - 合流（merge3）：前回の同期の時点の本文（base）・自分の本文（mine）・サーバーの本文（theirs）の3つから、1つの本文を作る。
 *    行ごとに合流する。同じ行を両方が直したときは、まず文字ごとに合流を試み、それでも重なったら「両方残して印を付ける」（文字は消えない）。
 *    重なっていない変更は、両方入る。同じ場所への挿入（末尾への追加など）は、両方残す（印なし）。
 *  - changes：古い本文を新しい本文に変える、最小の置き換えの一覧（エディタに、差分だけを入れるため。カーソルの位置が保たれる）。
 *  - 同期の間隔（CFG・pollDelay・sendDue）：通信の回数を減らすための決まり。docs/コミュニティ実装計画.md の共同編集の章。
 *  - pack／unpack：本文の圧縮（gzip→base64）。通信量を約1/3にする。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const CE = (LN.coedit = {});

  /* ---------- 決まり（数字は、あとから調整できるように、ここにまとめる） ---------- */
  CE.CFG = {
    sendIdleMs: 2000,          // 打ち終わって、この時間がたったら送る
    sendMaxMs: 15000,          // 打ち続けていても、最長でこの間隔で送る
    pollBusyMs: 10000,         // 直近1分以内に、ほかの人の変更があったときの、見に行く間隔
    pollBaseMs: 15000,         // ふだん
    pollQuietMs: 30000,        // 5分以上、動きがないとき
    pollIdleMs: 60000,         // 10分以上、動きがないとき／自分ひとりのとき
    busyWindowMs: 60000,
    quietAfterMs: 300000,
    idleAfterMs: 600000,
    stopAfterMs: 900000,       // 15分間、なにもなければ、自動の同期を止める（押すと再開）
    jitter: 0.2,               // 間隔のばらつき（全員が同じ瞬間に集まらないように）
    maxEditors: 8,             // 1つのノートの、同時に参加できる人数
    dailyAutoMs: 3 * 3600 * 1000,   // 1人の、1日あたりの自動同期の合計時間
    maxChars: 100000,          // 共同編集できるノートの、最大の文字数
    autoPendingMs: 6 * 3600 * 1000, // 最後の変更から、この時間で、返却待ちになる
    expireMs: 30 * 24 * 3600 * 1000, // 返却待ちのまま、この時間たつと、消してよい
    editorWindowMs: 10 * 60 * 1000,  // 「いま参加している人」とみなす、最後の書き込みからの時間
    minManualMs: 3000,         // 「今すぐ同期」の連打を防ぐ間隔
  };

  /** 見に行くまでの待ち時間（ms）。null＝自動の同期を止める。
   *  ctx＝{ sinceRemote（ほかの人の変更を最後に見てから）, sinceLocal（自分が最後に打ってから）, alone（自分ひとりだけか）}。rnd＝0〜1の乱数（テスト用に差し替えられる） */
  CE.pollDelay = function (ctx, rnd) {
    const C = CE.CFG, r = typeof rnd === 'function' ? rnd : Math.random;
    const sr = Number(ctx && ctx.sinceRemote), sl = Number(ctx && ctx.sinceLocal);
    const remote = isNaN(sr) ? Infinity : sr, local = isNaN(sl) ? Infinity : sl;
    const act = Math.min(remote, local);
    if (act >= C.stopAfterMs) return null;
    let d = remote < C.busyWindowMs ? C.pollBusyMs : act < C.quietAfterMs ? C.pollBaseMs : act < C.idleAfterMs ? C.pollQuietMs : C.pollIdleMs;
    if (ctx && ctx.alone) d = Math.max(d, C.pollIdleMs);
    return Math.round(d * (1 + (r() * 2 - 1) * C.jitter));
  };
  /** いま送るべきか。dirtySince＝変更があったのに、まだ送っていない状態になった時刻、lastEditAt＝最後に打った時刻（変更がなければ、dirtySince は 0） */
  CE.sendDue = function (now, dirtySince, lastEditAt) {
    if (!dirtySince) return false;
    return now - lastEditAt >= CE.CFG.sendIdleMs || now - dirtySince >= CE.CFG.sendMaxMs;
  };
  /** 送るまで、あと何ms待つか（変更がなければ null） */
  CE.sendWait = function (now, dirtySince, lastEditAt) {
    if (!dirtySince) return null;
    return Math.max(0, Math.min(lastEditAt + CE.CFG.sendIdleMs, dirtySince + CE.CFG.sendMaxMs) - now);
  };

  /** 共同編集できる本文か。画像つきは、いまは対象外（画像は端末ごとに保存されていて、ほかの人に届かないため） */
  CE.checkBody = function (body) {
    const s = String(body || '');
    if (/img:[a-z0-9]{1,64}/.test(s)) return { ok: false, reason: 'images', message: '画像が入っているノートは、まだ共同編集できません（画像は、ほかの人に届かないため）。' };
    if (s.length > CE.CFG.maxChars) return { ok: false, reason: 'long', message: 'ノートが長すぎるため、共同編集できません（' + CE.CFG.maxChars.toLocaleString('ja-JP') + '文字まで。いまは' + s.length.toLocaleString('ja-JP') + '文字です）。' };
    return { ok: true };
  };

  /* ---------- 差分と合流 ---------- */
  const CAP = 4000000;   // 比べる表の大きさの上限（大きすぎるときは、重なった区間を1つの変更として扱う）

  const MAX_D = 3000;   // 違う行（文字）の数がこれ以下なら、Myers 法で（変更が少ないほど速い）
  /** Myers の差分。a・b の一致する組 [i, j] を順に返す。違いが MAX_D を超えたら null */
  function myers(a, b) {
    const n = a.length, m = b.length, maxD = Math.min(MAX_D, n + m), off = maxD + 1;
    const v = new Int32Array(2 * maxD + 3), trace = [];
    v[1 + off] = 0;
    let found = -1;
    for (let d = 0; d <= maxD && found < 0; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[k - 1 + off] < v[k + 1 + off]) ? v[k + 1 + off] : v[k - 1 + off] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[k + off] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    if (found < 0) return null;
    const pairs = []; let x = n, y = m;
    for (let d = found; d > 0; d--) {
      const vv = trace[d], k = x - y;
      const down = k === -d || (k !== d && vv[k - 1 + off] < vv[k + 1 + off]);
      const pk = down ? k + 1 : k - 1, px = vv[pk + off], py = px - pk;
      const mx = down ? px : px + 1, my = down ? py + 1 : py;
      while (x > mx && y > my) { x--; y--; pairs.push([x, y]); }
      x = px; y = py;
    }
    while (x > 0 && y > 0) { x--; y--; pairs.push([x, y]); }
    return pairs.reverse();
  }

  /** 一致する要素の組 [i, j] を、順に返す（先頭・末尾の同じ部分は、先に数える。真ん中は、Myers 法、だめなら表で） */
  function matches(a, b) {
    const n0 = a.length, m0 = b.length; let s = 0;
    while (s < n0 && s < m0 && a[s] === b[s]) s++;
    let ea = n0, eb = m0;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    const out = []; for (let i = 0; i < s; i++) out.push([i, i]);
    const n = ea - s, m = eb - s;
    const my = n > 0 && m > 0 ? myers(a.slice(s, ea), b.slice(s, eb)) : null;
    if (my) my.forEach((p) => out.push([s + p[0], s + p[1]]));
    else if (n > 0 && m > 0 && n * m <= CAP) {
      const w = m + 1, dp = new Int32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * w + j] = a[s + i] === b[s + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[s + i] === b[s + j]) { out.push([s + i, s + j]); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++; else j++;
      }
    }
    for (let k = 0; k < n0 - ea; k++) out.push([ea + k, eb + k]);
    return out;
  }
  /** a を b に変える、変更の一覧。{ a0, a1 }＝a の [a0, a1) を、{ lines }＝b のその部分に置き換える（a0===a1 なら、挿入） */
  function hunks(a, b) {
    const out = []; let pa = 0, pb = 0;
    matches(a, b).concat([[a.length, b.length]]).forEach((p) => {
      if (p[0] > pa || p[1] > pb) out.push({ a0: pa, a1: p[0], lines: b.slice(pb, p[1]) });
      pa = p[0] + 1; pb = p[1] + 1;
    });
    return out;
  }
  /** 3つの列（base・A・T）の合流。{ k:'eq', tokens } と { k:'conflict', base, a, t } の並びを返す */
  function mergeTokens(B, A, T, strict) {   // strict＝同じ位置への挿入を、両方残さず、重なりとして扱う（文の途中で、文字が入り交じらないように）
    const HA = hunks(B, A), HB = hunks(B, T);
    const segs = []; let pos = 0, i = 0, j = 0;
    const eq = (to) => { if (to > pos) segs.push({ k: 'eq', tokens: B.slice(pos, to) }); pos = Math.max(pos, to); };
    const inter = (s, e, h) => {   // 範囲 [s, e)（s===e なら、その位置への挿入）と、h が重なるか。端が接するだけなら、重ならない
      if (s === e && h.a0 === h.a1) return s === h.a0;
      if (s === e) return h.a0 < s && s < h.a1;
      if (h.a0 === h.a1) return s < h.a0 && h.a0 < e;
      return s < h.a1 && h.a0 < e;
    };
    while (i < HA.length || j < HB.length) {
      const ha = HA[i], hb = HB[j];
      const fromA = !hb || (ha && (ha.a0 < hb.a0 || (ha.a0 === hb.a0 && ha.a1 <= hb.a1)));   // 同じ位置から始まるときは、挿入（短いほう）を先に
      const h0 = fromA ? ha : hb;
      let s = h0.a0, e = h0.a1;
      const ca = [], ct = [];
      if (fromA) { ca.push(h0); i++; } else { ct.push(h0); j++; }
      for (let grew = true; grew;) {
        grew = false;
        while (i < HA.length && inter(s, e, HA[i])) { ca.push(HA[i]); s = Math.min(s, HA[i].a0); e = Math.max(e, HA[i].a1); i++; grew = true; }
        while (j < HB.length && inter(s, e, HB[j])) { ct.push(HB[j]); s = Math.min(s, HB[j].a0); e = Math.max(e, HB[j].a1); j++; grew = true; }
      }
      eq(s);
      const apply = (hs) => { let out = [], p = s; hs.forEach((h) => { out = out.concat(B.slice(p, h.a0), h.lines); p = h.a1; }); return out.concat(B.slice(p, e)); };
      if (!ca.length) segs.push({ k: 'eq', tokens: apply(ct) });
      else if (!ct.length) segs.push({ k: 'eq', tokens: apply(ca) });
      else {
        const va = apply(ca), vt = apply(ct);
        if (va.length === vt.length && va.every((x, k) => x === vt[k])) segs.push({ k: 'eq', tokens: va });
        else if (s === e && !strict) segs.push({ k: 'eq', tokens: vt.concat(va) });   // 同じ場所への挿入：両方残す（サーバーの分が先）
        else segs.push({ k: 'conflict', base: B.slice(s, e), a: va, t: vt });
      }
      pos = Math.max(pos, e);
    }
    eq(B.length);
    return segs;
  }

  CE.MARK_A = '⚠【同時に直された所】あなたの版';
  CE.MARK_B = '⚠【同時に直された所】ほかの人の版';
  CE.MARK_END = '⚠【ここまで】どちらかを消してください';
  const lines = (s) => String(s).match(/[^\n]*\n|[^\n]+$/g) || [];
  const nl = (arr) => { const o = arr.slice(); if (o.length && !/\n$/.test(o[o.length - 1])) o[o.length - 1] += '\n'; return o; };

  /** 1行ずつの両方の変更を、文字ごとに合流する。重なったら null */
  function mergeLine(b, a, t) {
    const tail = (x) => (/\n$/.test(x) ? '\n' : '');
    if (tail(b) !== tail(a) || tail(a) !== tail(t)) return null;
    const core = (x) => Array.from(x.slice(0, x.length - tail(x).length));
    const segs = mergeTokens(core(b), core(a), core(t), true);   // 1行の中は、同じ位置への挿入も、重なりとして扱う
    if (segs.some((s) => s.k === 'conflict')) return null;
    return segs.map((s) => s.tokens.join('')).join('') + tail(b);
  }

  /** base（前回の同期の本文）・mine（自分の本文）・theirs（サーバーの本文）→ { text, conflicts（印を付けた数） } */
  CE.merge3 = function (base, mine, theirs) {
    base = String(base || ''); mine = String(mine || ''); theirs = String(theirs || '');
    if (mine === theirs) return { text: mine, conflicts: 0 };
    if (base === mine) return { text: theirs, conflicts: 0 };
    if (base === theirs) return { text: mine, conflicts: 0 };
    let out = '', conflicts = 0;
    mergeTokens(lines(base), lines(mine), lines(theirs)).forEach((s) => {
      if (s.k === 'eq') { out += s.tokens.join(''); return; }
      if (s.base.length === 1 && s.a.length === 1 && s.t.length === 1) {
        const r = mergeLine(s.base[0], s.a[0], s.t[0]);
        if (r !== null) { out += r; return; }
      }
      conflicts++;
      out += CE.MARK_A + '\n' + nl(s.a).join('') + CE.MARK_B + '\n' + nl(s.t).join('') + CE.MARK_END + '\n';
    });
    return { text: out, conflicts };
  };
  /** 印を付けた（まだ直していない）場所の数 */
  CE.countMarks = (text) => String(text || '').split(CE.MARK_A).length - 1;

  /** 古い本文 → 新しい本文の、最小の置き換えの一覧 [{ from, to, insert }]（from の小さい順。古い本文の文字の位置） */
  CE.changes = function (oldText, newText) {
    oldText = String(oldText || ''); newText = String(newText || '');
    if (oldText === newText) return [];
    const a = lines(oldText), b = lines(newText);
    const off = [0]; a.forEach((l) => off.push(off[off.length - 1] + l.length));
    const out = [];
    hunks(a, b).forEach((h) => {
      let from = off[h.a0], to = off[h.a1];
      const oldR = oldText.slice(from, to), newR = h.lines.join('');
      let p = 0; const mx = Math.min(oldR.length, newR.length);
      while (p < mx && oldR[p] === newR[p]) p++;
      let s = 0;
      while (s < mx - p && oldR[oldR.length - 1 - s] === newR[newR.length - 1 - s]) s++;
      from += p; to -= s;
      if (to > from || newR.length - p - s > 0) out.push({ from, to, insert: newR.slice(p, newR.length - s) });
    });
    return out;
  };
  /** 置き換えの一覧を、本文に当てる（テスト用。エディタでは、CodeMirror が同じことをする） */
  CE.applyChanges = function (text, list) {
    let out = '', pos = 0; text = String(text || '');
    list.forEach((c) => { out += text.slice(pos, c.from) + c.insert; pos = c.to; });
    return out + text.slice(pos);
  };

  /** 古い本文 → 新しい本文の、変更の要約（投稿者が、返却の前に確かめる用）。{ added, removed（行数）, total（変更の箇所数）, hunks:[{ del:[行], ins:[行] }]（最大 limit か所） } */
  CE.summary = function (a, b, limit) {
    const A0 = lines(String(a || '')), B0 = lines(String(b || '')), hs = hunks(A0, B0);
    let added = 0, removed = 0;
    hs.forEach((h) => { added += h.lines.length; removed += h.a1 - h.a0; });
    return { added, removed, total: hs.length, hunks: hs.slice(0, limit || 12).map((h) => ({ del: A0.slice(h.a0, h.a1).map((x) => x.replace(/\n$/, '')), ins: h.lines.map((x) => x.replace(/\n$/, '')) })) };
  };

  /** 「いま参加している人」の数。editors＝{ uid: 最後の書き込みの時刻（ms） } */
  CE.activeEditors = function (editors, now) {
    const w = CE.CFG.editorWindowMs; let n = 0;
    Object.keys(editors || {}).forEach((u) => { if (now - Number(editors[u]) <= w) n++; });
    return n;
  };

  /* ---------- 圧縮（本文 → { enc, text }）。CompressionStream が無い環境・短い本文は、そのまま ---------- */
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return root.btoa(s); };
  const unb64 = (s) => { const bin = root.atob(s), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  async function pipe(u8, stream) {
    const w = stream.writable.getWriter(); w.write(u8); w.close();
    const chunks = []; const r = stream.readable.getReader();
    for (;;) { const x = await r.read(); if (x.done) break; chunks.push(x.value); }
    let n = 0; chunks.forEach((c) => { n += c.length; });
    const out = new Uint8Array(n); let p = 0; chunks.forEach((c) => { out.set(c, p); p += c.length; });
    return out;
  }
  CE.pack = async function (text) {
    text = String(text || '');
    if (text.length < 1500 || typeof root.CompressionStream !== 'function' || typeof root.btoa !== 'function') return { enc: 'plain', text };
    try {
      const z = b64(await pipe(new TextEncoder().encode(text), new root.CompressionStream('gzip')));
      return z.length < text.length ? { enc: 'gz', text: z } : { enc: 'plain', text };
    } catch (e) { return { enc: 'plain', text }; }
  };
  CE.unpack = async function (enc, text) {
    if (enc !== 'gz') return String(text || '');
    if (typeof root.DecompressionStream !== 'function' || typeof root.atob !== 'function') throw new Error('この端末は、圧縮された本文を開けません');
    return new TextDecoder().decode(await pipe(unb64(String(text || '')), new root.DecompressionStream('gzip')));
  };
})(typeof window !== 'undefined' ? window : globalThis);
