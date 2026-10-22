/* 長い教材を「区切って」まとめるための部品（画面や通信とは無関係の、純粋な関数だけ）。
   Ollama（この PC の AI）は、文章を読み込む時間が文字数にほぼ比例するので、長い教材を 1 回で渡すと、何分も何も出ず、固まって見える。
   そこで、① 教材の文字を、見出し・段落の切れ目で、約 1200 字ずつに区切り（split）
         ② 1 区切りずつ、決まった形（JSON：CHUNK_SCHEMA）で要点にしてもらい（AI への依頼は ai.js）
         ③ その結果を、このアプリのノートの形（概要・内容の整理・用語・確認問題）に、プログラムで組み立てる（build）。
   AI に頼むのは、各区切りの「要点」と、最後の「概要」だけ。全体の構成・用語や問題の集約は、AI に頼まない（速く、形が崩れない）。
   test/test-chunks.js が確かめる。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const MAX_CHARS = 1200;       // 1 区切りの目安（これを超えないように切る）
  const MIN_CHARS = 150;        // これより短い区切りは、前の区切りにくっつける

  /** 見出しらしい行（# 見出し／第 N 章／スライド N／【ファイル名】／数字つきの見出し） */
  const HEAD = /^(#{1,6}\s|第[0-9０-９一二三四五六七八九十]+[章節回]|【.{1,60}】|\[?スライド\s*[0-9０-９]+|[0-9０-９]+[.．)）]\s*\S|[■●◆▼▶])/;

  /** 文章を、見出し・段落・文の切れ目で、max 字以下の区切りに分ける。切れ目が無い長い文は、句点（。！？）で、それでも無理なら max 字で切る */
  function split(text, max) {
    max = max || MAX_CHARS;
    const src = String(text || '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim();
    if (!src) return [];
    // 1. 行ごとに、「これ以上、小さくしない単位」（段落）にする。長すぎる段落は、文で、それでも長ければ、max 字で切る
    const units = [];
    for (const para of src.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= max) { units.push(p); continue; }
      let buf = '';
      for (const sent of p.split(/(?<=[。！？!?\n])/)) {
        if (buf && (buf + sent).length > max) { units.push(buf.trim()); buf = ''; }
        if (sent.length > max) { for (let i = 0; i < sent.length; i += max) units.push(sent.slice(i, i + max).trim()); }
        else buf += sent;
      }
      if (buf.trim()) units.push(buf.trim());
    }
    // 2. 単位を、max 字に収まるまで詰める。見出しで始まる単位は、いまの区切りがある程度たまっていれば、そこで区切る（見出しを、前の区切りの末尾に置き去りにしない）
    const chunks = [];
    let cur = '';
    for (const u of units) {
      const startsHead = HEAD.test(u);
      const full = cur && (cur.length + 2 + u.length > max || (startsHead && cur.length >= max * 0.4));
      if (full) { chunks.push(cur); cur = ''; }
      cur += (cur ? '\n\n' : '') + u;
    }
    if (cur) chunks.push(cur);
    // 3. 短すぎる区切り（末尾など）は、前にくっつける（max を少し超えてもよい）
    for (let i = chunks.length - 1; i > 0; i--) {
      if (chunks[i].length < MIN_CHARS && chunks[i - 1].length + 2 + chunks[i].length <= max * 1.25) { chunks[i - 1] += '\n\n' + chunks[i]; chunks.splice(i, 1); }
    }
    return chunks;
  }

  /** 1 区切りの結果の形（Ollama の structured output に渡す）。見出し・要点・用語・確認問題 */
  const CHUNK_SCHEMA = {
    type: 'object',
    properties: {
      heading: { type: 'string' },
      points: { type: 'array', items: { type: 'string' } },
      terms: { type: 'array', items: { type: 'object', properties: { term: { type: 'string' }, desc: { type: 'string' } }, required: ['term', 'desc'] } },
      qa: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } }, required: ['q', 'a'] } },
    },
    required: ['heading', 'points', 'terms', 'qa'],
  };
  /** 最後の「概要」の形 */
  const OVERVIEW_SCHEMA = {
    type: 'object',
    properties: { title: { type: 'string' }, overview: { type: 'array', items: { type: 'string' } } },
    required: ['title', 'overview'],
  };

  // 強調の印 ==語== が、片側だけ（小さい AI がよくやる）だと、画面が崩れる。印の数が奇数なら、その行の == をすべて外す。** は使わない
  const marks = (s) => ((s.match(/==/g) || []).length % 2 ? s.replace(/==/g, '') : s).replace(/\*\*/g, '');
  const str = (x, n) => marks(String(x == null ? '' : x).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, n);

  /** AI の答え（JSON の文字）を、区切り 1 つぶんの結果に直す。読めない・中身が無いときは null */
  function parseChunk(raw) {
    let j;
    try { j = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw; } catch (e) { return null; }
    if (!j || typeof j !== 'object') return null;
    const points = (Array.isArray(j.points) ? j.points : []).map((p) => str(p, 300)).filter((p) => p.length >= 2).slice(0, 12);
    if (!points.length) return null;
    return {
      heading: str(j.heading, 40) || '（見出しなし）',
      points,
      terms: (Array.isArray(j.terms) ? j.terms : []).map((t) => ({ term: str(t && t.term, 40), desc: str(t && t.desc, 200) })).filter((t) => t.term && t.desc).slice(0, 5),
      qa: (Array.isArray(j.qa) ? j.qa : []).map((x) => ({ q: str(x && x.q, 200), a: str(x && x.a, 200) })).filter((x) => x.q && x.a).slice(0, 3),
    };
  }
  function parseOverview(raw) {
    let j;
    try { j = typeof raw === 'string' ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) : raw; } catch (e) { return null; }
    if (!j || typeof j !== 'object') return null;
    const overview = (Array.isArray(j.overview) ? j.overview : []).map((p) => str(p, 200)).filter((p) => p.length >= 2).slice(0, 6);
    return { title: str(j.title, 30), overview };
  }

  /** 箇条書きの 1 行（先頭の「- ・」は、こちらで付けるので、AI が付けていたら外す） */
  const bullet = (p) => '- ' + p.replace(/^[-・*•]\s*/, '');

  /** 区切りごとの結果から、ノート本文を組み立てる。
   *  parts：[{ heading, points, terms, qa } | null（作れなかった区切り）]。
   *  opts：{ title, overview: [行], partial: 途中まで（タイトルに「途中まで」と付ける）, skipped: 作れなかった区切りの番号の一覧（1 始まり） } */
  function build(parts, opts) {
    opts = opts || {};
    const ok = parts.filter(Boolean);
    const lines = ['# ' + (opts.title || '教材まとめ') + (opts.partial ? '（途中まで）' : ''), ''];
    if (opts.overview && opts.overview.length) lines.push('## 概要', ...opts.overview.map(bullet), '');
    lines.push('## 内容の整理');
    parts.forEach((p, i) => {
      if (!p) { lines.push('', '### （区切り ' + (i + 1) + ' は、作れませんでした）', '- （要確認）'); return; }
      lines.push('', '### ' + p.heading, ...p.points.map(bullet));
    });
    // 用語：同じ用語は、最初のものだけ。確認問題：最大 10 組（各区切りから順番に取る）
    const seen = new Set(), terms = [];
    for (const p of ok) for (const t of p.terms) { const k = t.term.toLowerCase(); if (!seen.has(k)) { seen.add(k); terms.push(t.term + ' :: ' + t.desc); } }
    if (terms.length) lines.push('', '## 用語', ...terms);
    const qa = [];
    for (let r = 0; qa.length < 10; r++) {
      let any = false;
      for (const p of ok) { if (p.qa[r] && qa.length < 10) { qa.push(p.qa[r]); any = true; } }
      if (!any) break;
    }
    if (qa.length) lines.push('', '## 確認問題', ...qa.map((x) => 'Q: ' + x.q + '\nA: ' + x.a));
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  /** 最後の「概要」の材料：各区切りの見出しと、最初の要点（短く） */
  function overviewSource(parts) {
    return parts.filter(Boolean).map((p, i) => (i + 1) + '. ' + p.heading + '：' + p.points[0]).join('\n').slice(0, 2500);
  }

  /** 残り時間の見込み（秒）：これまでの 1 区切りあたりの平均 × 残りの区切り数（＋最後の概要の分） */
  function remainingSec(doneSecs, left, overviewSec) {
    if (!doneSecs.length) return null;
    const avg = doneSecs.reduce((a, b) => a + b, 0) / doneSecs.length;
    return Math.round(avg * left + (overviewSec != null ? overviewSec : avg * 0.7));
  }

  LN.chunks = { MAX_CHARS, split, CHUNK_SCHEMA, OVERVIEW_SCHEMA, parseChunk, parseOverview, build, overviewSource, remainingSec };
})(typeof window !== 'undefined' ? window : globalThis);
