/* 図の「設計図」→ 図（SVG）。
   AI は設計図（JSON）だけを書く。箱の大きさ・並べ方・線の引き方は、このファイルの規則（自動配置）が決める。
   見た目（色・線・形）は diagram-styles.js の「描画パターン」で、好みに合わせて選べる。同じ設計図を、別のパターンで描き直せる。
   できた SVG には設計図を <desc> に入れておく（あとで描き直す・直すための控え。読み込むときは必ず normalize を通す）。
   設計図の形（JSON）：
     { "type": "flow|cycle|tree|compare|timeline|map|venn", "title": "図の題名",
       "items": [ { "id": "a", "label": "名前", "detail": "補足", "when": "時期(年表)", "parent": "親のid(階層図)", "group": "色分けの名前",
                    "kind": "start|end|decision(流れ図の形)", "highlight": true(いちばん大事な項目) } ],
       "links": [ { "from": "a", "to": "b", "label": "線の説明" } ],
       "columns": ["比較する対象", ...], "rows": [ { "label": "観点", "cells": ["...", ...] } ],   ← 比較表だけ
       "center": "3 つすべてに共通すること" }   ← ベン図だけ（2 つの共通点は links の label） */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const TYPES = [
    ['flow', 'フローチャート（手順・流れ）'], ['cycle', '循環図（サイクル）'], ['tree', '階層・分類図（ツリー）'],
    ['compare', '比較表・対比'], ['timeline', '年表・時系列'], ['map', '関係図・概念マップ'], ['venn', 'ベン図（共通点と違い）'],
  ];
  const MARK = 'LN-DIAGRAM/1 ';
  const MAXN = { flow: 20, map: 20, cycle: 10, tree: 30, timeline: 14, venn: 3 }, MAXCOL = 6, MAXROW = 12;

  /* 構造化出力（「この形でしか答えない」指定）に渡す形。Ollama の format にそのまま使える */
  const str = { type: 'string' }, bool = { type: 'boolean' };
  const SCHEMA = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: TYPES.map((t) => t[0]) },
      title: str,
      items: { type: 'array', items: { type: 'object', properties: { id: str, label: str, detail: str, when: str, parent: str, group: str, kind: { type: 'string', enum: ['process', 'start', 'end', 'decision'] }, highlight: bool }, required: ['id', 'label'] } },
      links: { type: 'array', items: { type: 'object', properties: { from: str, to: str, label: str }, required: ['from', 'to'] } },
      center: str,
      columns: { type: 'array', items: str },
      rows: { type: 'array', items: { type: 'object', properties: { label: str, cells: { type: 'array', items: str } }, required: ['label', 'cells'] } },
    },
    required: ['type', 'title'],
  };

  /* ================= 文字の幅（SVG には自動の折り返しが無いので、自分で測る） ================= */
  const NARROW = new Set('iljtfI.,:;\'|!()[]{} -/\\`'.split('')), WIDE = new Set('mwMW@%'.split(''));
  const NO_START = new Set('、。，．）」』】〕〉》！？ー〜…ぁぃぅぇぉっゃゅょァィゥェォッャュョヵヶ・：；,.)]}!?:;%'.split(''));
  const NO_END = new Set('（「『【〔〈《([{'.split(''));

  function cw(ch) { // 1 文字の幅（文字の大きさ 1 に対する割合）
    const c = ch.codePointAt(0);
    if (c < 0x80) {
      if (NARROW.has(ch)) return 0.34;
      if (WIDE.has(ch)) return 0.9;
      if (c >= 65 && c <= 90) return 0.68;
      if (c >= 48 && c <= 57) return 0.58;
      return 0.56;
    }
    if (c >= 0xff61 && c <= 0xff9f) return 0.5;
    if (c < 0x2000) return 0.62;
    return 1;
  }
  function tw(s, fs) { let w = 0; for (const ch of s) w += cw(ch); return w * fs * 1.04; }

  let SEG;
  const segmenter = () => { if (SEG === undefined) { try { SEG = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('ja', { granularity: 'word' }) : null; } catch (e) { SEG = null; } } return SEG; };
  /** 折り返しの最小単位。日本語は単語（Intl.Segmenter。使えない環境ではカタカナの連なり／1 文字）、英単語は 1 つ。行頭・行末に置けない記号は隣とくっつける */
  function units(s) {
    let out = [];
    const sg = segmenter();
    if (sg) out = Array.from(sg.segment(s), (x) => (x.segment.trim() === '' ? ' ' : x.segment));
    else {
      const chars = Array.from(s);
      for (let i = 0; i < chars.length;) {
        const ch = chars[i], c = ch.codePointAt(0);
        if (ch === ' ') { out.push(' '); i++; continue; }
        if (c < 0x80) { let j = i; while (j < chars.length && chars[j] !== ' ' && chars[j].codePointAt(0) < 0x80) j++; out.push(chars.slice(i, j).join('')); i = j; continue; }
        if (c >= 0x30a0 && c <= 0x30ff) { let j = i; while (j < chars.length && chars[j].codePointAt(0) >= 0x30a0 && chars[j].codePointAt(0) <= 0x30ff) j++; out.push(chars.slice(i, j).join('')); i = j; continue; }
        out.push(ch); i++;
      }
    }
    const glued = [];
    for (const u of out) {
      const last = glued.length ? glued[glued.length - 1] : null;
      if (last && last !== ' ' && u !== ' ' && (NO_START.has(Array.from(u)[0]) || NO_END.has(Array.from(last).pop()))) glued[glued.length - 1] = last + u;
      else glued.push(u);
    }
    return glued;
  }
  function pack(us, maxW, fs) {
    const lines = []; let cur = '', curW = 0;
    const flush = () => { if (cur.trim()) lines.push(cur.trim()); cur = ''; curW = 0; };
    for (const u of us) {
      if (u === ' ') { if (cur) { cur += ' '; curW += tw(' ', fs); } continue; }
      const w = tw(u, fs);
      if (cur && curW + w > maxW) flush();
      if (w > maxW && !cur) { // 1 単位が行より長い（長い英単語）：文字で切る
        for (const ch of Array.from(u)) { const cwid = tw(ch, fs); if (cur && curW + cwid > maxW) flush(); cur += ch; curW += cwid; }
        continue;
      }
      cur += u; curW += w;
    }
    flush();
    return lines;
  }
  /** 折り返す。行の長さがなるべくそろうように（最後の行だけ極端に短くならないように）整える */
  function wrap(text, maxW, fs) {
    const out = [];
    for (const para of String(text).split('\n')) {
      const us = units(para);
      let lines = pack(us, maxW, fs);
      const n = lines.length;
      const widest = Math.max(0, ...us.map((u) => tw(u, fs)));
      if (n > 1 && widest <= maxW) { // 単語は切らずに、行の長さをそろえる
        let lo = Math.max(widest, (lines.reduce((s, l) => s + tw(l, fs), 0) / n) * 0.98), hi = maxW;
        for (let k = 0; k < 10 && hi - lo > 1; k++) { const mid = (lo + hi) / 2; if (pack(us, mid, fs).length > n) lo = mid; else hi = mid; }
        const bal = pack(us, hi, fs);
        if (bal.length === n) lines = bal;
      }
      out.push(...(lines.length ? lines : ['']));
    }
    return out;
  }

  /* ================= 設計図の検査と整え直し ================= */
  function clean(v, max) {
    if (typeof v === 'number' && isFinite(v)) v = String(v);
    if (typeof v !== 'string') return '';
    const chars = [];
    for (const ch of v) {
      const c = ch.charCodeAt(0);
      if (ch.length === 1 && c >= 0xd800 && c <= 0xdfff) continue; // 対にならないサロゲート
      if ((c < 32 && c !== 10 && c !== 9) || c === 0xfffe || c === 0xffff) continue; // XML で使えない制御文字
      chars.push(c === 9 ? ' ' : ch);
    }
    let s = chars.join('').replace(/[ 　]*\n[ 　]*/g, '\n').replace(/\n{2,}/g, '\n').replace(/[ 　]{2,}/g, ' ').trim();
    const a = Array.from(s);
    if (a.length > max) s = a.slice(0, max - 1).join('') + '…';
    return s;
  }
  const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

  function canonType(v) {
    const s = String(v == null ? '' : v).toLowerCase();
    if (!s) return null;
    const rules = [['venn', /venn|ベン|集合図/], ['cycle', /cycle|circular|loop|循環|サイクル/], ['timeline', /timeline|chrono|年表|時系列|タイムライン/], ['compare', /compar|table|matrix|比較|対比|表/],
      ['tree', /tree|hierarch|org|taxonom|階層|ツリー|分類|系統/], ['map', /map|concept|network|relation|graph|関係|概念|マップ|相関/], ['flow', /flow|process|step|procedure|フロー|流れ|手順|工程|過程/]];
    for (const [t, re] of rules) if (re.test(s)) return t;
    return null;
  }

  /** 流れ図の箱の形（開始・終了＝丸、判断＝ひし形）。分からなければ空 */
  function canonKind(v) {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    if (!t) return '';
    if (/^(decision|branch|condition|cond|judge|if|diamond)$/.test(t) || /判断|条件|分岐/.test(t)) return 'decision';
    if (/^(start|begin|first)$/.test(t) || /開始|スタート/.test(t)) return 'start';
    if (/^(end|finish|goal|stop|last)$/.test(t) || /終了|終わり|ゴール|完了/.test(t)) return 'end';
    return '';
  }
  const isTrue = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|1|はい|強調|重要)$/i.test(v.trim()));

  function normalize(raw) {
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { return { ok: false, error: '設計図（JSON）として読めませんでした' }; } }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '設計図の形ではありません' };
    const warnings = [];
    const rawItems = pick(raw, ['items', 'nodes', 'steps', 'events', 'entries']);
    let items = [];
    const ids = new Set();
    (Array.isArray(rawItems) ? rawItems : []).forEach((r) => {
      const o = typeof r === 'string' || typeof r === 'number' ? { label: r } : r && typeof r === 'object' ? r : null;
      if (!o) return;
      const label = clean(pick(o, ['label', 'text', 'name', 'title', 'term']), 60);
      if (!label) return;
      let id = clean(pick(o, ['id', 'key']), 30);
      if (!id || ids.has(id)) { let k = items.length + 1; while (ids.has('n' + k)) k++; id = 'n' + k; }
      ids.add(id);
      items.push({
        id, label, detail: clean(pick(o, ['detail', 'description', 'desc', 'note', 'explanation']), 140), when: clean(pick(o, ['when', 'date', 'year', 'time', 'period']), 24),
        parent: clean(pick(o, ['parent', 'parentId', 'parent_id']), 30), group: clean(o.group !== undefined ? o.group : o.category, 14),
        kind: canonKind(pick(o, ['kind', 'shape', 'role', 'nodeType', 'node_type'])), highlight: isTrue(pick(o, ['highlight', 'emphasis', 'important', 'focus', 'hl'])),
      });
    });
    const byId = new Map(items.map((it) => [it.id, it]));
    const byLabel = new Map(); items.forEach((it) => { if (!byLabel.has(it.label)) byLabel.set(it.label, it); });
    const ref = (v) => { const s = clean(v, 60); if (!s) return null; if (byId.has(s)) return byId.get(s); return byLabel.get(s) || null; };

    let links = [];
    const rawLinks = pick(raw, ['links', 'edges', 'connections', 'relations', 'arrows']);
    (Array.isArray(rawLinks) ? rawLinks : []).forEach((r) => {
      const o = Array.isArray(r) ? { from: r[0], to: r[1], label: r[2] } : r && typeof r === 'object' ? r : null;
      if (!o) return;
      const a = ref(pick(o, ['from', 'source', 'src', 'a', 'start'])), b = ref(pick(o, ['to', 'target', 'dst', 'b', 'end']));
      if (!a || !b || a === b) { warnings.push('つなぎ先が見つからない線を1本省きました'); return; }
      if (links.some((l) => l.from === a.id && l.to === b.id)) return;
      links.push({ from: a.id, to: b.id, label: clean(pick(o, ['label', 'text', 'relation', 'name']), 24) });
    });

    let columns = [], rows = [];
    const rawCols = pick(raw, ['columns', 'headers', 'cols']), rawRows = pick(raw, ['rows', 'lines']);
    if (Array.isArray(rawCols)) columns = rawCols.map((c) => clean(typeof c === 'object' && c ? pick(c, ['label', 'name', 'text', 'title']) : c, 30)).filter(Boolean).slice(0, MAXCOL);
    if (Array.isArray(rawRows)) {
      rawRows.forEach((r) => {
        let label, cells;
        if (Array.isArray(r)) { label = r[0]; cells = r.slice(1); }
        else if (r && typeof r === 'object') { label = pick(r, ['label', 'name', 'title', 'item']); cells = pick(r, ['cells', 'values', 'columns', 'data']); }
        else return;
        if (!Array.isArray(cells)) cells = [];
        rows.push({ label: clean(label, 40), cells: cells.map((c) => clean(c, 120)) });
      });
      rows = rows.filter((r) => r.label || r.cells.some(Boolean)).slice(0, MAXROW);
    }

    let type = canonType(pick(raw, ['type', 'kind', 'diagram', 'diagramType']));
    if (!type) {
      if (columns.length && rows.length) type = 'compare';
      else if (items.filter((i) => i.when).length * 2 >= items.length && items.some((i) => i.when)) type = 'timeline';
      else if (items.some((i) => i.parent)) type = 'tree';
      else type = 'flow';
      warnings.push('図の種類が指定されていなかったため、内容から「' + TYPES.find((t) => t[0] === type)[1] + '」と判断しました');
    }
    const title = clean(pick(raw, ['title', 'name', 'heading']), 50);
    const center = type === 'venn' ? clean(pick(raw, ['center', 'centre', 'common', 'intersection']), 24) : '';

    if (type === 'compare') {
      if (!columns.length && items.length) { // 項目だけが来たときは、項目を比べる対象として並べる
        columns = items.map((i) => i.label).slice(0, MAXCOL);
        if (items.some((i) => i.detail)) rows = [{ label: '説明', cells: items.slice(0, MAXCOL).map((i) => i.detail) }];
      }
      if (!columns.length && rows.length) { const n = Math.min(MAXCOL, Math.max(...rows.map((r) => r.cells.length))); columns = Array.from({ length: n }, (_, i) => '項目' + (i + 1)); }
      if (!columns.length || !rows.length) return { ok: false, error: '比較表に必要な「比べる対象」と「観点」が足りません' };
      rows = rows.map((r) => ({ label: r.label, cells: columns.map((_, i) => r.cells[i] || '') }));
      return { ok: true, bp: { type, title, items: [], links: [], columns, rows, center: '' }, warnings };
    }

    if (type === 'venn') { // ベン図：集合は 2〜3 つ。2 つの集合の共通点は、links の label
      if (items.length > 3) { warnings.push('集合が多すぎるため、先頭の 3 つだけにしました'); items = items.slice(0, 3); }
      if (items.length < 2) return { ok: false, error: '集合が足りません（2 つ以上必要です）' };
      const keepV = new Set(items.map((i) => i.id)), seen = new Set(), pairs = [];
      links.forEach((l) => {
        if (!keepV.has(l.from) || !keepV.has(l.to)) return;
        const key = [l.from, l.to].sort().join('|');
        if (seen.has(key)) return;
        seen.add(key); pairs.push({ from: l.from, to: l.to, label: l.label });
      });
      items.forEach((it) => { it.kind = ''; it.parent = ''; it.when = ''; });
      return { ok: true, bp: { type, title, items, links: pairs, columns: [], rows: [], center }, warnings };
    }

    const max = MAXN[type];
    if (items.length > max) { warnings.push('項目が多すぎるため、先頭の ' + max + ' 個だけにしました'); items = items.slice(0, max); }
    const keep = new Set(items.map((i) => i.id));
    links = links.filter((l) => keep.has(l.from) && keep.has(l.to));
    if (items.length < 2) return { ok: false, error: '項目が足りません（2 つ以上必要です）' };

    if (type === 'cycle') { // 順につないで 1 周させる。線の説明は、元の線から拾う
      const out = [];
      items.forEach((it, i) => { const nx = items[(i + 1) % items.length]; const l = links.find((x) => x.from === it.id && x.to === nx.id); out.push({ from: it.id, to: nx.id, label: l ? l.label : '' }); });
      links = out;
    } else if (type === 'tree') {
      const par = new Map();
      items.forEach((it) => { const p = it.parent ? ref(it.parent) : null; if (p && p.id !== it.id) par.set(it.id, p.id); });
      links.forEach((l) => { if (!par.has(l.to)) par.set(l.to, l.from); });
      items.forEach((it) => { // 親をたどって輪になっていたら、そこで切る
        const seen = new Set([it.id]); let p = par.get(it.id);
        while (p) { if (seen.has(p)) { par.delete(it.id); warnings.push('親子の輪を1か所切りました'); break; } seen.add(p); p = par.get(p); }
      });
      if (!par.size) { warnings.push('親子の関係が無かったため、先頭の項目を一番上にしました'); items.slice(1).forEach((it) => par.set(it.id, items[0].id)); }
      items.forEach((it) => { it.parent = par.get(it.id) || ''; });
      links = [];
    } else if (!links.length) { // 線が無ければ順につなぐ
      links = items.slice(1).map((it, i) => ({ from: items[i].id, to: it.id, label: '' }));
    }
    // 流れ図の形：付いていなければ、言葉から推し量る（「はい／いいえ」で分かれる箱＝判断、「開始」「終了」＝丸）
    if (type === 'flow') {
      const outs = new Map(), ins = new Map();
      links.forEach((l) => { outs.set(l.from, (outs.get(l.from) || []).concat([l])); ins.set(l.to, (ins.get(l.to) || 0) + 1); });
      const YN = /^(はい|いいえ|yes|no|y|n|真|偽|成功|失敗|ok|ng|〇|○|×|可|不可|true|false)$/i;
      items.forEach((it) => {
        if (it.kind) return;
        const o = outs.get(it.id) || [], lab = it.label.trim();
        if (o.length >= 2 && o.filter((l) => YN.test(l.label.trim())).length >= 2) it.kind = 'decision';
        else if (!ins.get(it.id) && /^(開始|スタート|start|begin)$/i.test(lab)) it.kind = 'start';
        else if (!o.length && /^(終了|終わり|ゴール|完了|end|finish|goal)$/i.test(lab)) it.kind = 'end';
      });
    } else items.forEach((it) => { it.kind = ''; });
    return { ok: true, bp: { type, title, items, links, columns: [], rows: [], center: '' }, warnings };
  }

  /** 文字列の中の最初の { ... }（対応する閉じ括弧まで。文字列の中の括弧は数えない）。閉じていなければ末尾まで */
  function firstObject(s) {
    const a = s.indexOf('{');
    if (a < 0) return '';
    let depth = 0, inStr = false;
    for (let i = a; i < s.length; i++) {
      const c = s[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return s.slice(a, i + 1);
    }
    return s.slice(a);
  }
  /** AI の返事（前置き・コードフェンス・末尾のカンマつきでもよい）から設計図を取り出す */
  function parse(text) {
    const s = String(text || '');
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    const obj = firstObject(fence ? fence[1] : s) || firstObject(s);
    if (!obj) return { ok: false, error: '設計図（JSON）が見つかりませんでした' };
    let r = normalize(obj);
    if (!r.ok && /読めません/.test(r.error)) r = normalize(obj.replace(/,\s*([}\]])/g, '$1').replace(/^\uFEFF/, ''));
    return r;
  }

  /* ================= AI への指示文（設計図を書かせる） ================= */
  const RULES = {
    flow: '手順・流れ。items を順に書き、links で矢印をつなぐ。分岐は、1 つの item から複数の links を出す（label に「はい」「いいえ」など）。はい・いいえで分かれる item には "kind": "decision"、最初と最後の item には "kind": "start" / "end" を付けてよい（付けなくてもよい）。',
    cycle: '循環。items を循環の順に書く（links は不要。説明を付けたい矢印だけ links に書く）。最後から最初への矢印は、自動でつなぐ。',
    tree: '階層・分類。各 item に "parent"（親の id）を書く。一番上の item には parent を書かない。links は書かない。',
    compare: '比較表。items と links は使わず、"columns"（比べる対象の名前）と "rows"（観点ごとに { "label": "観点", "cells": ["対象1の内容", "対象2の内容"] }）を書く。cells の数は columns と同じにする。',
    timeline: '年表。items を時間の順に書き、各 item に "when"（年・時期）を書く。links は不要。',
    map: '関係図・概念マップ。items（概念）と、関係を表す links を書く。links の label に、関係（「〜を生む」「〜の一部」など）を書く。中心になる概念があれば、それとほかの概念を links でつなぐ。',
    venn: 'ベン図。items に集合を 2〜3 個書く（label と、特徴を書いた detail）。2 つの集合の共通点は、links に { "from": "a", "to": "b", "label": "共通点" } と書く。3 つすべてに共通することは、一番外側に "center" として書く。',
  };
  const EXAMPLES = {
    flow: '{"type":"flow","title":"光合成の流れ","items":[{"id":"a","label":"光の吸収","detail":"葉緑体で行う"},{"id":"b","label":"水の分解","highlight":true},{"id":"c","label":"糖の合成"}],"links":[{"from":"a","to":"b"},{"from":"b","to":"c","label":"ATP"}]}',
    cycle: '{"type":"cycle","title":"水の循環","items":[{"id":"a","label":"蒸発"},{"id":"b","label":"雲の形成"},{"id":"c","label":"降水"},{"id":"d","label":"川・地下水"}]}',
    tree: '{"type":"tree","title":"生物の分類","items":[{"id":"a","label":"生物"},{"id":"b","label":"動物","parent":"a"},{"id":"c","label":"植物","parent":"a"},{"id":"d","label":"脊椎動物","parent":"b"}]}',
    compare: '{"type":"compare","title":"原核細胞と真核細胞","columns":["原核細胞","真核細胞"],"rows":[{"label":"核膜","cells":["なし","あり"]},{"label":"例","cells":["大腸菌","動物・植物"]}]}',
    timeline: '{"type":"timeline","title":"明治維新","items":[{"id":"a","when":"1853年","label":"ペリー来航"},{"id":"b","when":"1868年","label":"戊辰戦争"}]}',
    map: '{"type":"map","title":"需要と供給","items":[{"id":"a","label":"価格"},{"id":"b","label":"需要量"}],"links":[{"from":"a","to":"b","label":"上がると減る"}]}',
    venn: '{"type":"venn","title":"哺乳類と鳥類","items":[{"id":"a","label":"哺乳類","detail":"毛・胎生"},{"id":"b","label":"鳥類","detail":"羽・卵生"}],"links":[{"from":"a","to":"b","label":"恒温・脊椎"}]}',
  };
  /** 設計図を書かせる指示（system）。図の種類を決めたときは、その種類の説明と例だけを渡す（短いほど、小さな AI でも速く確実） */
  function systemPrompt(type) {
    const one = RULES[type] ? type : null;
    return [
      'あなたは、大学の学習用の図の「設計図」を作る役です。図そのものは描きません。アプリが、あなたの設計図から図を自動で描きます。',
      '出力は JSON だけです。説明・前置き・コードフェンスは付けません。',
      '【設計図の形】{ "type": 図の種類, "title": 題名（20 字以内）, "items": [ { "id": "a", "label": "名前（20 字以内）", "detail": "補足（40 字以内。無くてよい）" } ], "links": [ { "from": "a", "to": "b", "label": "矢印の説明（8 字以内。無くてよい）" } ] }',
      one ? '【図の種類】type は "' + one + '"。' + RULES[one]
        : '【図の種類】type には、内容に最も合うものを 1 つ選んで書く。\n' + TYPES.map((t) => '- ' + t[0] + '：' + RULES[t[0]]).join('\n'),
      '【守ること】',
      '- 依頼と参考文章の内容だけを使う。文章に無い事実は足さない。',
      '- 項目は 4〜10 個を目安に、短い言葉でまとめる。長い文は使わない。',
      '- id は半角英数字（a, b, c …）で、重ならないようにする。links の from / to は、必ず items の id にする。',
      '- 色分けしたいグループがあるときだけ、item に "group"（8 字以内）を書く。',
      one === 'compare' || one === 'venn' ? '' : '- 一番大切な項目には "highlight": true を付ける（1〜2 個まで。付けなくてもよい）。',
      '【例】' + EXAMPLES[one || 'flow'],
    ].filter(Boolean).join('\n');
  }
  /** 依頼文（user）。context は参考にする文章（長いときは先頭だけ） */
  function userPrompt(o) {
    const ctx = o.context ? String(o.context).slice(0, 5000) : '';
    const kind = TYPES.find((t) => t[0] === o.type);
    return (ctx ? '【参考にする文章】\n' + ctx + '\n\n' : '') + '【図の依頼】\n' + String(o.request || '').trim() + (kind ? '\n図の種類：' + kind[0] + '（' + kind[1] + '）' : '');
  }
  /** 修正の依頼（直前の設計図に続けて送る） */
  const refinePrompt = (ins) => '次の修正を反映して、設計図（JSON）全体を出力し直してください。\n' + String(ins || '').trim();
  /** 設計図を、AI に見せる・利用者に見せる短い JSON の文字にする */
  const toJSON = (bp, pretty) => JSON.stringify(compact(bp), null, pretty ? 2 : 0);

  /** 項目の id を a, b, c … に振り直す（学習データと、AI が書く設計図の形をそろえる）。元の設計図は変えない */
  function canon(bp) {
    const map = new Map(bp.items.map((it, i) => [it.id, i < 26 ? String.fromCharCode(97 + i) : 'a' + (i - 25)]));
    return Object.assign({}, bp, {
      items: bp.items.map((it) => Object.assign({}, it, { id: map.get(it.id), parent: it.parent ? map.get(it.parent) || '' : '' })),
      links: bp.links.map((l) => Object.assign({}, l, { from: map.get(l.from), to: map.get(l.to) })),
    });
  }
  /** 学習（ファインチューニング）した小さな AI に渡す、短い指示。学習データと、まったく同じ形にする（ずれると、学習の効果が落ちる） */
  const TUNED_SYSTEM = 'ノートの文章を、図の設計図（JSON）にします。文章に書かれていることだけを使い、項目は短い言葉にします。';
  function tunedPrompt(o) {
    const kind = TYPES.find((t) => t[0] === o.type);
    const ctx = o.context ? String(o.context).slice(0, 3000) : '';
    return { system: TUNED_SYSTEM, user: '【図の種類】' + (kind ? kind[0] : 'おまかせ') + '\n【依頼】' + (String(o.request || '').trim() || '図にして') + '\n【文章】\n' + ctx };
  }

  /* ================= 配置 ================= */
  const MARGIN = 22;

  function measureNode(it, m, maxW, shape) {
    if (shape === 'diamond') maxW = Math.min(maxW, 120); else if (shape === 'ellipse') maxW = Math.min(maxW, 170);
    const inner = maxW - 2 * m.pad;
    const L = wrapB(it.label, inner, m.fs), D = it.detail ? wrap(it.detail, inner, m.fsDetail) : [];
    const lh = Math.round(m.fs * 1.4), ldh = Math.round(m.fsDetail * 1.4);
    let w = Math.max(0, ...L.map((s) => tw(s, m.fs) * 1.07), ...D.map((s) => tw(s, m.fsDetail))) + 2 * m.pad;
    let h = 2 * m.padY + L.length * lh + (D.length ? 5 + D.length * ldh : 0);
    if (shape === 'ellipse') { w = w * 1.38 + 6; h = h * 1.36 + 4; }
    else if (shape === 'diamond') { w = w * 1.9; h = h * 1.85; } // ひし形は、文字の四角の 2 倍ほど要る
    else if (shape === 'hex') w += h * 0.55;
    else if (shape === 'pill') w += h * 0.5;
    return { L, D, lh, ldh, w: Math.ceil(Math.max(m.minW, w)), h: Math.ceil(Math.max(m.minH, h)) };
  }
  const wrapB = (text, w, fs) => wrap(text, w / 1.07, fs); // 太字は約 7% 広い
  const groupsOf = (bp) => { const g = []; bp.items.forEach((it) => { if (it.group && !g.includes(it.group)) g.push(it.group); }); return g; };

  /** 箱（と中の文字）を出力に積む。nd は中心座標 x,y を持つ */
  function emitNode(out, nd, m) {
    out.shapes.push({ k: 'rect', role: 'node', shape: nd.shape || 'rect', x: nd.x - nd.w / 2, y: nd.y - nd.h / 2, w: nd.w, h: nd.h, c: nd.c, lvl: nd.lvl || 0, g: nd.g, root: nd.root, hl: nd.hl });
    const th = nd.L.length * nd.lh + (nd.D.length ? 5 + nd.D.length * nd.ldh : 0);
    const top = nd.y - th / 2;
    const base = { k: 'text', own: 'node', x: nd.x, a: 'middle', c: nd.c, lvl: nd.lvl || 0, g: nd.g, root: nd.root, hl: nd.hl };
    out.texts.push(Object.assign({}, base, { y: top, lines: nd.L, fs: m.fs, lh: nd.lh, b: true }));
    if (nd.D.length) out.texts.push(Object.assign({}, base, { y: top + nd.L.length * nd.lh + 5, lines: nd.D, fs: m.fsDetail, lh: nd.ldh, b: false, detail: true }));
  }
  const newOut = () => ({ edges: [], shapes: [], texts: [], tops: [] });

  /** 番号の丸の位置：図形の左上の縁（図形ごとに、縁の位置が違う） */
  function badgePos(nd) {
    const x = nd.x, y = nd.y, w = nd.w, h = nd.h;
    switch (nd.shape) {
      case 'ellipse': return [x - (w / 2) * 0.707, y - (h / 2) * 0.707];
      case 'diamond': return [x - w / 4, y - h / 4];
      case 'pill': return [x - w / 2 + h / 2 - (h / 2) * 0.707, y - (h / 2) * 0.707];
      case 'hex': return [x - w / 2 + LN.diagramStyles.hexCut(w, h), y - h / 2];
      default: return [x - w / 2 + 2, y - h / 2 + 2];
    }
  }
  function badgePrims(out, nd, i) {
    const b = badgePos(nd);
    out.tops.push({ k: 'circle', role: 'badge', cx: b[0], cy: b[1], r: 11, c: nd.c, lvl: 0, g: nd.g });
    out.tops.push({ k: 'text', own: 'badge', x: b[0], y: b[1] - 8, a: 'middle', lines: [String(i + 1)], fs: 12, lh: 16, b: true, c: nd.c, lvl: 0, g: nd.g });
  }
  /** 図形の中の点か（線の出入りと、放射状の配置で使う） */
  function insideShape(nd, px, py) {
    const dx = Math.abs(px - nd.x), dy = Math.abs(py - nd.y), hw = nd.w / 2, hh = nd.h / 2;
    switch (nd.shape) {
      case 'ellipse': return (dx / hw) * (dx / hw) + (dy / hh) * (dy / hh) <= 1;
      case 'diamond': return dx / hw + dy / hh <= 1;
      case 'hex': return dy <= hh && dx <= hw - LN.diagramStyles.hexCut(nd.w, nd.h) * (dy / hh);
      case 'pill': return dx <= hw - hh ? dy <= hh : (dx - (hw - hh)) * (dx - (hw - hh)) + dy * dy <= hh * hh;
      default: return dx <= hw && dy <= hh;
    }
  }
  /** 中心から向き (ux, uy) へ進んで、図形の縁に出るまでの距離 */
  function rayExit(nd, ux, uy) {
    let lo = 0, hi = Math.hypot(nd.w, nd.h);
    for (let k = 0; k < 24; k++) { const mid = (lo + hi) / 2; if (insideShape(nd, nd.x + ux * mid, nd.y + uy * mid)) lo = mid; else hi = mid; }
    return lo;
  }

  /** 矢じり（先端 tip、進む向き d の単位ベクトル） */
  function arrowHead(tip, d, size) {
    const s = size || 10, hw = s * 0.55;
    const bx = tip[0] - d[0] * s, by = tip[1] - d[1] * s;
    return { k: 'arrow', role: 'edge', pts: [tip[0], tip[1], bx - d[1] * hw, by + d[0] * hw, bx + d[1] * hw, by - d[0] * hw] };
  }
  const f1 = (v) => Math.round(v * 10) / 10;

  function edgeLabel(out, cx, cy, text, m) {
    const fs = 12.5, w = tw(text, fs) + 12, h = 20;
    out.tops.push({ k: 'rect', role: 'elabel', shape: 'rect', x: cx - w / 2, y: cy - h / 2, w, h, rx: 4, c: 0, lvl: 0, g: -1 });
    out.tops.push({ k: 'text', own: 'elabel', x: cx, y: cy - h / 2, a: 'middle', lines: [text], fs, lh: h, b: false, c: 0, lvl: 0, g: -1 });
    return { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
  }

  /* ---------- 流れ図・関係図：層に分けて並べる ---------- */
  function layered(nodes, edges, TB, m) {
    const n = nodes.length;
    const mainOf = (nd) => (TB ? nd.h : nd.w), crossOf = (nd) => (TB ? nd.w : nd.h);
    // 閉路をなくす（逆向きの線は、層を決めるときだけ向きを反転）
    const outs = nodes.map(() => []);
    edges.forEach((e, i) => outs[e.a].push(i));
    const st = new Array(n).fill(0), rev = new Set();
    const dfs = (u) => { st[u] = 1; for (const ei of outs[u]) { const v = edges[ei].b; if (st[v] === 1) rev.add(ei); else if (!st[v]) dfs(v); } st[u] = 2; };
    for (let i = 0; i < n; i++) if (!st[i]) dfs(i);
    const dag = edges.map((e, i) => (rev.has(i) ? { u: e.b, v: e.a, i } : { u: e.a, v: e.b, i }));
    const layer = new Array(n).fill(0);
    for (let k = 0; k < n + 1; k++) { let ch = false; for (const d of dag) if (layer[d.v] < layer[d.u] + 1) { layer[d.v] = layer[d.u] + 1; ch = true; } if (!ch) break; }
    // 入ってくる線が無い箱は、行き先の直前まで寄せる（長い線を減らす）
    for (let i = 0; i < n; i++) {
      if (dag.some((d) => d.v === i)) continue;
      const succ = dag.filter((d) => d.u === i).map((d) => layer[d.v]);
      if (succ.length) layer[i] = Math.max(layer[i], Math.min(...succ) - 1);
    }
    // 頂点（箱＋途中の目印）
    const V = nodes.map((nd, i) => ({ real: true, i, layer: layer[i], m: mainOf(nd), c: crossOf(nd) }));
    const up = [], down = [];
    const link = (a, b) => { (down[a] = down[a] || []).push(b); (up[b] = up[b] || []).push(a); };
    const chains = dag.map((d) => {
      const ch = [d.u];
      for (let l = layer[d.u] + 1; l < layer[d.v]; l++) { V.push({ real: false, layer: l, m: 2, c: 14 }); ch.push(V.length - 1); }
      ch.push(d.v);
      for (let k = 0; k + 1 < ch.length; k++) link(ch[k], ch[k + 1]);
      return ch;
    });
    const Ln = Math.max(...V.map((v) => v.layer)) + 1;
    const lay = Array.from({ length: Ln }, () => []);
    V.forEach((v, idx) => lay[v.layer].push(idx));
    // 線の交差を減らす並べ替え（上下に往復）
    const posOf = () => { const p = []; lay.forEach((a) => a.forEach((v, k) => { p[v] = k; })); return p; };
    for (let it = 0; it < 8; it++) {
      const goDown = it % 2 === 0, pos = posOf();
      for (let s = 0; s < Ln; s++) {
        const l = goDown ? s : Ln - 1 - s, nb = goDown ? up : down;
        if (goDown ? l === 0 : l === Ln - 1) continue;
        const key = new Map();
        lay[l].forEach((v, k) => { const a = nb[v]; key.set(v, a && a.length ? a.reduce((t, x) => t + pos[x], 0) / a.length : k); });
        lay[l].sort((a, b) => key.get(a) - key.get(b) || pos[a] - pos[b]);
        lay[l].forEach((v, k) => { pos[v] = k; });
      }
    }
    // 層ごとの位置（主軸）：ラベルのある線が通る隙間は広げる
    const labelGap = new Array(Ln).fill(0);
    chains.forEach((ch, di) => {
      const e = edges[dag[di].i];
      if (!e.label) return;
      const j = Math.floor((ch.length - 1) / 2), l = V[ch[j]].layer;
      labelGap[l] = Math.max(labelGap[l], TB ? 26 : tw(e.label, 12.5) + 26);
    });
    const gapBase = TB ? 46 : 56;
    const lsz = lay.map((a) => Math.max(0, ...a.map((v) => V[v].m)));
    let cursor = 0;
    const gapCenter = [];
    const mainC = lsz.map((s, l) => { const c = cursor + s / 2; gapCenter[l] = cursor + s + (gapBase + (labelGap[l] || 0)) / 2; cursor += s + gapBase + (labelGap[l] || 0); return c; });
    // 横（交差軸）の位置：隣の層の線の向きにそろえつつ、重ならないように
    const maxLab = Math.max(0, ...edges.map((e) => (e.label ? tw(e.label, 12.5) + 12 : 0)));
    const gapC = TB ? Math.min(150, Math.max(34, maxLab * 0.8)) : 26, sep = (a, b) => (V[a].c + V[b].c) / 2 + (V[a].real && V[b].real ? gapC : 12);
    const X = new Array(V.length).fill(0);
    lay.forEach((a) => { let x = 0; a.forEach((v, k) => { if (k) x += sep(a[k - 1], v); X[v] = x; }); const mid = (X[a[0]] + X[a[a.length - 1]]) / 2; a.forEach((v) => { X[v] -= mid; }); });
    for (let it = 0; it < 10; it++) {
      const goDown = it % 2 === 0;
      for (let s = 0; s < Ln; s++) {
        const l = goDown ? s : Ln - 1 - s, nb = goDown ? up : down, a = lay[l];
        const want = a.map((v) => { const q = nb[v]; return q && q.length ? q.reduce((t, x) => t + X[x], 0) / q.length : X[v]; });
        const L = want.slice(), R = want.slice();
        for (let k = 1; k < a.length; k++) L[k] = Math.max(L[k], L[k - 1] + sep(a[k - 1], a[k]));
        for (let k = a.length - 2; k >= 0; k--) R[k] = Math.min(R[k], R[k + 1] - sep(a[k], a[k + 1]));
        a.forEach((v, k) => { X[v] = (L[k] + R[k]) / 2; });
      }
    }
    // 座標（箱）
    const pt = (v) => (TB ? [X[v], mainC[V[v].layer]] : [mainC[V[v].layer], X[v]]);
    nodes.forEach((nd, i) => { const p = pt(i); nd.x = p[0]; nd.y = p[1]; });
    // 線の出入り口：同じ辺に何本も出入りするときは、辺に沿って分けて配る（行き先の位置の順に並べて、交差を避ける）
    const entries = chains.map((ch0, di) => {
      const back = rev.has(dag[di].i), ch = back ? ch0.slice().reverse() : ch0;
      return { ch0, ch, back, e: edges[dag[di].i], sOff: 0, eOff: 0 };
    });
    const ports = new Map();
    entries.forEach((en) => {
      const add = (v, side, other, which) => { const k = v + ':' + side; if (!ports.has(k)) ports.set(k, []); ports.get(k).push({ en, which, other }); };
      add(en.ch[0], en.back ? 'b' : 'a', X[en.ch[1]], 'sOff');
      add(en.ch[en.ch.length - 1], en.back ? 'a' : 'b', X[en.ch[en.ch.length - 2]], 'eOff');
    });
    const portSpan = (nd) => { // 線を分けて出入りさせてよい幅（図形によって、まっすぐな辺の幅が違う）
      if (nd.shape === 'hex' && TB) return (nd.w - 2 * LN.diagramStyles.hexCut(nd.w, nd.h)) * 0.9;
      if (nd.shape === 'pill' && TB) return Math.max(10, nd.w - nd.h) * 0.9;
      if (nd.shape === 'diamond') return crossOf(nd) * 0.5;
      return crossOf(nd) * 0.78;
    };
    ports.forEach((list, k) => {
      const nd = nodes[parseInt(k, 10)];
      list.sort((p, q) => p.other - q.other);
      list.forEach((p, idx) => { p.en[p.which] = ((idx + 1) / (list.length + 1) - 0.5) * portSpan(nd); });
    });
    const half = (nd, off) => { // 辺の中央からずらした位置 off で、図形の縁までの距離（主軸方向）
      const h = mainOf(nd) / 2, cs = crossOf(nd) / 2, ao = Math.abs(off);
      switch (nd.shape) {
        case 'ellipse': return h * Math.sqrt(Math.max(0, 1 - (off / cs) * (off / cs)));
        case 'diamond': return h * Math.max(0, 1 - ao / cs);
        case 'hex': return TB ? h : h - LN.diagramStyles.hexCut(nd.w, nd.h) * ao / cs;
        case 'pill': return TB ? h : nd.w / 2 - nd.h / 2 + Math.sqrt(Math.max(0, (nd.h / 2) * (nd.h / 2) - off * off));
        default: return h;
      }
    };
    const bez = (g, t) => { const u = 1 - t; return [u * u * u * g.p[0] + 3 * u * u * t * g.c1[0] + 3 * u * t * t * g.c2[0] + t * t * t * g.q[0], u * u * u * g.p[1] + 3 * u * u * t * g.c1[1] + 3 * u * t * t * g.c2[1] + t * t * t * g.q[1]]; };
    const paths = [];
    let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
    entries.forEach((en) => {
      const { ch, back } = en, sgn = back ? -1 : 1;
      const first = nodes[ch[0]], last = nodes[ch[ch.length - 1]];
      const pts = ch.map((v) => pt(v));
      const s0 = pts[0].slice(), t0 = pts[pts.length - 1].slice();
      if (TB) { s0[0] += en.sOff; s0[1] += sgn * half(first, en.sOff); t0[0] += en.eOff; t0[1] -= sgn * half(last, en.eOff); }
      else { s0[1] += en.sOff; s0[0] += sgn * half(first, en.sOff); t0[1] += en.eOff; t0[0] -= sgn * half(last, en.eOff); }
      pts[0] = s0; pts[pts.length - 1] = t0;
      const dv = TB ? [0, sgn] : [sgn, 0];
      const endp = [t0[0] - dv[0] * 9, t0[1] - dv[1] * 9];
      const segs = [];
      for (let k = 1; k < pts.length; k++) {
        const p = pts[k - 1], q = k === pts.length - 1 ? endp : pts[k];
        segs.push(TB ? { p, c1: [p[0], (p[1] + q[1]) / 2], c2: [q[0], (p[1] + q[1]) / 2], q } : { p, c1: [(p[0] + q[0]) / 2, p[1]], c2: [(p[0] + q[0]) / 2, q[1]], q });
      }
      let d = 'M' + f1(segs[0].p[0]) + ' ' + f1(segs[0].p[1]);
      segs.forEach((g) => { d += ' C' + f1(g.c1[0]) + ' ' + f1(g.c1[1]) + ' ' + f1(g.c2[0]) + ' ' + f1(g.c2[1]) + ' ' + f1(g.q[0]) + ' ' + f1(g.q[1]); });
      segs.forEach((g) => { for (let t = 0; t <= 1; t += 0.25) { const c = bez(g, t); bx1 = Math.min(bx1, c[0]); by1 = Math.min(by1, c[1]); bx2 = Math.max(bx2, c[0]); by2 = Math.max(by2, c[1]); } });
      const jd = Math.floor((en.ch0.length - 1) / 2);
      paths.push({ d, tip: t0, dir: dv, dash: back, label: en.e.label, segs, segIdx: back ? segs.length - 1 - jd : jd, lp: null });
    });
    // 線の説明：ほかの説明や箱と重ならない位置を、線に沿って探す
    const boxes = nodes.map((nd) => ({ x1: nd.x - nd.w / 2 - 2, y1: nd.y - nd.h / 2 - 2, x2: nd.x + nd.w / 2 + 2, y2: nd.y + nd.h / 2 + 2 }));
    const hit = (a, c) => a.x1 < c.x2 && a.x2 > c.x1 && a.y1 < c.y2 && a.y2 > c.y1;
    const placed = [];
    paths.forEach((pa) => {
      if (!pa.label) return;
      const w = tw(pa.label, 12.5) + 12, h = 20, g = pa.segs[Math.max(0, Math.min(pa.segs.length - 1, pa.segIdx))];
      const area = (a, c) => Math.max(0, Math.min(a.x2, c.x2) - Math.max(a.x1, c.x1)) * Math.max(0, Math.min(a.y2, c.y2) - Math.max(a.y1, c.y1));
      let best = null, bestCost = Infinity;
      for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
        const c = bez(g, t), box = { x1: c[0] - w / 2, y1: c[1] - h / 2, x2: c[0] + w / 2, y2: c[1] + h / 2, c };
        const cost = placed.reduce((sum, o) => sum + area(box, o), 0) + boxes.reduce((sum, o) => sum + area(box, o), 0) * 3;
        if (cost < bestCost) { best = box; bestCost = cost; }
        if (cost === 0) break;
      }
      placed.push(best); pa.lp = best.c;
    });
    return { paths, bounds: [bx1, by1, bx2, by2] };
  }

  function flowLayout(bp, S, TB) {
    const m = S.m, N = bp.items.length, maxW = N > 10 ? 170 : 200, groups = groupsOf(bp), isMap = bp.type === 'map';
    const nodes = bp.items.map((it) => { const shape = LN.diagramStyles.shapeFor(S, isMap ? 'map' : it.kind || 'process'); return Object.assign(measureNode(it, m, maxW, shape), { c: groups.length ? Math.max(0, groups.indexOf(it.group)) : 0, g: groups.length ? groups.indexOf(it.group) : -1, shape, lvl: 0, hl: it.highlight }); });
    const idx = new Map(bp.items.map((it, i) => [it.id, i]));
    const edges = bp.links.map((l) => ({ a: idx.get(l.from), b: idx.get(l.to), label: l.label }));
    const r = layered(nodes, edges, TB, m);
    const out = newOut();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (a, b, c, d) => { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c); y2 = Math.max(y2, d); };
    nodes.forEach((nd) => grow(nd.x - nd.w / 2, nd.y - nd.h / 2, nd.x + nd.w / 2, nd.y + nd.h / 2));
    grow(r.bounds[0] - 2, r.bounds[1] - 2, r.bounds[2] + 2, r.bounds[3] + 2);
    r.paths.forEach((p) => {
      out.edges.push({ k: 'path', role: 'edge', d: p.d, dash: p.dash });
      out.edges.push(arrowHead(p.tip, p.dir));
      if (p.label) { const b = edgeLabel(out, p.lp[0], p.lp[1], p.label, m); grow(b.x1, b.y1, b.x2, b.y2); }
    });
    nodes.forEach((nd, i) => {
      emitNode(out, nd, m);
      if (!isMap) badgePrims(out, nd, i);
    });
    return finish(out, x1, y1, x2, y2);
  }
  /** 座標を (0,0) 起点にずらして、大きさと一緒に返す */
  function finish(out, x1, y1, x2, y2) {
    const dx = -x1, dy = -y1;
    return { out, dx, dy, w: x2 - x1, h: y2 - y1 };
  }

  /* ---------- 循環図：輪に並べる ---------- */
  function cycleLayout(bp, S) {
    const m = S.m, n = bp.items.length, groups = groupsOf(bp);
    const shapeC = LN.diagramStyles.shapeFor(S, 'cycle');
    const nodes = bp.items.map((it, i) => Object.assign(measureNode(it, m, 170, shapeC), { c: groups.length ? Math.max(0, groups.indexOf(it.group)) : i, g: groups.length ? groups.indexOf(it.group) : -1, lvl: 0, shape: shapeC, hl: it.highlight }));
    let rx = n === 2 ? 150 : 140, ry = n === 2 ? 70 : 110;
    const place = () => nodes.forEach((nd, i) => { nd.th = n === 2 ? (i === 0 ? Math.PI : 0) : -Math.PI / 2 + (i * 2 * Math.PI) / n; nd.x = rx * Math.cos(nd.th); nd.y = ry * Math.sin(nd.th); });
    const P = (th) => [rx * Math.cos(th), ry * Math.sin(th)];
    const inside = (nd, p, pad) => Math.abs(p[0] - nd.x) <= nd.w / 2 + pad && Math.abs(p[1] - nd.y) <= nd.h / 2 + pad;
    const exit = (nd, th0, dir) => { for (let d = 0.01; d < Math.PI; d += 0.01) if (!inside(nd, P(th0 + dir * d), 5)) return d; return 0.3; };
    const overlap = () => { for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const a = nodes[i], b = nodes[j]; if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 26 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + 26) return true; } return false; };
    const arcs = () => nodes.map((nd, i) => {
      const nx = nodes[(i + 1) % n];
      let thEnd = nx.th; while (thEnd <= nd.th) thEnd += 2 * Math.PI;
      const a = nd.th + exit(nd, nd.th, 1), b = thEnd - exit(nx, thEnd, -1);
      return { a, b, from: nd, to: nx };
    });
    place();
    for (let k = 0; k < 80; k++) {
      const bad = overlap() || arcs().some((r) => { const p = P(r.a), q = P(r.b); return r.b - r.a < 0.12 || Math.hypot(p[0] - q[0], p[1] - q[1]) < 26; });
      if (!bad) break;
      rx *= 1.07; ry *= 1.07; place();
    }
    const out = newOut();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (a, b, c, d) => { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c); y2 = Math.max(y2, d); };
    nodes.forEach((nd) => grow(nd.x - nd.w / 2, nd.y - nd.h / 2, nd.x + nd.w / 2, nd.y + nd.h / 2));
    arcs().forEach((r, i) => {
      const s = P(r.a), tip = P(r.b), tan = [-rx * Math.sin(r.b), ry * Math.cos(r.b)], tl = Math.hypot(tan[0], tan[1]);
      const dv = [tan[0] / tl, tan[1] / tl], e = [tip[0] - dv[0] * 9, tip[1] - dv[1] * 9];
      // 矢じりの手前まで弧を引く（弧の終点を、先端より少し手前の角度にする）
      const dth = 9 / Math.hypot(rx * Math.sin(r.b), ry * Math.cos(r.b));
      const eb = r.b - dth, ee = P(eb);
      out.edges.push({ k: 'path', role: 'edge', d: 'M' + f1(s[0]) + ' ' + f1(s[1]) + ' A' + f1(rx) + ' ' + f1(ry) + ' 0 ' + ((eb - r.a) > Math.PI ? 1 : 0) + ' 1 ' + f1(ee[0]) + ' ' + f1(ee[1]) });
      out.edges.push(arrowHead(tip, dv));
      for (let k = 0; k <= 12; k++) { const q = P(r.a + ((eb - r.a) * k) / 12); grow(q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1); }
      const lab = bp.links[i] && bp.links[i].label;
      if (lab) { const mid = P((r.a + r.b) / 2), nl = Math.hypot(mid[0] / (rx * rx), mid[1] / (ry * ry)) || 1; const b = edgeLabel(out, mid[0] + (mid[0] / (rx * rx)) / nl * 18, mid[1] + (mid[1] / (ry * ry)) / nl * 18, lab, m); grow(b.x1, b.y1, b.x2, b.y2); }
    });
    nodes.forEach((nd, i) => {
      emitNode(out, nd, m);
      badgePrims(out, nd, i);
    });
    return finish(out, x1, y1, x2, y2);
  }

  /* ---------- 階層図：木を整えて並べる ---------- */
  function treeLayout(bp, S, TB) {
    const m = S.m, N = bp.items.length, groups = groupsOf(bp);
    const idx = new Map(bp.items.map((it, i) => [it.id, i]));
    const kids = bp.items.map(() => []), roots = [];
    bp.items.forEach((it, i) => { if (it.parent && idx.has(it.parent)) kids[idx.get(it.parent)].push(i); else roots.push(i); });
    const depth = new Array(N).fill(0);
    const setDepth = (i, d) => { depth[i] = d; kids[i].forEach((k) => setDepth(k, d + 1)); };
    roots.forEach((r) => setDepth(r, 0));
    const maxW = TB ? (N > 12 ? 150 : 170) : 200;
    const shapeT = LN.diagramStyles.shapeFor(S, 'tree');
    const nodes = bp.items.map((it, i) => Object.assign(measureNode(it, m, maxW, shapeT), { c: groups.length ? Math.max(0, groups.indexOf(it.group)) : Math.min(depth[i], 5), g: groups.length ? groups.indexOf(it.group) : -1, lvl: depth[i], root: depth[i] === 0, shape: shapeT, hl: it.highlight }));
    const crossOf = (nd) => (TB ? nd.w : nd.h), mainOf = (nd) => (TB ? nd.h : nd.w);
    const gapC = TB ? 22 : 16, gapM = TB ? 44 : 56;
    const E = new Array(N).fill(0), cc = new Array(N).fill(0);
    const ext = (i) => { let s = 0; kids[i].forEach((k, j) => { s += ext(k) + (j ? gapC : 0); }); E[i] = Math.max(crossOf(nodes[i]), s); return E[i]; };
    const place = (i, start) => {
      if (!kids[i].length) { cc[i] = start + E[i] / 2; return; }
      const total = kids[i].reduce((s, k, j) => s + E[k] + (j ? gapC : 0), 0);
      let cur = start + (E[i] - total) / 2;
      kids[i].forEach((k) => { place(k, cur); cur += E[k] + gapC; });
      cc[i] = (cc[kids[i][0]] + cc[kids[i][kids[i].length - 1]]) / 2;
    };
    let cur = 0;
    roots.forEach((r) => { ext(r); place(r, cur); cur += E[r] + gapC * 2; });
    const maxDepth = Math.max(...depth);
    const dsz = Array.from({ length: maxDepth + 1 }, (_, d) => Math.max(...nodes.filter((_, i) => depth[i] === d).map(mainOf)));
    const dpos = []; let mc = 0; dsz.forEach((s, d) => { dpos[d] = mc + s / 2; mc += s + gapM; });
    nodes.forEach((nd, i) => { nd.x = TB ? cc[i] : dpos[depth[i]]; nd.y = TB ? dpos[depth[i]] : cc[i]; });
    const out = newOut();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    nodes.forEach((nd) => { x1 = Math.min(x1, nd.x - nd.w / 2); y1 = Math.min(y1, nd.y - nd.h / 2); x2 = Math.max(x2, nd.x + nd.w / 2); y2 = Math.max(y2, nd.y + nd.h / 2); });
    const R = 9;
    bp.items.forEach((it, ci) => {
      if (!it.parent || !idx.has(it.parent)) return;
      const p = nodes[idx.get(it.parent)], c = nodes[ci];
      let d;
      if (TB) {
        const sx = p.x, sy = p.y + p.h / 2, ex = c.x, ey = c.y - c.h / 2, my = (sy + ey) / 2, dx = ex - sx;
        d = Math.abs(dx) < 1 ? 'M' + f1(sx) + ' ' + f1(sy) + ' L' + f1(ex) + ' ' + f1(ey)
          : 'M' + f1(sx) + ' ' + f1(sy) + ' L' + f1(sx) + ' ' + f1(my - R) + ' Q' + f1(sx) + ' ' + f1(my) + ' ' + f1(sx + Math.sign(dx) * R) + ' ' + f1(my) +
            ' L' + f1(ex - Math.sign(dx) * R) + ' ' + f1(my) + ' Q' + f1(ex) + ' ' + f1(my) + ' ' + f1(ex) + ' ' + f1(my + R) + ' L' + f1(ex) + ' ' + f1(ey);
      } else {
        const sx = p.x + p.w / 2, sy = p.y, ex = c.x - c.w / 2, ey = c.y, mx = (sx + ex) / 2, dy = ey - sy;
        d = Math.abs(dy) < 1 ? 'M' + f1(sx) + ' ' + f1(sy) + ' L' + f1(ex) + ' ' + f1(ey)
          : 'M' + f1(sx) + ' ' + f1(sy) + ' L' + f1(mx - R) + ' ' + f1(sy) + ' Q' + f1(mx) + ' ' + f1(sy) + ' ' + f1(mx) + ' ' + f1(sy + Math.sign(dy) * R) +
            ' L' + f1(mx) + ' ' + f1(ey - Math.sign(dy) * R) + ' Q' + f1(mx) + ' ' + f1(ey) + ' ' + f1(mx + R) + ' ' + f1(ey) + ' L' + f1(ex) + ' ' + f1(ey);
      }
      out.edges.push({ k: 'path', role: 'edge', d });
    });
    nodes.forEach((nd) => emitNode(out, nd, m));
    return finish(out, x1, y1, x2, y2);
  }

  /* ---------- ベン図：円を重ねる ---------- */
  function vennLayout(bp, S) {
    const m = S.m, n = bp.items.length, out = newOut();
    const nodes = bp.items.map((it) => measureNode(it, m, 112, 'rect'));
    const ext = nodes.map((nd) => ({ w: Math.max(20, ...nd.L.map((q) => tw(q, m.fs) * 1.07), ...nd.D.map((q) => tw(q, m.fsDetail))), h: nd.L.length * nd.lh + (nd.D.length ? 5 + nd.D.length * nd.ldh : 0) }));
    const tW = Math.max(...ext.map((e) => e.w)), tH = Math.max(...ext.map((e) => e.h));
    const idxOf = new Map(bp.items.map((it, i) => [it.id, i]));
    const pairLabel = (i, j) => { const l = bp.links.find((x) => (idxOf.get(x.from) === i && idxOf.get(x.to) === j) || (idxOf.get(x.from) === j && idxOf.get(x.to) === i)); return l ? l.label : ''; };
    const ink = (lines, fs) => (lines.length ? Math.max(...lines.map((q) => tw(q, fs) * 1.07)) : 0);
    const emitSet = (i, cx, cy, tx, ty) => { // 集合の名前と補足を、(tx, ty) を中心に置く
      const nd = nodes[i], top = ty - ext[i].h / 2;
      out.texts.push({ k: 'text', own: 'venn', x: tx, y: top, a: 'middle', lines: nd.L, fs: m.fs, lh: nd.lh, b: true, c: i, g: i });
      if (nd.D.length) out.texts.push({ k: 'text', own: 'venn', x: tx, y: top + nd.L.length * nd.lh + 5, a: 'middle', lines: nd.D, fs: m.fsDetail, lh: nd.ldh, b: false, detail: true, c: i, g: i });
    };
    const emitSmall = (lines, tx, ty) => { // 共通部分の文字（小さめ）
      const lh = 18;
      if (lines.length) out.texts.push({ k: 'text', own: 'venn', x: tx, y: ty - (lines.length * lh) / 2, a: 'middle', lines, fs: 13, lh, b: true, c: 0, g: -1 });
    };
    const circle = (i, cx, cy, r) => out.shapes.push({ k: 'rect', role: 'venn', shape: 'ellipse', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, c: i, g: i, lvl: 0 });
    if (n === 2) {
      const lens = wrap(pairLabel(0, 1) || bp.center || '', 80, 13).filter(Boolean), lw = ink(lens, 13);
      const d = tW + 34;
      let r = Math.max(78, (d + lw + 16) / 2, (225 + (tH * tH) / 4) / 30 + 12);
      for (let k = 0; k < 80; k++) { const ox = r - d / 2 + tW / 2; if (ox * ox + (tH / 2) * (tH / 2) <= (r - 4) * (r - 4)) break; r += 4; }
      circle(0, -d / 2, 0, r); circle(1, d / 2, 0, r);
      emitSet(0, -d / 2, 0, -r, 0); emitSet(1, d / 2, 0, r, 0);
      emitSmall(lens, 0, 0);
      return finish(out, -d / 2 - r, -r, d / 2 + r, r);
    }
    // 3 つ：三角形の頂点に中心を置く（上・右下・左下）
    const pairs = [[0, 1], [1, 2], [0, 2]].map(([i, j]) => ({ i, j, lines: wrap(pairLabel(i, j), 56, 12.5).filter(Boolean) }));
    const cen = wrap(bp.center || '', 64, 13).filter(Boolean);
    const ang = [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6];
    let r = 96, cs;
    const centers = () => ang.map((a) => [Math.cos(a) * (r * 1.35) / Math.sqrt(3), Math.sin(a) * (r * 1.35) / Math.sqrt(3)]);
    const corners = (cx, cy, w, h) => [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx - w / 2, cy + h / 2], [cx + w / 2, cy + h / 2]];
    for (let it = 0; it < 60; it++) {
      cs = centers();
      let okAll = true;
      for (let i = 0; i < 3 && okAll; i++) { // 集合の文字：自分の円の中に入る
        const tx = cs[i][0] + Math.cos(ang[i]) * r * 0.5, ty = cs[i][1] + Math.sin(ang[i]) * r * 0.5;
        if (corners(tx, ty, ext[i].w, ext[i].h).some((q) => Math.hypot(q[0] - cs[i][0], q[1] - cs[i][1]) > r - 6)) okAll = false;
      }
      pairs.forEach((pr) => { // 2 つだけの共通部分の文字：2 つの円の中に入る
        if (!pr.lines.length || !okAll) return;
        const k = 3 - pr.i - pr.j, mx = (cs[pr.i][0] + cs[pr.j][0]) / 2, my = (cs[pr.i][1] + cs[pr.j][1]) / 2, ux = mx - cs[k][0], uy = my - cs[k][1], ul = Math.hypot(ux, uy) || 1;
        const tx = mx + (ux / ul) * r * 0.29, ty = my + (uy / ul) * r * 0.29;
        if (corners(tx, ty, ink(pr.lines, 12.5), pr.lines.length * 17).some((q) => Math.hypot(q[0] - cs[pr.i][0], q[1] - cs[pr.i][1]) > r - 4 || Math.hypot(q[0] - cs[pr.j][0], q[1] - cs[pr.j][1]) > r - 4)) okAll = false;
      });
      if (cen.length && okAll && corners(0, 0, ink(cen, 13), cen.length * 18).some((q) => cs.some((c) => Math.hypot(q[0] - c[0], q[1] - c[1]) > r - 4))) okAll = false;
      if (okAll) break;
      r += 5;
    }
    cs = centers();
    cs.forEach((c, i) => circle(i, c[0], c[1], r));
    cs.forEach((c, i) => emitSet(i, c[0], c[1], c[0] + Math.cos(ang[i]) * r * 0.5, c[1] + Math.sin(ang[i]) * r * 0.5));
    pairs.forEach((pr) => {
      if (!pr.lines.length) return;
      const k = 3 - pr.i - pr.j, mx = (cs[pr.i][0] + cs[pr.j][0]) / 2, my = (cs[pr.i][1] + cs[pr.j][1]) / 2, ux = mx - cs[k][0], uy = my - cs[k][1], ul = Math.hypot(ux, uy) || 1;
      const lh = 17, tx = mx + (ux / ul) * r * 0.29, ty = my + (uy / ul) * r * 0.29;
      out.texts.push({ k: 'text', own: 'venn', x: tx, y: ty - (pr.lines.length * lh) / 2, a: 'middle', lines: pr.lines, fs: 12.5, lh, b: true, c: 0, g: -1 });
    });
    emitSmall(cen, 0, 0);
    return finish(out, Math.min(...cs.map((c) => c[0])) - r, Math.min(...cs.map((c) => c[1])) - r, Math.max(...cs.map((c) => c[0])) + r, Math.max(...cs.map((c) => c[1])) + r);
  }

  /* ---------- 関係図：中心の概念から放射状に ---------- */
  /** 中心になる項目（線の 7 割以上がつながっていて、3 本以上ある）の番号。無ければ -1 */
  function hubOf(bp) {
    if (bp.items.length < 4) return -1;
    const deg = new Map();
    bp.links.forEach((l) => { deg.set(l.from, (deg.get(l.from) || 0) + 1); deg.set(l.to, (deg.get(l.to) || 0) + 1); });
    let best = -1, bd = 0;
    bp.items.forEach((it, i) => { const d = deg.get(it.id) || 0; if (d > bd) { bd = d; best = i; } });
    return best >= 0 && bd >= 3 && bd >= Math.ceil(bp.links.length * 0.7) ? best : -1;
  }
  function radialLayout(bp, S) {
    const m = S.m, hubI = hubOf(bp), k = bp.items.length - 1, groups = groupsOf(bp), shape = LN.diagramStyles.shapeFor(S, 'map');
    const nodes = bp.items.map((it, i) => Object.assign(measureNode(it, m, 160, shape), { shape, c: groups.length ? Math.max(0, groups.indexOf(it.group)) : (i === hubI ? 0 : 1 + ((i > hubI ? i - 1 : i) % 5)), g: groups.length ? groups.indexOf(it.group) : -1, lvl: 0, root: i === hubI, hl: it.highlight, x: 0, y: 0 }));
    const hub = nodes[hubI], ring = nodes.filter((_, i) => i !== hubI);
    let rx = Math.max(170, hub.w / 2 + Math.max(...ring.map((q) => q.w)) / 2 + 80), ry = Math.max(120, hub.h / 2 + Math.max(...ring.map((q) => q.h)) / 2 + 62);
    const place = () => ring.forEach((nd, j) => { const a = -Math.PI / 2 + (2 * Math.PI * j) / k; nd.x = rx * Math.cos(a); nd.y = ry * Math.sin(a); });
    const hit = (a, b, g) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + g && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + g;
    const labelOf = (a, b) => { const l = bp.links.find((x) => (x.from === a.id && x.to === b.id) || (x.from === b.id && x.to === a.id)); return l ? l.label : ''; };
    place();
    for (let it = 0; it < 80; it++) {
      let bad = false;
      for (let i = 0; i < nodes.length && !bad; i++) for (let j = i + 1; j < nodes.length; j++) if (hit(nodes[i], nodes[j], 28)) { bad = true; break; }
      ring.forEach((nd, j) => { // 中心との間の線が短すぎる（説明が入らない）
        const len = Math.hypot(nd.x, nd.y) || 1, ux = nd.x / len, uy = nd.y / len, lab = labelOf(bp.items[hubI], bp.items[nodes.indexOf(nd)]);
        if (len - rayExit(hub, ux, uy) - rayExit(nd, -ux, -uy) < 50 + (lab ? Math.min(tw(lab, 12.5), 110) * 0.55 : 0)) bad = true;
      });
      if (!bad) break;
      rx *= 1.07; ry *= 1.07; place();
    }
    const out = newOut();
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (a, b, c, d) => { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c); y2 = Math.max(y2, d); };
    nodes.forEach((nd) => grow(nd.x - nd.w / 2, nd.y - nd.h / 2, nd.x + nd.w / 2, nd.y + nd.h / 2));
    const idx = new Map(bp.items.map((it, i) => [it.id, i]));
    const boxes = nodes.map((nd) => ({ x1: nd.x - nd.w / 2 - 2, y1: nd.y - nd.h / 2 - 2, x2: nd.x + nd.w / 2 + 2, y2: nd.y + nd.h / 2 + 2 }));
    const placed = [];
    const area = (a, c) => Math.max(0, Math.min(a.x2, c.x2) - Math.max(a.x1, c.x1)) * Math.max(0, Math.min(a.y2, c.y2) - Math.max(a.y1, c.y1));
    bp.links.forEach((l) => {
      const A = nodes[idx.get(l.from)], B = nodes[idx.get(l.to)], dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const ea = rayExit(A, ux, uy), eb = rayExit(B, -ux, -uy);
      const s0 = [A.x + ux * ea, A.y + uy * ea], tip = [B.x - ux * eb, B.y - uy * eb], e = [tip[0] - ux * 9, tip[1] - uy * 9];
      out.edges.push({ k: 'path', role: 'edge', d: 'M' + f1(s0[0]) + ' ' + f1(s0[1]) + ' L' + f1(e[0]) + ' ' + f1(e[1]) });
      out.edges.push(arrowHead(tip, [ux, uy]));
      if (l.label) {
        const w = tw(l.label, 12.5) + 12, h = 20;
        let best = null, bestCost = Infinity;
        for (const t of [0.5, 0.42, 0.58, 0.34, 0.66]) {
          const c = [s0[0] + (e[0] - s0[0]) * t, s0[1] + (e[1] - s0[1]) * t], box = { x1: c[0] - w / 2, y1: c[1] - h / 2, x2: c[0] + w / 2, y2: c[1] + h / 2, c };
          const cost = placed.reduce((q, o) => q + area(box, o), 0) + boxes.reduce((q, o) => q + area(box, o), 0) * 3;
          if (cost < bestCost) { best = box; bestCost = cost; }
          if (cost === 0) break;
        }
        placed.push(best);
        const b = edgeLabel(out, best.c[0], best.c[1], l.label, m); grow(b.x1, b.y1, b.x2, b.y2);
      }
    });
    nodes.forEach((nd) => emitNode(out, nd, m));
    return finish(out, x1, y1, x2, y2);
  }

  /* ---------- 比較表 ---------- */
  function compareLayout(bp, S) {
    const m = S.m, nc = bp.columns.length, fsC = m.fs - 1, lhC = Math.round(fsC * 1.4), lh = Math.round(m.fs * 1.4);
    const hasLabel = bp.rows.some((r) => r.label);
    const lw = hasLabel ? Math.min(190, Math.max(92, Math.max(...bp.rows.map((r) => tw(r.label, m.fs) * 1.07)) + 2 * m.pad)) : 0;
    const cwid = Math.max(130, Math.min(260, Math.floor((900 - lw) / nc)));
    const inner = cwid - 2 * m.pad;
    const out = newOut();
    const head = bp.columns.map((c) => wrapB(c, inner, m.fs));
    const hh = Math.max(...head.map((l) => l.length)) * lh + 2 * m.padY;
    bp.columns.forEach((c, j) => {
      const x = lw + j * cwid;
      out.shapes.push({ k: 'rect', role: 'head', shape: 'rect', x, y: 0, w: cwid, h: hh, rx: 0, c: j, lvl: 0, g: -1 });
      out.texts.push({ k: 'text', own: 'head', x: x + cwid / 2, y: m.padY, a: 'middle', lines: head[j], fs: m.fs, lh, b: true, c: j, lvl: 0, g: -1 });
    });
    let y = hh;
    bp.rows.forEach((r, ri) => {
      const cl = r.cells.map((c) => wrap(c || '', inner, fsC)), rl = hasLabel ? wrapB(r.label, lw - 2 * m.pad, m.fs) : [];
      const rh = Math.max(Math.max(...cl.map((l) => l.length)) * lhC, rl.length * lh) + 2 * m.padY;
      if (hasLabel) {
        out.shapes.push({ k: 'rect', role: 'rowhead', shape: 'rect', x: 0, y, w: lw, h: rh, rx: 0, c: ri, lvl: ri, g: -1 });
        out.texts.push({ k: 'text', own: 'rowhead', x: m.pad, y: y + (rh - rl.length * lh) / 2, a: 'start', lines: rl, fs: m.fs, lh, b: true, c: ri, lvl: ri, g: -1 });
      }
      bp.columns.forEach((_, j) => {
        const x = lw + j * cwid;
        out.shapes.push({ k: 'rect', role: 'cell', shape: 'rect', x, y, w: cwid, h: rh, rx: 0, c: j, lvl: ri, g: -1 });
        out.texts.push({ k: 'text', own: 'cell', x: x + m.pad, y: y + (rh - cl[j].length * lhC) / 2, a: 'start', lines: cl[j], fs: fsC, lh: lhC, b: false, detail: false, c: j, lvl: ri, g: -1 });
      });
      y += rh;
    });
    return finish(out, 0, 0, lw + nc * cwid, y);
  }

  /* ---------- 年表 ---------- */
  function timelineLayout(bp, S, horizontal) {
    const m = S.m, n = bp.items.length, lhw = 20;
    const out = newOut();
    const info = bp.items.map((it, i) => Object.assign(measureNode(it, m, horizontal ? 176 : 440, 'rect'), { c: i % 6, lvl: 0, g: -1 }));
    const cardW = (nd) => (horizontal ? 176 : Math.min(460, Math.max(220, nd.w)));
    if (!horizontal) {
      const whenW = Math.min(150, Math.max(0, ...bp.items.map((it) => (it.when ? tw(it.when, 15) * 1.07 : 0))));
      const axisX = whenW + 26, cx = axisX + 28, W = Math.max(...info.map(cardW));
      let y = 0, firstY = 0, lastY = 0;
      info.forEach((nd, i) => {
        const it = bp.items[i], w = W, cy = y + 18;
        if (i === 0) firstY = cy; lastY = cy;
        out.shapes.push({ k: 'rect', role: 'card', shape: 'rect', hl: bp.items[i].highlight, x: cx, y, w, h: nd.h, c: nd.c, lvl: i, g: -1 });
        const th = nd.L.length * nd.lh + (nd.D.length ? 5 + nd.D.length * nd.ldh : 0), top = y + (nd.h - th) / 2;
        out.texts.push({ k: 'text', own: 'card', hl: bp.items[i].highlight, x: cx + m.pad + (S.bar ? 4 : 0), y: top, a: 'start', lines: nd.L, fs: m.fs, lh: nd.lh, b: true, c: nd.c, lvl: i, g: -1 });
        if (nd.D.length) out.texts.push({ k: 'text', own: 'card', hl: bp.items[i].highlight, x: cx + m.pad + (S.bar ? 4 : 0), y: top + nd.L.length * nd.lh + 5, a: 'start', lines: nd.D, fs: m.fsDetail, lh: nd.ldh, b: false, detail: true, c: nd.c, lvl: i, g: -1 });
        out.tops.push({ k: 'circle', role: 'dot', cx: axisX, cy, r: 8, c: nd.c, lvl: i, g: -1 });
        if (it.when) out.texts.push({ k: 'text', own: 'when', detail: false, x: axisX - 18, y: cy - 10, a: 'end', lines: wrapB(it.when, 150, 15).slice(0, 2), fs: 15, lh: 18, b: true, c: nd.c, lvl: i, g: -1 });
        y += nd.h + 16;
      });
      out.edges.push({ k: 'path', role: 'axis', d: 'M' + f1(axisX) + ' ' + f1(firstY - 12) + ' L' + f1(axisX) + ' ' + f1(lastY + 12) });
      return finish(out, 0, 0, cx + W, y - 16);
    }
    // 横向き：上下にずらして並べる
    const cw0 = 176, spacing = 112, stem = 38;
    const top = info.filter((_, i) => i % 2 === 0), bot = info.filter((_, i) => i % 2 === 1);
    const hAbove = Math.max(0, ...top.map((nd) => nd.h)), hBelow = Math.max(0, ...bot.map((nd) => nd.h));
    const axisY = hAbove + stem;
    info.forEach((nd, i) => {
      const it = bp.items[i], x = cw0 / 2 + i * spacing, above = i % 2 === 0;
      const y = above ? axisY - stem - nd.h : axisY + stem;
      out.edges.push({ k: 'path', role: 'edge', thin: true, d: 'M' + f1(x) + ' ' + f1(axisY) + ' L' + f1(x) + ' ' + f1(above ? axisY - stem : axisY + stem) });
      out.shapes.push({ k: 'rect', role: 'card', shape: 'rect', hl: bp.items[i].highlight, x: x - cw0 / 2, y, w: cw0, h: nd.h, c: nd.c, lvl: i, g: -1 });
      const th = nd.L.length * nd.lh + (nd.D.length ? 5 + nd.D.length * nd.ldh : 0), ty = y + (nd.h - th) / 2;
      out.texts.push({ k: 'text', own: 'card', hl: bp.items[i].highlight, x, y: ty, a: 'middle', lines: nd.L, fs: m.fs, lh: nd.lh, b: true, c: nd.c, lvl: i, g: -1 });
      if (nd.D.length) out.texts.push({ k: 'text', own: 'card', hl: bp.items[i].highlight, x, y: ty + nd.L.length * nd.lh + 5, a: 'middle', lines: nd.D, fs: m.fsDetail, lh: nd.ldh, b: false, detail: true, c: nd.c, lvl: i, g: -1 });
      out.tops.push({ k: 'circle', role: 'dot', cx: x, cy: axisY, r: 8, c: nd.c, lvl: i, g: -1 });
      if (it.when) out.texts.push({ k: 'text', own: 'when', detail: false, x, y: above ? axisY + 10 : axisY - 10 - lhw, a: 'middle', lines: wrapB(it.when, 104, 14).slice(0, 1), fs: 14, lh: lhw, b: true, c: nd.c, lvl: i, g: -1 });
    });
    const xe = cw0 / 2 + (n - 1) * spacing + cw0 / 2;
    out.edges.unshift({ k: 'path', role: 'axis', d: 'M12 ' + f1(axisY) + ' L' + f1(xe - 8) + ' ' + f1(axisY) });
    out.edges.push({ k: 'arrow', role: 'axis', pts: [xe, axisY, xe - 12, axisY - 6, xe - 12, axisY + 6] });
    return finish(out, 0, 0, xe, axisY + stem + hBelow);
  }

  /* ================= 組み立て ================= */
  const fscale = (r) => Math.min(1, 880 / r.w, 1500 / r.h);
  function chooseDir(fn, dir, prefTB) {
    if (dir === 'tb') return { tb: true, r: fn(true) };
    if (dir === 'lr') return { tb: false, r: fn(false) };
    const a = fn(true), b = fn(false), sa = fscale(a), sb = fscale(b);
    if (Math.abs(sa - sb) <= 0.04 * Math.max(sa, sb)) return prefTB ? { tb: true, r: a } : { tb: false, r: b };
    return sa > sb ? { tb: true, r: a } : { tb: false, r: b };
  }
  const isChain = (bp) => bp.items.length <= 4 && bp.links.length === bp.items.length - 1 && bp.links.every((l, i) => l.from === bp.items[i].id && l.to === bp.items[i + 1].id);

  function legendPrims(groups, S, width) {
    const out = [], m = S.m, fs = 13; let x = 0, y = 0;
    groups.forEach((g, i) => {
      const w = 22 + tw(g, fs) + 22;
      if (x && x + w > width) { x = 0; y += 26; }
      out.push({ k: 'rect', role: 'legend', shape: 'rect', x, y: y + 2, w: 16, h: 16, rx: 3, c: i, lvl: 0, g: i });
      out.push({ k: 'text', own: 'legend', x: x + 24, y, a: 'start', lines: [g], fs, lh: 20, b: false, c: i, lvl: 0, g: i });
      x += w;
    });
    return { prims: out, h: y + 22, w: Math.min(width, x || 0) };
  }

  function render(input, opts) {
    opts = opts || {};
    const nr = normalize(input);
    if (!nr.ok) return nr;
    const bp = nr.bp, S = LN.diagramStyles.get(opts.style), dir = opts.dir === 'tb' || opts.dir === 'lr' ? opts.dir : 'auto';
    let lay, usedDir = null;
    if (bp.type === 'map' && hubOf(bp) >= 0) lay = radialLayout(bp, S);
    else if (bp.type === 'flow' || bp.type === 'map') {
      const c = chooseDir((tb) => flowLayout(bp, S, tb), dir, !isChain(bp) || bp.type === 'map');
      lay = c.r; usedDir = c.tb ? 'tb' : 'lr';
    } else if (bp.type === 'venn') lay = vennLayout(bp, S);
    else if (bp.type === 'tree') {
      const c = chooseDir((tb) => treeLayout(bp, S, tb), dir, true);
      lay = c.r; usedDir = c.tb ? 'tb' : 'lr';
    } else if (bp.type === 'cycle') lay = cycleLayout(bp, S);
    else if (bp.type === 'compare') lay = compareLayout(bp, S);
    else {
      const fitH = bp.items.length >= 3 && bp.items.length <= 7 && bp.items.every((it) => wrap(it.label, 176 - 2 * S.m.pad, S.m.fs).length + (it.detail ? wrap(it.detail, 176 - 2 * S.m.pad, S.m.fsDetail).length : 0) <= 6);
      const horizontal = dir === 'lr' ? true : dir === 'tb' ? false : fitH;
      lay = timelineLayout(bp, S, horizontal); usedDir = horizontal ? 'lr' : 'tb';
    }
    const groups = bp.type === 'compare' || bp.type === 'timeline' || bp.type === 'venn' ? [] : groupsOf(bp);
    const sty = LN.diagramStyles;
    const titleLines = bp.title ? wrap(bp.title, 720, S.m.fsTitle) : [];
    const titleH = titleLines.length ? titleLines.length * Math.round(S.m.fsTitle * 1.4) + (S.rule ? 22 : 14) : 0;
    const titleW = titleLines.length ? Math.max(...titleLines.map((l) => tw(l, S.m.fsTitle) * 1.07)) : 0;
    const leg = groups.length ? legendPrims(groups, S, Math.max(lay.w, 360)) : null;
    const innerW = Math.max(lay.w, titleW, leg ? leg.w : 0, 200);
    const W = Math.ceil(innerW + 2 * MARGIN), H = Math.ceil(titleH + lay.h + (leg ? leg.h + 18 : 0) + 2 * MARGIN);
    const ox = MARGIN + (innerW - lay.w) / 2 + lay.dx, oy = MARGIN + titleH + lay.dy;
    const parts = [];
    parts.push('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="' + S.font + '">');
    parts.push('<desc>' + sty.esc(MARK + JSON.stringify(compact(bp))) + '</desc>');
    if (S.defs) parts.push(S.defs());
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>');
    if (titleLines.length) {
      const lht = Math.round(S.m.fsTitle * 1.4);
      titleLines.forEach((l, i) => parts.push('<text x="' + sty.fx(W / 2) + '" y="' + sty.fx(MARGIN + i * lht + lht / 2 + S.m.fsTitle * 0.35) + '" font-size="' + S.m.fsTitle + '" text-anchor="middle" font-weight="700" fill="' + S.titleCol + '">' + sty.esc(l) + '</text>'));
      if (S.rule) parts.push(sty.ruleSvg(S, W / 2, MARGIN + titleLines.length * lht + 6));
    }
    parts.push('<g transform="translate(' + sty.fx(ox) + ' ' + sty.fx(oy) + ')">');
    const o = lay.out;
    // 重なりの順：線 → 箱 → 文字 → 番号・ラベルなど
    [o.edges, o.shapes, o.texts, o.tops].forEach((arr) => arr.forEach((p) => { parts.push(sty.paint(S, p)); }));
    parts.push('</g>');
    if (leg) {
      parts.push('<g transform="translate(' + sty.fx(MARGIN + (innerW - leg.w) / 2) + ' ' + sty.fx(MARGIN + titleH + lay.h + 18) + ')">');
      leg.prims.forEach((p) => parts.push(sty.paint(S, p)));
      parts.push('</g>');
    }
    parts.push('</svg>');
    const boxes = o.shapes.filter((p) => p.role === 'node' || p.role === 'card').map((p) => ({ role: p.role, x: ox + p.x, y: oy + p.y, w: p.w, h: p.h }));
    return { ok: true, svg: parts.join(''), width: W, height: H, dir: usedDir, type: bp.type, style: S.id, warnings: nr.warnings, boxes };
  }

  function compact(bp) {
    const o = { type: bp.type, title: bp.title };
    if (bp.items.length) o.items = bp.items.map((i) => { const r = { id: i.id, label: i.label }; ['detail', 'when', 'parent', 'group', 'kind'].forEach((k) => { if (i[k]) r[k] = i[k]; }); if (i.highlight) r.highlight = true; return r; });
    if (bp.center) o.center = bp.center;
    if (bp.links.length && bp.type !== 'cycle') o.links = bp.links.map((l) => (l.label ? l : { from: l.from, to: l.to }));
    if (bp.type === 'cycle' && bp.links.some((l) => l.label)) o.links = bp.links.filter((l) => l.label);
    if (bp.columns.length) { o.columns = bp.columns; o.rows = bp.rows; }
    return o;
  }

  /** できあがった SVG の <desc> から設計図を取り出す（無ければ null）。中身は normalize で検査する */
  function fromSvg(svg) {
    const m = /<desc>([\s\S]*?)<\/desc>/i.exec(String(svg || ''));
    if (!m) return null;
    const t = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
    if (t.indexOf(MARK) !== 0) return null;
    const r = normalize(t.slice(MARK.length));
    return r.ok ? r.bp : null;
  }

  LN.diagram = { TYPES, SCHEMA, normalize, parse, render, fromSvg, toJSON, canon, tunedPrompt, systemPrompt, userPrompt, refinePrompt, styles: () => LN.diagramStyles.list(), wrap, textWidth: tw };
})(window);
