/* 授業教材の読み取り（PowerPoint / Word / PDF / 画像 / 動画 / 字幕 / テキスト）。すべてこの端末の中で処理する。
   結果は Claude API のコンテンツブロック形式（text / image / document）で返す。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});

  const LIMITS = { totalBytes: 28 * 1024 * 1024, pdfBytes: 30 * 1024 * 1024, images: 14, videoFrames: 24, entryBytes: 60 * 1024 * 1024, xmlBytes: 24 * 1024 * 1024, minStep: 10 };
  const IMG_EDGE = 1568;
  const KINDS = {
    pdf: ['pdf'], pptx: ['pptx'], docx: ['docx'], image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
    video: ['mp4', 'webm', 'mov', 'm4v', 'ogv'], audio: ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'opus'], subs: ['srt', 'vtt'], text: ['txt', 'md', 'markdown', 'csv', 'tsv', 'json'],
  };
  const extOf = (n) => { const m = /\.([a-z0-9]+)$/i.exec(n || ''); return m ? m[1].toLowerCase() : ''; };
  const kindOf = (name) => { const e = extOf(name); return Object.keys(KINDS).find((k) => KINDS[k].includes(e)) || null; };
  const ACCEPT = Object.values(KINDS).flat().map((e) => '.' + e).join(',');

  /* ---------- ZIP（PPTX / DOCX は ZIP） ---------- */
  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function openZip(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('ZIP 形式として読めません（ファイルが壊れているか、パスワード付きです）');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let k = 0; k < count && dv.getUint32(off, true) === 0x02014b50; k++) {
      const nlen = dv.getUint16(off + 28, true), elen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      entries.set(dec.decode(buf.subarray(off + 46, off + 46 + nlen)), {
        method: dv.getUint16(off + 10, true), csize: dv.getUint32(off + 20, true), usize: dv.getUint32(off + 24, true), lho: dv.getUint32(off + 42, true),
      });
      off += 46 + nlen + elen + clen;
    }
    async function read(name, maxBytes) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.csize === 0xffffffff || e.usize === 0xffffffff) throw new Error('大きすぎる ZIP（ZIP64）には対応していません');
      if (e.usize > (maxBytes || LIMITS.entryBytes)) throw new Error('ファイル内の要素が大きすぎます: ' + name);
      const lo = e.lho, dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const raw = buf.subarray(dataStart, dataStart + e.csize);
      if (e.method === 0) return raw;
      if (e.method === 8) return inflateRaw(raw);
      throw new Error('未対応の圧縮方式です');
    }
    const readText = async (name) => { const b = await read(name, LIMITS.xmlBytes); return b ? new TextDecoder('utf-8').decode(b) : null; };
    return { names: Array.from(entries.keys()), has: (n) => entries.has(n), read, readText };
  }

  /* ---------- XML の簡易テキスト抽出（DOM 不要） ---------- */
  const decodeXml = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
  });

  /** <a:p>…</a:p> ごとに、<a:t> の連結テキストを段落として返す */
  function paragraphs(xml, pTag, tTag) {
    const out = [];
    const pRe = new RegExp('<' + pTag + '[\\s>][\\s\\S]*?</' + pTag + '>', 'g');
    const tRe = new RegExp('<(' + tTag + '|a:br|w:br|w:tab)(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</' + tTag + '>)', 'g');
    for (const p of xml.match(pRe) || []) {
      let line = '', m;
      tRe.lastIndex = 0;
      while ((m = tRe.exec(p))) line += m[1] === tTag ? decodeXml(m[2] || '') : m[1] === 'w:tab' ? '\t' : '\n';
      if (line.trim()) out.push(line.replace(/\s+$/, ''));
    }
    return out;
  }

  const num = (n) => parseInt(/(\d+)/.exec(n)[1], 10);

  async function pptxContent(zip) {
    const slideNames = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => num(a) - num(b));
    if (!slideNames.length) throw new Error('スライドが見つかりません');
    const slides = [], images = [];
    let noteCount = 0;
    for (const sn of slideNames) {
      const no = num(sn.split('/').pop());
      const xml = await zip.readText(sn);
      const relName = 'ppt/slides/_rels/slide' + no + '.xml.rels';
      const rels = (await zip.readText(relName)) || '';
      let notes = [];
      const nm = /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels);
      if (nm) {
        const nx = await zip.readText('ppt/notesSlides/' + nm[1]);
        if (nx) {
          // ノート欄の本文プレースホルダのみ（スライド番号などを除く）
          const body = (nx.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []).filter((sp) => /type="body"/.test(sp)).join('');
          notes = paragraphs(body, 'a:p', 'a:t');
          if (notes.length) noteCount++;
        }
      }
      const imgs = [];
      for (const m of rels.matchAll(/Target="\.\.\/media\/([^"]+)"/g)) imgs.push('ppt/media/' + m[1]);
      let title = '';
      const paras = [];
      for (const sp of xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || []) {
        const ps = paragraphs(sp, 'a:p', 'a:t');
        if (!ps.length) continue;
        if (!title && /<p:ph[^>]*type="(title|ctrTitle)"/.test(sp)) title = ps.join(' '); else paras.push(...ps);
      }
      for (const tbl of xml.match(/<a:tbl>[\s\S]*?<\/a:tbl>/g) || []) {
        for (const tr of tbl.match(/<a:tr[\s>][\s\S]*?<\/a:tr>/g) || []) {
          const cells = (tr.match(/<a:tc[\s>][\s\S]*?<\/a:tc>/g) || []).map((tc) => paragraphs(tc, 'a:p', 'a:t').join(' '));
          if (cells.some((c) => c.trim())) paras.push('表: ' + cells.join(' | '));
        }
      }
      slides.push({ no, title, paras, notes, imgs });
      for (const p of imgs) if (!images.some((x) => x.path === p)) images.push({ path: p, slide: no });
    }
    return { slides, images, noteCount };
  }

  function slidesToText(slides) {
    return slides.map((s) => {
      let t = '## スライド' + s.no + (s.title ? '：' + s.title : '') + '\n' + s.paras.map((p) => '- ' + p.replace(/\n/g, ' / ')).join('\n');
      if (s.notes.length) t += '\n（発表者ノート）' + s.notes.join(' ');
      return t.trim();
    }).join('\n\n');
  }

  async function docxText(zip) {
    const xml = await zip.readText('word/document.xml');
    if (!xml) throw new Error('Word 文書として読めません');
    const lines = [];
    for (const p of xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || []) {
      const style = /<w:pStyle w:val="([^"]+)"/.exec(p);
      const heading = style && /^(Heading|見出し|heading)\s*(\d)/.exec(style[1]);
      const text = paragraphs(p, 'w:p', 'w:t').join('');
      if (!text.trim()) continue;
      lines.push(heading ? '#'.repeat(Math.min(4, +heading[2] + 1)) + ' ' + text : text);
    }
    return lines.join('\n');
  }

  /* ---------- 字幕 / テキスト ---------- */
  function parseSubs(text) {
    const lines = text.replace(/\r/g, '').split('\n');
    const out = [];
    let cur = null;
    for (const raw of lines) {
      const tm = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,]\d{1,3}\s*-->/.exec(raw.trim());
      if (tm) { cur = ((+tm[1] || 0) * 60 + +tm[2]) + ':' + tm[3]; continue; }
      const t = raw.replace(/<[^>]+>/g, '').trim();
      if (!t || /^\d+$/.test(t) || /^WEBVTT|^NOTE\b|^STYLE\b/.test(t)) continue;
      if (cur) out.push('[' + cur + '] ' + t);
    }
    // 同じ分にまとめて読みやすく
    const byMin = new Map();
    for (const l of out) { const m = /^\[(\d+):\d+\] (.*)$/.exec(l); const k = m[1]; byMin.set(k, (byMin.get(k) ? byMin.get(k) + ' ' : '') + m[2]); }
    return Array.from(byMin, ([k, v]) => '[' + k + '分] ' + v).join('\n');
  }

  /* ---------- 画像 ---------- */
  const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

  async function imageBlock(blob, mediaType) {
    let bmp;
    try { bmp = await createImageBitmap(blob); } catch (e) { return null; }
    const { width, height } = bmp;
    if (width < 64 || height < 64) { bmp.close(); return null; }
    const k = Math.min(1, IMG_EDGE / Math.max(width, height));
    if (k === 1 && blob.size < 400 * 1024 && /^image\/(png|jpeg|webp|gif)$/.test(mediaType)) {
      bmp.close();
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: (await blobToDataUrl(blob)).split(',')[1] } };
    }
    const c = document.createElement('canvas');
    c.width = Math.round(width * k); c.height = Math.round(height * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] } };
  }

  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

  /* ---------- 動画：代表フレームの抽出（音声の文字起こしは行わない） ---------- */
  const fmtTime = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  async function videoFrames(file, onProgress) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true; v.src = url;
    try {
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('この動画は読み込めません（mp4 / webm を推奨）')); });
      if (!isFinite(v.duration)) { // 録画由来の webm などは長さ情報が無いため、末尾へシークして長さを確定させる
        v.currentTime = 1e7;
        await new Promise((res) => { const to = setTimeout(res, 8000); v.onseeked = v.ondurationchange = () => { if (isFinite(v.duration)) { clearTimeout(to); res(); } }; });
        v.currentTime = 0;
      }
      const dur = v.duration;
      if (!isFinite(dur) || dur <= 0) throw new Error('動画の長さを取得できません');
      const step = Math.max(LIMITS.minStep, dur / 160);
      const times = [];
      for (let t = Math.min(2, dur / 4); t < dur; t += step) times.push(t);
      const small = document.createElement('canvas'); small.width = 48; small.height = 27;
      const sg = small.getContext('2d', { willReadFrequently: true });
      const scale = Math.min(1, 1280 / (v.videoWidth || 1280));
      const big = document.createElement('canvas'); big.width = Math.round((v.videoWidth || 1280) * scale); big.height = Math.round((v.videoHeight || 720) * scale);
      const bg = big.getContext('2d');
      const kept = [];
      let last = null;
      for (let i = 0; i < times.length; i++) {
        v.currentTime = times[i];
        await new Promise((res) => { const to = setTimeout(res, 8000); v.onseeked = () => { clearTimeout(to); res(); }; });
        sg.drawImage(v, 0, 0, 48, 27);
        const px = sg.getImageData(0, 0, 48, 27).data;
        let diff = 1e9;
        if (last) { diff = 0; for (let j = 0; j < px.length; j += 4) diff += Math.abs(px[j] - last[j]) + Math.abs(px[j + 1] - last[j + 1]) + Math.abs(px[j + 2] - last[j + 2]); diff /= (px.length / 4) * 3; }
        if (diff > 5) {
          bg.drawImage(v, 0, 0, big.width, big.height);
          kept.push({ t: times[i], data: big.toDataURL('image/jpeg', 0.8).split(',')[1] });
          last = px;
        }
        if (onProgress) onProgress((i + 1) / times.length);
      }
      let pick = kept;
      if (kept.length > LIMITS.videoFrames) pick = Array.from({ length: LIMITS.videoFrames }, (_, i) => kept[Math.round(i * (kept.length - 1) / (LIMITS.videoFrames - 1))]);
      return { frames: pick, duration: dur, candidates: times.length, changes: kept.length };
    } finally { URL.revokeObjectURL(url); v.removeAttribute('src'); v.load(); }
  }

  /** 動画・音声の長さ（秒）。取得できなければ 0 */
  async function mediaDuration(file, tag) {
    const url = URL.createObjectURL(file), el = document.createElement(tag);
    el.preload = 'metadata'; el.src = url;
    try {
      await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = rej; setTimeout(rej, 8000); });
      if (!isFinite(el.duration)) { el.currentTime = 1e7; await new Promise((res) => { const to = setTimeout(res, 5000); el.ondurationchange = () => { if (isFinite(el.duration)) { clearTimeout(to); res(); } }; }); }
      return isFinite(el.duration) ? el.duration : 0;
    } catch (e) { return 0; } finally { URL.revokeObjectURL(url); el.removeAttribute('src'); }
  }

  /** 音声・動画ファイルは、中身を読まずに「ファイルの場所（トークン）」だけ AI（Gemini）へ渡す */
  async function mediaBlocks(file, kind, head, tokens) {
    const B = root.lnDesktop;
    if (!B || !B.mediaToken) throw new Error('この形式は、デスクトップ版でだけ扱えます');
    const g = await B.mediaToken(file);
    if (!g) throw new Error('ファイルの場所を取得できませんでした。もう一度、ファイルを選び直してください。');
    const dur = await mediaDuration(file, kind === 'audio' ? 'audio' : 'video');
    const fps = kind === 'video' ? (dur > 3600 ? 0.1 : dur > 1200 ? 0.25 : 0.5) : undefined;
    const blocks = [{ type: 'text', text: head + '（' + (kind === 'audio' ? '音声' : '動画・映像と音声') + (dur ? '・' + fmtTime(dur) : '') + '）。次のファイルの内容（話している内容も）を読み取ってください。' }, { type: 'media', token: g.token, fps }];
    const warnings = [];
    if (g.size > 500 * 1024 * 1024) warnings.push('大きなファイルです。AI への送信に時間がかかります。');
    if (kind === 'video' && dur > 5400) warnings.push('長い動画です。無料枠の上限に達することがあります。音声だけのファイル（mp3/m4a）にすると軽くなります。');
    tokens.value = Math.round(dur * (kind === 'audio' ? 32 : 132));
    return { blocks, summary: (kind === 'audio' ? '音声' : '動画（映像＋音声）') + (dur ? ' ' + fmtTime(dur) : '') + '・' + Math.round(g.size / 1048576) + 'MB・AI にそのまま渡します', warnings };
  }

  /* ---------- 入口 ---------- */
  /** ファイル 1 件を解析して { name, kind, blocks, summary, warnings, bytes, approxTokens } を返す。
   *  opts: { media: 音声・動画をそのまま渡せる AI か, videoMode: 'frames' | 'full' } */
  async function extract(file, onProgress, opts) {
    opts = opts || {};
    const kind = kindOf(file.name);
    if (!kind) throw new Error('未対応の形式です（' + (extOf(file.name) || '拡張子なし') + '）');
    const warnings = [];
    const label = (t) => ({ type: 'text', text: t });
    const head = '【教材：' + file.name + '】';
    let blocks = [], summary = '', tokens = 0;

    if (kind === 'pdf') {
      if (file.size > LIMITS.pdfBytes) throw new Error('PDF が大きすぎます（' + Math.round(file.size / 1048576) + 'MB。上限 ' + (LIMITS.pdfBytes >> 20) + 'MB）。分割してください。');
      const data = (await blobToDataUrl(file)).split(',')[1];
      blocks = [label(head), { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }];
      const pages = (await file.slice(0, Math.min(file.size, 4e6)).text()).match(/\/Type\s*\/Page[^s]/g);
      summary = 'PDF' + (pages ? '（約' + pages.length + 'ページ以上）' : '');
      tokens = (pages ? pages.length : Math.round(file.size / 60000)) * 1800;
    } else if (kind === 'pptx') {
      const zip = openZip(new Uint8Array(await file.arrayBuffer()));
      const { slides, images, noteCount } = await pptxContent(zip);
      const text = slidesToText(slides);
      blocks = [label(head + '（PowerPoint・' + slides.length + '枚）\n' + text)];
      const cand = [];
      for (const im of images) {
        const ext = extOf(im.path);
        if (!MIME[ext] || !zip.has(im.path)) continue;
        try { const b = await zip.read(im.path); if (b.length >= 12 * 1024) cand.push({ ...im, ext, bytes: b }); } catch (e) { /* 読めない画像は飛ばす */ }
      }
      cand.sort((a, b) => b.bytes.length - a.bytes.length);
      let used = 0;
      for (const im of cand.slice(0, LIMITS.images).sort((a, b) => a.slide - b.slide)) {
        const blk = await imageBlock(new Blob([im.bytes], { type: MIME[im.ext] }), MIME[im.ext]);
        if (blk) { blocks.push(label('（スライド' + im.slide + ' の画像）'), blk); used++; }
      }
      if (cand.length > used) warnings.push('画像は大きいもの ' + used + ' 枚のみ使用（全 ' + cand.length + ' 枚）');
      summary = slides.length + '枚のスライド' + (noteCount ? '・発表者ノート' + noteCount + '件' : '') + (used ? '・画像' + used + '枚' : '');
      tokens = text.length / 1.3 + used * 1500;
    } else if (kind === 'docx') {
      const zip = openZip(new Uint8Array(await file.arrayBuffer()));
      const text = await docxText(zip);
      blocks = [label(head + '（Word）\n' + text)];
      summary = 'Word 文書（' + text.length + '文字）';
      tokens = text.length / 1.3;
    } else if (kind === 'image') {
      const blk = await imageBlock(file, MIME[extOf(file.name)]);
      if (!blk) throw new Error('画像を読み込めません');
      blocks = [label(head), blk];
      summary = '画像'; tokens = 1500;
    } else if (kind === 'subs' || kind === 'text') {
      let text = await file.text();
      if (kind === 'subs') text = parseSubs(text);
      if (text.length > 400000) throw new Error('テキストが大きすぎます（40万文字まで）');
      blocks = [label(head + (kind === 'subs' ? '（字幕・文字起こし）' : '') + '\n' + text)];
      summary = (kind === 'subs' ? '字幕' : 'テキスト') + '（' + text.length + '文字）';
      tokens = text.length / 1.3;
    } else if (kind === 'audio') {
      if (!opts.media) throw new Error('音声ファイルは、設定で「Google Gemini（無料）」を選ぶと文字起こしして読み取れます。');
      const tk = { value: 0 };
      const r = await mediaBlocks(file, 'audio', head, tk);
      blocks = r.blocks; summary = r.summary; warnings.push(...r.warnings); tokens = tk.value;
    } else if (kind === 'video' && opts.media && opts.videoMode === 'full') {
      const tk = { value: 0 };
      const r = await mediaBlocks(file, 'video', head, tk);
      blocks = r.blocks; summary = r.summary; warnings.push(...r.warnings); tokens = tk.value;
    } else if (kind === 'video') {
      const r = await videoFrames(file, onProgress);
      blocks = [label(head + '（動画・' + fmtTime(r.duration) + '。画面の切り替わりごとの代表フレームを ' + r.frames.length + ' 枚。音声は含まれません。）')];
      for (const f of r.frames) blocks.push(label('（動画 ' + fmtTime(f.t) + ' の画面）'), { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f.data } });
      summary = '動画 ' + fmtTime(r.duration) + '・代表フレーム' + r.frames.length + '枚';
      warnings.push('音声は文字起こしされません。話の内容も反映したい場合は、字幕(.srt/.vtt)や文字起こしテキストも一緒に追加してください。');
      if (!r.frames.length) warnings.push('画面の切り替わりを検出できませんでした');
      tokens = r.frames.length * 1500;
    }
    const bytes = blocks.reduce((s, b) => s + (b.text ? b.text.length * 3 : b.source ? b.source.data.length : 0), 0);
    return { name: file.name, kind, blocks, summary, warnings, bytes, approxTokens: Math.round(tokens) };
  }

  LN.materials = { ACCEPT, LIMITS, kindOf, extract, _test: { openZip, pptxContent, slidesToText, docxText, parseSubs, paragraphs } };
})(typeof window !== 'undefined' ? window : globalThis);
