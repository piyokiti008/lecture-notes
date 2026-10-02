/* AI アシスタント（拡張機能）: 教材→ノート / 図解 / プリントの依頼。
   通信はデスクトップ版のメインプロセスだけが行う（API キーは画面側から見えない）。ブラウザ版では無効。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const D = root.lnDesktop && root.lnDesktop.ai;
  const md = () => LN.md, sh = () => LN.sheets;

  const MODELS = [
    ['claude-opus-5', 'Claude Opus 5（高品質・標準）'],
    ['claude-sonnet-5', 'Claude Sonnet 5（速く、料金が安い）'],
    ['claude-haiku-4-5', 'Claude Haiku 4.5（最も安い・簡易）'],
  ];

  const ai = (LN.ai = { enabled: !!D, ready: false, keys: {}, MODELS });
  let U = null; // app.js の内部 API（LN.ui）

  /* ---------- プロンプト ---------- */
  const RULES_MARKUP = [
    '【このアプリの書き方（Markdown）】',
    '- 見出しは ## から使う。',
    '- 大事な語句・結論は ==語句== で囲む（考査対策の「重要ポイント」に自動で集まる）。',
    '- 用語は 1 行ずつ「用語 :: 説明」と書く（用語集・用語テストになる）。',
    '- 文中で覚えさせたい語は {{答え}} で囲む（穴埋め問題になる）。多用せず、1 文に 1〜2 個まで。',
    '- 確認問題は「Q: 問い」の次の行に「A: 答え」を書く。',
    '- 表は Markdown の表、数式は $x^2$ や $\\frac{a}{b}$ の形式で書く。',
    '- 図で示したい箇所は「（図解候補：〇〇）」と 1 行だけ書く。図そのものは書かない。',
  ].join('\n');

  const SVG_RULES = [
    '【SVG のルール】',
    '- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 高さ"> で始める。横幅は 800 を基準に、高さは内容に合わせる（最大 1000）。width/height 属性は書かない。',
    '- 使ってよい要素は g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan, defs, marker, linearGradient, radialGradient, stop のみ。script, style, image, foreignObject, 外部参照は使わない。',
    '- 文字は text 要素で、font-family="\'Yu Gothic\',\'Meiryo\',sans-serif"、font-size は 14 以上（本文 16、見出し 20）。日本語は自動で折り返されないので、長い文は tspan で行を分ける（1 行は全角 18 文字程度まで）。',
    '- 矢印は defs 内で marker を定義し、marker-end で付ける。',
    '- 文字と図形が重ならないよう、十分な余白をとる。文字が図形からはみ出さないよう、図形の大きさを文字数に合わせる。',
    '- 背景は白（背景の rect は不要）。配色は落ち着いた 2〜3 色と黒。色だけに頼らず、実線/破線や文字ラベルでも区別する。',
  ].join('\n');

  const SYS_MATERIALS = [
    'あなたは、大学の講義内容を整理し、学生が考査（試験）勉強に使えるノートを作る学習アシスタントです。',
    '【守ること】',
    '- 材料は、渡された教材（スライド、PDF、Word、画像、動画の代表フレーム、字幕）と、学生のノートだけです。書かれていないことを付け足さないでください。一般知識で補う場合は、その文の先頭に「（補足）」と付けます。',
    '- 読み取れない、または自信のない箇所は推測せず「（要確認）」と書きます。',
    '- 専門用語・固有名詞・数値・式は、教材のとおりに書きます。',
    '- 日本語で書きます。英語の用語は「日本語（English）」の形で併記します。',
    '- 学生のノートがある場合は、その内容と矛盾しないようにし、ノートにない重要点を補います。',
    RULES_MARKUP,
    '【出力の構成】',
    '最初の行は「# 」で始まるタイトル（30 字以内）。続けて次の見出しを順に書く。',
    '## 概要（3〜5 行）',
    '## 内容の整理（教材の流れに沿って。見出し・箇条書き・表を使う）',
    '## 用語（「用語 :: 説明」を 1 行ずつ）',
    '## 確認問題（「Q:」「A:」を 5〜10 組）',
    '出力は Markdown 本文だけにします。前置き・あとがき・全体を囲むコードフェンスは付けません。',
  ].join('\n');

  const LEVELS = { short: '簡潔に。全体で 600〜1200 字を目安に、要点だけをまとめる。', normal: '標準の詳しさで。全体で 1500〜3000 字を目安にする。', long: '詳しく。全体で 3000〜6000 字を目安に、理由や例も含める。' };

  const SYS_DIAGRAM = [
    'あなたは、大学の学習用の図解（SVG）を作るデザイナーです。学生の依頼と、参考文章の内容だけに基づいて図を作ります。文章に無い事実は足しません。',
    '出力は <svg ...> から </svg> までの SVG コードだけです。説明文・前置き・コードフェンスは付けません。',
    SVG_RULES,
  ].join('\n');

  const SYS_SHEET = [
    'あなたは、大学の考査（試験）対策プリントを作る教材作成者です。学生の依頼に従い、印刷して使うプリントの本文を Markdown で作ります。',
    '【材料と範囲】',
    '- 「学習範囲」に、学生のノートと単元まとめがあります。問題・解説は、その内容に基づかせます。範囲外の内容は出題しません。',
    '- 添付の教材（スライド・PDF など）がある場合は、それも材料です。',
    '- 材料にない事実を新たに作らない。不確かな箇所は出題しない。',
    '【出力ルール】',
    '- 出力はプリント本文の Markdown だけ（前置き・あとがき・全体を囲むコードフェンスは付けない）。',
    '- タイトルはアプリ側が付けるので、本文に「# 」見出しは書かない。大見出しは「## 」から。',
    '- 問題は番号付きリスト（1. 2. 3.）。選択肢は 1 行ずつ「ア. 」「① 」のように改行して書く。',
    '- 穴埋めは {{答え}} で書く。アプリが自動で空欄（番号つき）にし、解答一覧も作る。',
    '- 選択式・記述式など穴埋め以外の問題の解答と解説は、本文の最後に独立した行「=== 解答 ===」を置き、その後ろに問題番号順でまとめて書く。この行より前には解答を書かない。',
    '- 表は Markdown の表、数式は $x^2$ や $\\frac{a}{b}$ の形式で書く。',
    '- 図解が有効な箇所には、```svg のコードブロックで SVG を書いてよい（次のルールを守る）。',
    '- 配点や時間の目安を、最初に 1 行だけ書いてよい。',
    SVG_RULES,
  ].join('\n');

  /* ---------- AI の種類と設定 ---------- */
  const PROV = {
    gemini: { label: 'Google Gemini', tag: '無料', desc: '高品質。PDF・画像・音声・動画もそのまま読めます。1 日に使える回数に上限があり、送った内容が Google の製品改善に使われることがあります。' },
    ollama: { label: 'このPCで動かす（Ollama）', tag: '無料・オフライン', desc: '内容が PC の外に出ません。性能はこの PC 次第です（3〜7GB ほどの AI をダウンロードします）。' },
    anthropic: { label: 'Anthropic Claude', tag: '有料', desc: '最高品質。使った分だけ、ご自身のキーに課金されます。' },
    openai: { label: 'その他（OpenAI 互換）', tag: '接続先による', desc: 'Groq（無料枠あり）・OpenRouter・LM Studio など。' },
  };
  const PRESETS = { groq: ['Groq（無料枠あり）', 'https://api.groq.com/openai/v1'], openrouter: ['OpenRouter', 'https://openrouter.ai/api/v1'], lmstudio: ['LM Studio（この PC）', 'http://127.0.0.1:1234/v1'], custom: ['その他', ''] };
  const KEY_LINK = { gemini: 'https://aistudio.google.com/apikey', anthropic: 'https://console.anthropic.com/settings/keys', groq: 'https://console.groq.com/keys', openrouter: 'https://openrouter.ai/keys' };
  const RECOMMENDED = [['qwen3.5:4b', '標準（約 3.4GB・メモリ 8GB 以上）'], ['qwen3.5:2b', '軽量（約 2.7GB・メモリが少ない PC 向け）'], ['qwen3.5:9b', '高品質（約 6.6GB・メモリ 16GB 以上）']];

  function cfg() {
    const s = LN.state.settings, cur = s.ai || {};
    const d = {
      provider: '', consent: {}, anthropic: { model: 'claude-opus-5' }, gemini: { model: '' },
      ollama: { baseUrl: 'http://127.0.0.1:11434', model: '', vision: false, numCtx: 16384 }, openai: { preset: 'groq', baseUrl: PRESETS.groq[1], model: '', vision: false },
    };
    const old = cur.model && !cur.anthropic; // 旧形式（Claude 専用）からの移行
    const out = Object.assign({}, d, cur);
    for (const p of ['anthropic', 'gemini', 'ollama', 'openai']) out[p] = Object.assign({}, d[p], cur[p]);
    if (old) { out.anthropic.model = cur.model; out.consent = cur.consent === true ? { anthropic: true } : {}; }
    if (typeof out.consent !== 'object' || out.consent === null) out.consent = {};
    delete out.model;
    s.ai = out;
    return out;
  }

  function computeReady() {
    const c = cfg(), k = ai.keys || {};
    switch (c.provider) {
      case 'gemini': return !!(k.gemini && c.gemini.model);
      case 'anthropic': return !!k.anthropic;
      case 'ollama': return !!c.ollama.model;
      case 'openai': return !!(c.openai.baseUrl && c.openai.model);
      default: return false;
    }
  }
  ai.provider = () => cfg().provider;

  /* ---------- 実行（メインプロセスへの橋渡し） ---------- */
  let seq = 0;

  /** { done: Promise<{text, stopReason, usage}>, cancel() } */
  ai.run = function (o) {
    const id = 'r' + Date.now().toString(36) + '-' + ++seq;
    const c = cfg(), p = c.provider, pc = c[p] || {};
    let off = () => {};
    const done = (async () => {
      off = D.onEvent((ev) => {
        if (ev.id !== id) return;
        if (ev.type === 'text' && o.onText) o.onText(ev.text);
        else if (ev.type === 'status' && o.onStatus) o.onStatus(ev.status);
        else if (ev.type === 'note' && o.onNote) o.onNote(ev.text);
      });
      try {
        const r = await D.start(id, { provider: p, model: pc.model, system: o.system, messages: o.messages, maxTokens: o.maxTokens || 32000, config: { baseUrl: pc.baseUrl, vision: pc.vision, numCtx: pc.numCtx } });
        if (r && r.error) { const e = new Error(r.error.message); e.kind = r.error.kind; throw e; }
        return r;
      } finally { off(); }
    })();
    return { done, cancel: () => D.cancel(id) };
  };

  /* ---------- 共通 UI ---------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => md().esc(s);
  const opt = (list, cur) => list.map((x) => '<option value="' + x[0] + '"' + (x[0] === cur ? ' selected' : '') + '>' + esc(x[1]) + '</option>').join('');
  const statText = (s, thinking, writing) => (s === 'uploading' ? 'ファイルを AI に送信しています…（大きいほど時間がかかります）' : s === 'thinking' ? thinking : writing);

  async function refreshStatus() {
    if (!D) return;
    try { ai.keys = (await D.status()).keys; } catch (e) { ai.keys = {}; }
    const c = cfg();
    if (!c.provider && ai.keys.anthropic) { c.provider = 'anthropic'; LN.save(); } // 以前に Claude のキーを登録済みなら、そのまま使う
    ai.ready = computeReady();
    if (U) U.renderSidebar();
  }

  const consentText = {
    ollama: 'このパソコンの中で動く AI を使います。教材・ノート・依頼文は、<b>外部へ送信されません</b>。<br>AI の出力には誤りが含まれることがあります。必ず内容を確認してください。',
    gemini: 'あなたが選んだ教材・ノート・依頼文が、<b>Google（Gemini）へ送信</b>されます。<br>・無料枠のため、料金はかかりません（回数の上限あり）。<br>・無料枠では、送信内容が Google の製品改善に使われたり、人が確認する場合があります。個人情報や機密は含めないでください。<br>・この内容が、このアプリの作者や他のユーザーに届くことはありません。<br>・AI の出力には誤りが含まれることがあります。必ず確認してください。',
    anthropic: 'あなたが選んだ教材・ノート・依頼文が、<b>Anthropic（api.anthropic.com）へ送信</b>されます。<br>・料金は、登録したあなた自身の API キーに課金されます。<br>・この内容が、このアプリの作者や他のユーザーに届くことはありません。<br>・AI の出力には誤りが含まれることがあります。必ず確認してください。',
    openai: 'あなたが選んだ教材・ノート・依頼文が、<b>設定した接続先へ送信</b>されます。接続先の利用条件（料金・データの扱い）をご確認ください。<br>AI の出力には誤りが含まれることがあります。必ず確認してください。',
  };

  /** 設定が済んでいて、初回は送信内容の確認を出してから true を返す */
  async function ensureReady() {
    if (!D) { openSettings(); return false; }
    await refreshStatus();
    if (!ai.ready) { U.toast('先に AI の設定をしてください'); openSettings(); return false; }
    const c = cfg(), p = c.provider;
    if (!c.consent[p]) {
      const ok = await U.ask({ title: 'AI に送信する内容の確認', ok: '同意して続ける', message: consentText[p] });
      if (!ok) return false;
      c.consent[p] = true; LN.save();
    }
    return true;
  }

  const ERR_HINT = { auth: '（設定で API キーを確認してください）', rate: '', too_large: '（教材を減らすか、分けてください）', model_missing: '', network: '' };
  const errText = (e) => (e && e.message ? e.message : String(e)) + (e && ERR_HINT[e.kind] ? ERR_HINT[e.kind] : '');

  /** 生成途中の未完成コードブロックを隠す（図の途中でエラー表示にならないように） */
  function partialSafe(t) {
    const fences = (t.match(/^\s*```/gm) || []).length;
    if (fences % 2 === 0) return t;
    const i = t.lastIndexOf('```');
    return t.slice(0, i) + '\n\n（図を作成中…）';
  }

  function throttle(fn, ms) {
    let t = 0, pending = false;
    return () => {
      if (pending) return;
      const wait = Math.max(0, ms - (Date.now() - t));
      pending = true;
      setTimeout(() => { pending = false; t = Date.now(); fn(); }, wait);
    };
  }

  /* ---------- 設定ダイアログ ---------- */
  function geminiDefault(models) {
    const ver = (m) => parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(m.id) || [0, 0])[1]);
    const flash = models.filter((m) => /flash/.test(m.id) && !/lite/.test(m.id)).sort((a, b) => ver(b) - ver(a));
    const lite = models.filter((m) => /flash-lite/.test(m.id)).sort((a, b) => ver(b) - ver(a));
    return (flash[0] || lite[0] || models[0] || {}).id || '';
  }

  async function openSettings() {
    if (!D) {
      U.ask({
        title: 'AI アシスタント', hideCancel: false, cancelText: '閉じる', hideOk: true,
        body: '<div class="ai-note">AI 機能（教材からノートを作る・図解を作る・プリントを依頼する）は、<b>デスクトップアプリ版</b>で使えます。<br>' +
          'ブラウザ版では、API キーを安全に保管し、通信をアプリ側だけに限定することができないためです。</div>',
      });
      return;
    }
    await refreshStatus();
    U.ask({
      title: 'AI アシスタントの設定', wide: true, hideOk: true, cancelText: '閉じる',
      body: '<div class="ai-note"><b>費用について：</b>このアプリ自体は無料で、作者が費用を負担する仕組み（共通のキーやサーバー）はありません。' +
        '<b>「無料」の AI を選べば、利用料はかかりません。</b>キーもデータも、あなたの PC の中だけで管理されます。</div>' +
        '<div class="prov-grid" id="provGrid"></div><div id="provPanel"></div><div class="ai-status" id="aiSetStatus"></div>',
      onOpen(form) {
        const say = (t, bad, spin) => { const s = $('#aiSetStatus', form); s.innerHTML = (spin ? '<span class="ai-spin"></span>' : '') + esc(t || ''); s.style.color = bad ? 'var(--danger)' : 'var(--text-2)'; };
        const save = () => { LN.save(); ai.ready = computeReady(); U.renderSidebar(); };
        const keyBlock = (p, linkKey, label) => '<div class="dlg-field"><label class="l">API キー <span>' + (ai.keys[p] ? '（登録済み）' : '（未登録）') + '</span></label>' +
          '<div style="display:flex;gap:6px"><input type="password" id="kKey" autocomplete="off" placeholder="' + (p === 'anthropic' ? 'sk-ant-...' : 'キーを貼り付け') + '" style="flex:1"><button type="button" class="btn primary" data-a="savekey" data-p="' + p + '">保存</button>' +
          (ai.keys[p] ? '<button type="button" class="btn ghost" data-a="clearkey" data-p="' + p + '" style="color:var(--danger)">削除</button>' : '') + '</div>' +
          (KEY_LINK[linkKey] ? '<div class="opt-note" style="margin-top:4px"><button type="button" class="btn sm" data-a="open" data-url="' + KEY_LINK[linkKey] + '">' + esc(label) + '</button> ← キーを作るページを開きます</div>' : '') + '</div>';
        const modelBlock = (id, list) => '<div class="dlg-field"><label class="l">使うモデル</label><div style="display:flex;gap:6px"><input type="text" id="kModel" list="kModels" value="' + esc(cfg()[id].model) + '" placeholder="モデル名" autocomplete="off" style="flex:1">' +
          '<datalist id="kModels">' + list.map((m) => '<option value="' + esc(m.id) + '">' + esc(m.label) + '</option>').join('') + '</datalist><button type="button" class="btn" data-a="models">一覧を更新</button></div></div>';

        let models = [];
        const panel = $('#provPanel', form);

        async function loadModels(quiet) {
          const p = cfg().provider;
          if (!quiet) say('モデルの一覧を取得しています…', false, true);
          const r = await D.models(p, cfg()[p]);
          if (!r.ok) { models = []; if (!quiet || p === 'ollama') say(r.error.message, true); return; }
          models = r.models;
          const c = cfg();
          if (p === 'gemini' && !c.gemini.model) { c.gemini.model = geminiDefault(models); save(); }
          if (p === 'ollama' && !c.ollama.model && models.length) { c.ollama.model = models[0].id; save(); }
          if (!quiet) say(models.length + ' 件のモデルが見つかりました。');
          renderPanel(true);
        }

        function renderGrid() {
          const cur = cfg().provider;
          $('#provGrid', form).innerHTML = Object.keys(PROV).map((p) => '<button type="button" class="prov-card' + (cur === p ? ' on' : '') + '" data-a="pick" data-p="' + p + '"><b>' + esc(PROV[p].label) +
            '</b><span class="prov-tag ' + (/無料/.test(PROV[p].tag) ? 'free' : '') + '">' + esc(PROV[p].tag) + '</span><small>' + esc(PROV[p].desc) + '</small></button>').join('');
        }

        function renderPanel(keepModels) {
          const c = cfg(), p = c.provider;
          if (!p) { panel.innerHTML = '<div class="opt-note" style="padding:8px 2px">使う AI を選んでください。迷ったら、無料で高品質な <b>Google Gemini</b> がおすすめです（Google アカウントがあれば、数分で使い始められます）。</div>'; return; }
          let h = '';
          if (p === 'gemini') {
            h = '<div class="ai-note"><b>無料で使う手順</b>：① 下のボタンで「Google AI Studio」を開き、Google アカウントで API キーを作成 → ② 表示されたキーを貼り付けて「保存」。クレジットカードは不要です。<br>' +
              '無料枠では、送信内容が Google の製品改善に使われる場合があります。個人情報・機密は送らないでください。</div>' + keyBlock('gemini', 'gemini', 'Google AI Studio を開く') + modelBlock('gemini', models) +
              '<div class="opt-note">「lite」が付くモデルは、無料で使える回数が多めです。回数の上限に達したら、少し待つか、liteのモデルに切り替えてください。</div>';
          } else if (p === 'ollama') {
            const o = c.ollama;
            h = '<div class="ai-note"><b>完全無料・オフライン</b>：内容がこの PC の外へ出ません。まず <b>Ollama</b> をインストールして起動し、AI モデルをダウンロードします（下記）。</div>' +
              '<div class="ai-status" id="olStatus"><span class="ai-spin"></span>Ollama を確認しています…</div>' +
              '<div id="olBody"></div>';
          } else if (p === 'anthropic') {
            h = keyBlock('anthropic', 'anthropic', 'Anthropic コンソールを開く') + '<div class="dlg-field"><label class="l">使うモデル</label><select id="kModelSel">' + opt(MODELS.map((m) => [m.id, m.label]), c.anthropic.model) + '</select></div>' +
              '<div class="opt-note">有料です。使った分だけ、このキーのアカウントに課金されます。</div>';
          } else {
            const o = c.openai;
            h = '<div class="dlg-field"><label class="l">接続先のサービス</label><select id="kPreset">' + opt(Object.keys(PRESETS).map((k) => [k, PRESETS[k][0]]), o.preset) + '</select></div>' +
              '<div class="dlg-field"><label class="l">接続先のアドレス（https:// か、この PC 内の http://localhost…）</label><input type="text" id="kBase" value="' + esc(o.baseUrl) + '" autocomplete="off"></div>' +
              keyBlock('openai', o.preset, 'キーを作るページを開く') + modelBlock('openai', models) +
              '<label class="check"><input type="checkbox" id="kVision"' + (o.vision ? ' checked' : '') + '> 画像も送る（画像に対応したモデルのときだけ）</label>';
          }
          h += '<div style="display:flex;gap:8px;margin-top:6px"><button type="button" class="btn primary" data-a="test">接続テスト</button></div>';
          panel.innerHTML = h;
          if (p === 'ollama') renderOllama();
        }

        async function renderOllama() {
          const c = cfg(), o = c.ollama;
          const st = await D.ollamaStatus(o), el = $('#olStatus', form), body = $('#olBody', form);
          if (!el) return;
          if (!st.running) {
            el.innerHTML = '<span style="color:var(--danger)">Ollama が起動していません。</span>';
            body.innerHTML = '<div class="opt-note">① <button type="button" class="btn sm" data-a="open" data-url="https://ollama.com/download">Ollama をダウンロード</button>（インストールして起動） → ② このボタンで再確認：<button type="button" class="btn sm" data-a="olrecheck">もう一度確認</button></div>';
            return;
          }
          el.innerHTML = '<span style="color:var(--ok)">Ollama は起動しています（v' + esc(st.version) + '）。</span>';
          const r = await D.models('ollama', o);
          models = r.ok ? r.models : [];
          if (!o.model && models.length) { o.model = models[0].id; save(); }
          body.innerHTML = (models.length
            ? '<div class="dlg-field"><label class="l">使うモデル（ダウンロード済み）</label><select id="kModelSel">' + opt(models.map((m) => [m.id, m.label]), o.model) + '</select></div>' +
              '<div class="ai-grid"><label class="check"><input type="checkbox" id="kVision"' + (o.vision ? ' checked' : '') + '> 画像も送る（画像対応モデルのみ）</label>' +
              '<div><select id="kNumCtx">' + opt([[8192, '短め（8K・軽い）'], [16384, '標準（16K）'], [32768, '長め（32K・メモリを多く使う）']], String(o.numCtx)) + '</select></div></div>'
            : '<div class="opt-note">ダウンロード済みのモデルがありません。下から選んでダウンロードしてください。</div>') +
            '<div class="dlg-field"><label class="l">モデルをダウンロード（この PC に保存されます）</label>' + RECOMMENDED.map((m) => '<div style="display:flex;gap:8px;align-items:center;margin:4px 0"><button type="button" class="btn sm" data-a="pull" data-model="' + m[0] + '">ダウンロード</button><span style="font-size:12.5px"><b>' + m[0] + '</b>　' + esc(m[1]) + '</span></div>').join('') +
            '<div class="ai-status" id="olPull"></div></div>' +
            '<div class="opt-note">小型モデルは、クラウドの AI より、まとめ・図解の品質が下がることがあります。長い教材は、コンテキスト長を大きくしてください。</div>';
        }

        form.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-a]');
          if (!b) return;
          const a = b.dataset.a, c = cfg();
          if (a === 'pick') { c.provider = b.dataset.p; models = []; save(); renderGrid(); renderPanel(); say(''); if (c.provider === 'gemini' && ai.keys.gemini) loadModels(true); if (c.provider === 'openai' && c.openai.model === '' && ai.keys.openai) loadModels(true); }
          else if (a === 'open') root.lnDesktop.openExternal(b.dataset.url);
          else if (a === 'savekey') {
            const inp = $('#kKey', form), r = await D.setKey(b.dataset.p, inp.value.trim());
            if (r.ok) { inp.value = ''; say('API キーを保存しました。'); await refreshStatus(); renderPanel(); if (b.dataset.p === 'gemini') loadModels(); } else say(r.error, true);
          } else if (a === 'clearkey') { await D.clearKey(b.dataset.p); await refreshStatus(); renderPanel(); say('API キーを削除しました。'); }
          else if (a === 'models') { c[c.provider].model = ($('#kModel', form) || {}).value || c[c.provider].model; save(); loadModels(); }
          else if (a === 'olrecheck') renderOllama();
          else if (a === 'test') {
            const p = c.provider;
            const model = ($('#kModel', form) || $('#kModelSel', form) || {}).value || c[p].model;
            if (!model) { say('先にモデルを選んでください。', true); return; }
            c[p].model = model; save();
            say('接続を確認しています…', false, true);
            const r = await D.test(p, c[p]);
            say(r.ok ? '接続できました。この AI を使えます。' : r.error.message, !r.ok);
          } else if (a === 'pull') {
            const model = b.dataset.model, pid = 'pull-' + Date.now(), el = $('#olPull', form);
            const off = D.onEvent((ev) => {
              if (ev.id !== pid || ev.type !== 'pull') return;
              el.innerHTML = '<span class="ai-spin"></span>' + esc(ev.status) + (ev.total ? '　' + Math.round(ev.completed / ev.total * 100) + '%（' + (ev.completed / 1073741824).toFixed(2) + ' / ' + (ev.total / 1073741824).toFixed(2) + ' GB）' : '');
            });
            el.innerHTML = '<span class="ai-spin"></span>ダウンロードを開始しています…';
            const r = await D.ollamaPull(pid, { baseUrl: c.ollama.baseUrl, model });
            off();
            if (r.ok) { c.ollama.model = model; save(); say(model + ' をダウンロードしました。'); renderOllama(); } else { el.textContent = ''; say(r.error.message, true); }
          }
        });
        form.addEventListener('change', (e) => {
          const c = cfg(), t = e.target, p = c.provider;
          if (t.id === 'kModelSel') { c[p].model = t.value; save(); }
          else if (t.id === 'kModel') { c[p].model = t.value.trim(); save(); }
          else if (t.id === 'kVision') { c[p].vision = t.checked; save(); }
          else if (t.id === 'kNumCtx') { c.ollama.numCtx = parseInt(t.value, 10); save(); }
          else if (t.id === 'kBase') { c.openai.baseUrl = t.value.trim(); save(); }
          else if (t.id === 'kPreset') { c.openai.preset = t.value; if (PRESETS[t.value][1]) c.openai.baseUrl = PRESETS[t.value][1]; save(); models = []; renderPanel(); }
        });
        renderGrid();
        renderPanel();
        const c0 = cfg();
        if (c0.provider === 'gemini' && ai.keys.gemini) loadModels(true);
      },
    });
  }

  /* ---------- 教材 → ノート / まとめ ---------- */
  function unitScope(spec) {
    const st = LN.state;
    if (spec.fromNote) {
      const n = U.curNote();
      if (!n) return null;
      const unit = st.units.find((u) => u.id === n.unitId) || null;
      return { subject: st.subjects.find((s) => s.id === n.subjectId), unit, notes: st.notes.filter((x) => x.subjectId === n.subjectId && (x.unitId || null) === (n.unitId || null)), currentNote: n };
    }
    const g = U.unitFromKey(spec.key);
    if (!g) return null;
    const sid = g.unit ? g.unit.subjectId : spec.key.slice(sh().NONE.length);
    return { subject: st.subjects.find((s) => s.id === sid), unit: g.unit, notes: g.notes };
  }

  const scopeText = (sc) => sc.notes.map((n) => '## ノート：' + (n.title || '無題') + '\n' + String(n.body || '').replace(/!\[[^\]]*\]\(img:[a-z0-9]+\)/g, '（画像）').trim()).join('\n\n');

  async function openMaterials(spec) {
    const sc = unitScope(spec);
    if (!sc || !sc.subject) { U.toast('対象のノートまたは単元を選んでください'); return; }
    if (!(await ensureReady())) return;
    const M = LN.materials;
    const items = []; // { file, status, res, err }
    let job = null, result = '', busy = false, finalMsg = '';
    const aiNotes = []; // AI 側からの通知（画像を送らなかった、など）

    const targets = [['note', '新しいノートとして保存（おすすめ）']];
    if (sc.unit) targets.push(['append', '単元まとめの末尾に追加'], ['replace', '単元まとめを置き換える']);

    const dlgPromise = U.ask({
      title: '教材から、まとめを作る', wide: true, hideOk: true, cancelText: '閉じる',
      body: '<div class="ai-note">「' + esc(sc.subject.name) + '」' + (sc.unit ? '／「' + esc(sc.unit.name) + '」' : '') + ' のノートを作ります。教材（PowerPoint・PDF・Word・画像・動画・字幕・テキスト）を追加してください。ファイルはこのパソコンの中で読み取り、「生成する」を押したときだけ AI に送信されます。</div>' +
        '<div class="ai-drop" id="mDrop">ここにファイルをドラッグ＆ドロップ、または <button type="button" class="btn sm" id="mPick">ファイルを選ぶ</button><br><span style="font-size:11.5px;color:var(--text-3)">' + (ai.provider() === 'gemini' ? '音声（mp3・m4a など）と動画は、話している内容も読み取れます（Gemini）。' : '動画は、画面の切り替わりごとの画像を取り出します（音声は文字起こししません。字幕 .srt/.vtt を一緒に追加すると話の内容も反映できます）。') + '</span></div>' +
        (ai.provider() === 'gemini' ? '<div class="dlg-field"><label class="l">動画の扱い（先に選んでから追加してください）</label><select id="mVideo">' + opt([['full', '映像と音声をそのまま Gemini に渡す（話の内容も反映・おすすめ）'], ['frames', '画面の代表フレームだけ（軽い・音声は読まない）']], 'full') + '</select></div>' : '') +
        '<input type="file" id="mFile" multiple accept="' + M.ACCEPT + '" hidden><div class="ai-files" id="mFiles"></div>' +
        '<div class="ai-grid"><div class="dlg-field"><label class="l">詳しさ</label><select id="mLevel">' + opt([['short', '簡潔'], ['normal', '標準'], ['long', '詳しい']], 'normal') + '</select></div>' +
        '<div class="dlg-field"><label class="l">保存先</label><select id="mTarget">' + opt(targets, 'note') + '</select></div></div>' +
        (sc.notes.length ? '<label class="check"><input type="checkbox" id="mUseNotes" checked> この単元の既存ノート（' + sc.notes.length + '件）も参考にする</label>' : '') +
        '<div class="dlg-field"><label class="l">追加の指示（任意）</label><textarea id="mExtra" placeholder="例）先生が「試験に出る」と言った部分を重点的に。英語の用語は英語も併記して。"></textarea></div>' +
        '<div class="ai-status" id="mStatus"></div><div class="ai-out md" id="mOut" hidden></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn primary" id="mGo" disabled>生成する</button><button type="button" class="btn" id="mStop" hidden>停止</button><button type="button" class="btn primary" id="mApply" hidden>この内容を保存する</button></div>',
      onOpen(form, close) {
        const status = (t, spin) => { $('#mStatus', form).innerHTML = (spin ? '<span class="ai-spin"></span>' : '') + esc(t || ''); };
        const renderFiles = () => {
          $('#mFiles', form).innerHTML = items.map((it, i) => '<div class="ai-file' + (it.err ? ' err' : '') + '"><span class="nm">' + esc(it.file.name) + '</span><span class="sub">' +
            (it.err ? esc(it.err) : it.status === 'reading' ? '読み取り中… ' + Math.round((it.progress || 0) * 100) + '%' : esc(it.res.summary)) + '</span>' +
            (it.res && it.res.warnings.length ? '<span class="warn" title="' + esc(it.res.warnings.join('\n')) + '">注意</span>' : '') +
            '<button type="button" class="icon-btn" data-rm="' + i + '" title="外す">' + U.ICON.trash + '</button></div>').join('');
          const ready = items.filter((it) => it.res);
          const total = ready.reduce((s, it) => s + it.res.bytes, 0);
          let note = '';
          if (total > M.LIMITS.totalBytes) note = '教材の合計が大きすぎます（約' + Math.round(total / 1048576) + 'MB。上限 ' + (M.LIMITS.totalBytes >> 20) + 'MB）。減らしてください。';
          else if (ready.length) note = '入力の目安：約' + Math.round(ready.reduce((s, it) => s + it.res.approxTokens, 0) / 1000) + 'K トークン（多いほど利用料がかかります）';
          if (!busy && !finalMsg) status(note);
          $('#mGo', form).disabled = busy || !ready.length || total > M.LIMITS.totalBytes || items.some((it) => it.status === 'reading');
        };
        const extractOpts = () => ({ media: ai.provider() === 'gemini', videoMode: ($('#mVideo', form) || {}).value || 'frames' });
        const addFiles = async (files) => {
          finalMsg = '';
          for (const f of files) {
            const it = { file: f, status: 'reading', progress: 0 };
            items.push(it); renderFiles();
            try { it.res = await M.extract(f, (p) => { it.progress = p; renderFiles(); }, extractOpts()); it.status = 'ok'; }
            catch (e) { it.err = e.message; it.status = 'error'; }
            renderFiles();
          }
        };
        $('#mPick', form).onclick = () => $('#mFile', form).click();
        $('#mFile', form).onchange = (e) => { const fs = Array.from(e.target.files); e.target.value = ''; addFiles(fs); };
        const drop = $('#mDrop', form);
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
        drop.ondragleave = () => drop.classList.remove('over');
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(Array.from(e.dataTransfer.files)); };
        $('#mFiles', form).onclick = (e) => {
          const b = e.target.closest('[data-rm]');
          if (b && !busy) { items.splice(+b.dataset.rm, 1); finalMsg = ''; renderFiles(); }
        };

        const out = $('#mOut', form);
        const paint = throttle(() => { out.innerHTML = md().render(partialSafe(result)); out.scrollTop = out.scrollHeight; }, 250);

        $('#mGo', form).onclick = async () => {
          const content = [];
          items.filter((it) => it.res).forEach((it) => content.push(...it.res.blocks));
          const useNotes = $('#mUseNotes', form) && $('#mUseNotes', form).checked;
          if (useNotes) content.push({ type: 'text', text: '【学生のノート（この単元）】\n' + scopeText(sc) });
          const extra = $('#mExtra', form).value.trim();
          content.push({
            type: 'text',
            text: '教科：' + sc.subject.name + (sc.unit ? '／単元：' + sc.unit.name : '') + '\n' + LEVELS[$('#mLevel', form).value] + (extra ? '\n\n【学生からの追加の指示】\n' + extra : '') +
              '\n\n上の教材をもとに、指定の構成でノートを作ってください。',
          });
          aiNotes.length = 0;
          busy = true; finalMsg = ''; result = ''; out.hidden = false; out.innerHTML = '';
          $('#mGo', form).hidden = true; $('#mStop', form).hidden = false; $('#mApply', form).hidden = true;
          status('AI に送信しています…', true);
          job = ai.run({
            system: SYS_MATERIALS, messages: [{ role: 'user', content }], maxTokens: 32000,
            onStatus: (s) => status(statText(s, '教材を読み込んで考えています…（数十秒〜数分かかります）', '書いています…'), true),
            onText: (t) => { result += t; paint(); }, onNote: (n) => { aiNotes.push(n); },
          });
          try {
            const r = await job.done;
            result = r.text || result;
            out.innerHTML = md().render(result);
            const notes = [];
            if (r.stopReason === 'max_tokens') notes.push('長すぎて途中で切れました。「詳しさ」を下げるか、教材を分けてください。');
            if (r.stopReason === 'refusal') notes.push('AI がこの内容への回答を控えました。教材を変えてお試しください。');
            finalMsg = (notes.join(' ') || '完成しました。内容を確認して、保存してください。（AI の出力には誤りが含まれることがあります）') + (aiNotes.length ? ' ' + aiNotes.join(' ') : '');
            $('#mApply', form).hidden = !result.trim();
          } catch (e) {
            finalMsg = errText(e) + (e.kind === 'cancelled' && result.trim() ? '（途中までの内容を保存できます）' : '');
            $('#mApply', form).hidden = !(e.kind === 'cancelled' && result.trim());
          }
          status(finalMsg);
          busy = false; job = null;
          $('#mGo', form).hidden = false; $('#mStop', form).hidden = true; renderFiles();
          $('#mGo', form).textContent = '生成し直す';
        };
        $('#mStop', form).onclick = () => { if (job) job.cancel(); };

        $('#mApply', form).onclick = () => {
          const target = $('#mTarget', form).value;
          const h1 = /^\s*#\s+(.+)$/m.exec(result);
          const title = h1 ? h1[1].trim() : '教材まとめ';
          const st = LN.state;
          if (target === 'note') {
            const n = { id: LN.uid(), subjectId: sc.subject.id, unitId: sc.unit ? sc.unit.id : null, title, date: LN.today(), body: result.trim(), star: 0, review: true, source: 'ai', createdAt: Date.now(), updatedAt: Date.now() };
            st.notes.push(n);
            U.ui.view = 'notes'; U.ui.subjectId = sc.subject.id; U.ui.noteId = n.id; U.ui.search = '';
            U.persistUi(); close(null); U.render();
            U.toast('ノートを作成しました。「AI」の印が付いています。内容を確認してください');
          } else {
            const body = result.replace(/^\s*#\s+.+\n+/, '').trim();
            sc.unit.summary = target === 'replace' || !sc.unit.summary.trim() ? body : sc.unit.summary.replace(/\s+$/, '') + '\n\n' + body;
            LN.save(); close(null);
            if (U.ui.view === 'exam') U.renderSummaryTab();
            U.toast('単元まとめに反映しました');
          }
        };
        renderFiles();
      },
    });
    await dlgPromise;
    if (job) job.cancel();
  }

  /* ---------- 図解 ---------- */
  const DIAGRAM_KINDS = [['auto', 'おまかせ'], ['flow', 'フローチャート（手順・流れ）'], ['cycle', '循環図（サイクル）'], ['concept', '関係図・概念マップ'], ['compare', '比較表・対比図'],
    ['timeline', '年表・時系列'], ['tree', '階層・分類図（ツリー）'], ['graph', 'グラフ・数直線・座標図']];

  function extractSvg(text) {
    const m = /<svg[\s\S]*<\/svg>/i.exec(text || '');
    return m ? m[0] : '';
  }

  async function openDiagram(spec) {
    if (!(await ensureReady())) return;
    let job = null, svg = '', history = null, busy = false;

    const dlgPromise = U.ask({
      title: '図解を作る', wide: true, hideOk: true, cancelText: '閉じる',
      body: '<div class="ai-note">作りたい図を文章で説明してください。' + (spec.context ? '下の「参考にする文章」を材料にします。' : '') + '生成した図は、ノートや単元まとめに<b>画像として挿入</b>され、印刷プリントにも入ります。</div>' +
        '<div class="dlg-field"><label class="l">何を図解しますか？</label><textarea id="dRequest" placeholder="例）光合成の「明反応」と「カルビン回路」の関係を、場所と、出入りする物質がわかるように図解して"></textarea></div>' +
        '<div class="ai-grid"><div class="dlg-field"><label class="l">図の種類</label><select id="dKind">' + opt(DIAGRAM_KINDS, 'auto') + '</select></div>' +
        '<div class="dlg-field"><label class="l">配色</label><select id="dColor">' + opt([['color', 'カラー'], ['mono', '白黒印刷向け（濃淡と線種で区別）']], 'color') + '</select></div></div>' +
        (spec.context ? '<label class="check"><input type="checkbox" id="dUseCtx" checked> ' + esc(spec.contextLabel || '参考にする文章') + 'を材料に含める（' + spec.context.length + '文字）</label>' : '') +
        '<div class="ai-status" id="dStatus"></div>' +
        '<div class="ai-diagram-preview" id="dPrev"><span style="color:var(--text-3);font-size:12.5px">ここに図が表示されます</span></div>' +
        '<div class="dlg-field" id="dRefineRow" hidden><label class="l">修正の指示</label><div style="display:flex;gap:6px"><input type="text" id="dRefine" placeholder="例）矢印を太く／文字を大きく／「ATP」の説明を追加" style="flex:1"><button type="button" class="btn" id="dRefineGo">修正する</button></div></div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button type="button" class="btn primary" id="dGo">図を作る</button><button type="button" class="btn" id="dStop" hidden>停止</button>' +
        '<button type="button" class="btn" id="dSave" hidden>SVG を保存</button><button type="button" class="btn primary" id="dInsert" hidden>' + esc(spec.insertLabel || 'ノートに挿入') + '</button></div>',
      onOpen(form, close) {
        const status = (t, spin) => { $('#dStatus', form).innerHTML = (spin ? '<span class="ai-spin"></span>' : '') + esc(t || ''); };
        const setBusy = (b) => {
          busy = b;
          $('#dGo', form).hidden = b; $('#dStop', form).hidden = !b; $('#dRefineGo', form).disabled = b;
        };
        const show = (raw) => {
          const r = LN.svg.sanitize(extractSvg(raw));
          if (!r.ok) { status('図を表示できませんでした：' + r.error + '。もう一度お試しください。'); return false; }
          svg = r.svg;
          $('#dPrev', form).innerHTML = '<img alt="図解" src="' + LN.svg.toDataUrl(svg) + '">';
          $('#dRefineRow', form).hidden = false; $('#dSave', form).hidden = false; $('#dInsert', form).hidden = false;
          status('できました。修正したい点があれば指示してください。（AI の図には誤りが含まれることがあります）');
          return true;
        };
        const run = async (messages) => {
          setBusy(true); status('AI に送信しています…', true);
          let text = '';
          job = ai.run({ system: SYS_DIAGRAM, messages, maxTokens: 16000, onStatus: (s) => status(statText(s, '図の構成を考えています…', 'SVG を書いています…'), true), onText: (t) => { text += t; } });
          try {
            const r = await job.done;
            text = r.text || text;
            if (r.stopReason === 'refusal') status('AI がこの内容への回答を控えました。');
            else if (show(text)) history = messages.concat([{ role: 'assistant', content: text }]);
          } catch (e) { status(errText(e)); }
          job = null; setBusy(false);
        };
        $('#dGo', form).onclick = () => {
          const req = $('#dRequest', form).value.trim();
          if (!req) { status('図にしたい内容を入力してください。'); return; }
          const useCtx = $('#dUseCtx', form) && $('#dUseCtx', form).checked;
          const kind = DIAGRAM_KINDS.find((k) => k[0] === $('#dKind', form).value);
          const text = (useCtx ? '【参考にする文章】\n' + spec.context + '\n\n' : '') + '【図解の依頼】\n' + req + '\n図の種類：' + kind[1] +
            '\n配色：' + ($('#dColor', form).value === 'mono' ? '白黒印刷向け。黒・グレーの濃淡と、実線/破線/文字ラベルで区別する。' : 'カラー。落ち着いた 2〜3 色。');
          run([{ role: 'user', content: text }]);
        };
        $('#dRefineGo', form).onclick = () => {
          const ins = $('#dRefine', form).value.trim();
          if (!ins || !history) return;
          $('#dRefine', form).value = '';
          run(history.concat([{ role: 'user', content: '次の修正を反映して、SVG 全体を出力し直してください。\n' + ins }]));
        };
        $('#dStop', form).onclick = () => { if (job) job.cancel(); };
        $('#dSave', form).onclick = () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
          a.download = 'zukai-' + LN.today() + '.svg';
          document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        };
        $('#dInsert', form).onclick = async () => {
          const id = await LN.addImage(LN.svg.toDataUrl(svg));
          const alt = ($('#dRequest', form).value.trim().replace(/[\[\]\n]/g, ' ').slice(0, 30)) || '図解';
          close(null);
          spec.onInsert('![図解：' + alt + '](img:' + id + ')');
          U.toast('図解を挿入しました');
        };
      },
    });
    await dlgPromise;
    if (job) job.cancel();
  }

  /* ---------- プリントの依頼（AIおまかせ） ---------- */
  const cs = { request: '', difficulty: '標準', diagram: false, attachments: [], busy: false, job: null, status: '', selected: null, editOpen: false, reading: 0 };
  const EXAMPLES = [
    ['小テスト', '選択式 8 問と記述式 3 問の小テスト。難易度は標準。解答と解説つき。'],
    ['予想問題', '本番の考査を想定した予想問題。記述式を中心に 6 問、配点つき。'],
    ['ひっかけ注意', '間違えやすいポイントを集めた「まちがい探し」プリント。誤りを含む文を 8 個示し、どこが誤りか答えさせる。'],
    ['図で整理', '全体像を図解で整理した 1 枚のまとめプリント。重要語は空欄にして、書き込んで覚えられるように。'],
    ['穴埋め＋図', '図解に空欄がある穴埋めプリント。図の説明文の中の重要語を {{ }} で空欄にする。'],
    ['用語の比較', '似た用語を比べて違いを整理する対比表を作り、その後に確認問題を 5 問。'],
  ];

  function sheetsOfExam() {
    const exam = U.curExam();
    return (LN.state.aiSheets || []).filter((s) => s.examId === exam.id).sort((a, b) => b.createdAt - a.createdAt);
  }
  const selSheet = () => (LN.state.aiSheets || []).find((s) => s.id === cs.selected) || null;

  function mountCustomPanel(el) {
    if (!el) return;
    const st = LN.state, exam = U.curExam(), o = U.sheetOpts();
    const list = sheetsOfExam();
    if (!selSheet() || selSheet().examId !== exam.id) cs.selected = o.customId && list.some((s) => s.id === o.customId) ? o.customId : (list[0] || {}).id || null;
    o.customId = cs.selected;
    const sel = selSheet();

    el.innerHTML =
      (ai.enabled
        ? '<div class="opt-group"><div class="lbl">どんなプリントがほしいですか？</div><div class="stack">' +
          '<textarea id="csReq" placeholder="例）選択式 10 問と記述式 3 問の小テスト。少し難しめで、解答と解説つき。">' + esc(cs.request) + '</textarea>' +
          '<div>' + EXAMPLES.map((x, i) => '<span class="ai-chip" data-ex="' + i + '">' + esc(x[0]) + '</span>').join('') + '</div>' +
          '<div class="row2"><div><div class="field-l">難易度</div><select id="csDiff">' + opt(['やさしい', '標準', '難しい'].map((x) => [x, x]), cs.difficulty) + '</select></div>' +
          '<div><div class="field-l">図解</div><select id="csDiagram">' + opt([['0', '入れない'], ['1', '必要なら入れる']], cs.diagram ? '1' : '0') + '</select></div></div>' +
          '<div><button type="button" class="btn sm" id="csAttach">' + U.ICON.file + '教材を追加（任意）</button><input type="file" id="csFile" multiple accept="' + LN.materials.ACCEPT + '" hidden>' +
          '<div class="ai-files" id="csFiles">' + cs.attachments.map((a, i) => '<div class="ai-file"><span class="nm">' + esc(a.name) + '</span><span class="sub">' + esc(a.summary) + '</span><button type="button" class="icon-btn" data-rm="' + i + '">' + U.ICON.trash + '</button></div>').join('') + '</div></div>' +
          '<div style="display:flex;gap:6px"><button type="button" class="btn primary" id="csGo" style="flex:1;justify-content:center"' + (cs.busy ? ' hidden' : '') + '>' + U.ICON.spark + 'AI で作成する</button><button type="button" class="btn" id="csStop" style="flex:1;justify-content:center"' + (cs.busy ? '' : ' hidden') + '>停止</button></div>' +
          '<div class="ai-status" id="csStatus">' + (cs.busy ? '<span class="ai-spin"></span>' : '') + esc(cs.status) + '</div>' +
          '<div class="opt-note">選択中の範囲のノート・まとめを材料に作ります。範囲は左の一覧で変えられます。内容は AI に送信されます。</div></div></div>'
        : '<div class="ai-note warn">AI でのプリント作成は、デスクトップ版で行えます。ここには、作成済みのプリントが表示されます。</div>') +
      '<div class="opt-group"><div class="lbl">作成したプリント</div><div class="stack" id="csList">' +
      (list.map((s) => '<div class="ai-sheet-item' + (s.id === cs.selected ? ' on' : '') + '" data-pick="' + s.id + '"><span class="ai-badge">AI</span><span class="nm">' + esc(s.title) + '</span><button type="button" class="icon-btn danger" data-del="' + s.id + '" title="削除">' + U.ICON.trash + '</button></div>').join('') || '<div class="opt-note">まだありません。</div>') +
      '</div></div>' +
      (sel ? '<div class="opt-group"><div class="lbl">選んだプリントの編集</div><div class="stack"><input type="text" id="csTitle" value="' + esc(sel.title) + '" placeholder="タイトル">' +
        (ai.enabled ? '<div style="display:flex;gap:6px"><input type="text" id="csRefine" placeholder="修正の指示（例：もう少し難しく／問3を図にして）" style="flex:1"><button type="button" class="btn" id="csRefineGo"' + (cs.busy ? ' disabled' : '') + '>修正</button></div>' : '') +
        '<button type="button" class="btn sm" id="csEditToggle">' + (cs.editOpen ? '本文の編集を閉じる' : '本文（Markdown）を直接編集') + '</button>' +
        (cs.editOpen ? '<textarea id="csMd" style="min-height:220px;font-family:Consolas,monospace;font-size:12px">' + esc(sel.markdown) + '</textarea>' : '') +
        '<div class="opt-note">AI が作った内容には誤りが含まれることがあります。印刷前に必ず確認してください。</div></div></div>' : '');

    bindCustom(el);
  }

  function bindCustom(el) {
    const U_ = U, st = LN.state;
    const refresh = () => { U_.refreshSheet(); };
    const setStatus = (t, spin) => { cs.status = t; const s = $('#csStatus', el); if (s) s.innerHTML = (spin ? '<span class="ai-spin"></span>' : '') + esc(t || ''); };
    const req = $('#csReq', el);
    if (req) req.oninput = () => { cs.request = req.value; };
    const sel = $('#csDiff', el); if (sel) sel.onchange = () => { cs.difficulty = sel.value; };
    const dg = $('#csDiagram', el); if (dg) dg.onchange = () => { cs.diagram = dg.value === '1'; };
    el.onclick = async (e) => {
      const ex = e.target.closest('[data-ex]');
      if (ex) { cs.request = EXAMPLES[+ex.dataset.ex][1]; req.value = cs.request; req.focus(); return; }
      const rm = e.target.closest('[data-rm]');
      if (rm) { cs.attachments.splice(+rm.dataset.rm, 1); mountCustomPanel(el); return; }
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        const s = st.aiSheets.find((x) => x.id === del.dataset.del);
        if (!(await U_.ask({ title: 'プリントを削除', message: '「' + esc(s.title) + '」を削除します。', ok: '削除する', danger: true }))) return;
        st.aiSheets = st.aiSheets.filter((x) => x.id !== s.id);
        if (cs.selected === s.id) cs.selected = null;
        U_.sheetOpts().customId = null; LN.save(); mountCustomPanel(el); refresh();
        return;
      }
      const pick = e.target.closest('[data-pick]');
      if (pick) { cs.selected = pick.dataset.pick; U_.sheetOpts().customId = cs.selected; LN.save(); mountCustomPanel(el); refresh(); return; }
      if (e.target.closest('#csEditToggle')) { cs.editOpen = !cs.editOpen; mountCustomPanel(el); return; }
      if (e.target.closest('#csAttach')) { $('#csFile', el).click(); return; }
      if (e.target.closest('#csStop')) { if (cs.job) cs.job.cancel(); return; }
      if (e.target.closest('#csGo')) { generate(el, null); return; }
      if (e.target.closest('#csRefineGo')) { const v = $('#csRefine', el).value.trim(); if (v) generate(el, v); return; }
    };
    const file = $('#csFile', el);
    if (file) file.onchange = async () => {
      const fs = Array.from(file.files); file.value = '';
      for (const f of fs) {
        setStatus(f.name + ' を読み取り中…', true);
        try { const r = await LN.materials.extract(f, (p) => setStatus(f.name + ' を読み取り中… ' + Math.round(p * 100) + '%', true)); cs.attachments.push(r); }
        catch (err) { U_.toast(f.name + '：' + err.message); }
      }
      setStatus(''); mountCustomPanel(el);
    };
    const title = $('#csTitle', el);
    if (title) title.oninput = () => { const s = selSheet(); if (s) { s.title = title.value || '無題'; s.updatedAt = Date.now(); LN.save(); refresh(); const n = $('.ai-sheet-item.on .nm', el); if (n) n.textContent = s.title; } };
    const mdArea = $('#csMd', el);
    if (mdArea) mdArea.oninput = () => { const s = selSheet(); if (s) { s.markdown = mdArea.value; s.updatedAt = Date.now(); LN.save(); refresh(); } };
  }

  async function generate(el, refineText) {
    if (cs.busy) return;
    if (refineText == null && !cs.request.trim()) { U.toast('どんなプリントがほしいか入力してください'); return; }
    const exam = U.curExam(), o = U.sheetOpts(), st = LN.state;
    const ctx = sh().rangeContext(st, exam.keys, o.filter);
    if (!ctx.trim() && !cs.attachments.length) { U.toast('範囲にノートがありません。左の一覧で単元を選ぶか、教材を追加してください'); return; }
    if (ctx.length > 400000) { U.toast('範囲が大きすぎます（40万文字まで）。単元を減らしてください'); return; }
    if (!(await ensureReady())) return;

    const prev = refineText != null ? selSheet() : null;
    const request = prev ? prev.request : cs.request.trim();
    const content = [];
    cs.attachments.forEach((a) => content.push(...a.blocks));
    content.push({
      type: 'text',
      text: '【学習範囲（学生のノート・まとめ）】\n' + (ctx || '（なし。添付の教材のみが材料）') + '\n\n【依頼】\n' + request + '\n難易度：' + cs.difficulty +
        '\n図解：' + (cs.diagram ? '効果的な箇所に SVG の図解を入れてよい。' : '入れない。') + '\n考査名：' + exam.name,
    });
    const messages = [{ role: 'user', content }];
    if (prev) messages.push({ role: 'assistant', content: prev.markdown }, { role: 'user', content: '次の修正を反映して、プリント全文（=== 解答 === 以降も含めて）を出力し直してください。\n' + refineText });

    const entry = prev || { id: LN.uid(), examId: exam.id, title: (request.split('\n')[0] || 'プリント').slice(0, 26), request, markdown: '', createdAt: Date.now(), updatedAt: Date.now() };
    if (!prev) { st.aiSheets.push(entry); }
    const before = prev ? prev.markdown : '';
    cs.selected = entry.id; o.customId = entry.id; entry.markdown = prev ? prev.markdown : '';
    cs.busy = true; cs.status = 'AI に送信しています…';
    mountCustomPanel($('#aiCustom')); U.refreshSheet();

    let text = '';
    const paint = throttle(() => { entry.markdown = partialSafe(text); U.refreshSheet(); }, 350);
    const statusEl = () => $('#csStatus');
    cs.job = ai.run({
      system: SYS_SHEET, messages, maxTokens: 32000,
      onStatus: (s) => { cs.status = statText(s, '内容を考えています…（数十秒〜数分）', '作成中です…'); const e = statusEl(); if (e) e.innerHTML = '<span class="ai-spin"></span>' + esc(cs.status); },
      onText: (t) => { text += t; paint(); },
    });
    try {
      const r = await cs.job.done;
      text = r.text || text;
      entry.markdown = text.trim(); entry.updatedAt = Date.now();
      cs.status = r.stopReason === 'max_tokens' ? '長すぎて途中で切れました。依頼を絞ってください。' : r.stopReason === 'refusal' ? 'AI がこの内容への回答を控えました。' : '完成しました。内容を確認してください。';
      if (!entry.markdown.trim()) { st.aiSheets = st.aiSheets.filter((x) => x.id !== entry.id); cs.selected = null; o.customId = null; }
    } catch (e) {
      cs.status = errText(e);
      if (prev) entry.markdown = before;
      else if (text.trim()) entry.markdown = partialSafe(text).trim();
      else { st.aiSheets = st.aiSheets.filter((x) => x.id !== entry.id); cs.selected = null; o.customId = null; }
    }
    cs.busy = false; cs.job = null;
    LN.save();
    if (U.ui.view === 'exam' && U.ui.examTab === 'print') { mountCustomPanel($('#aiCustom')); U.refreshSheet(); }
  }

  /* ---------- 初期化：アクションの登録 ---------- */
  ai.mountCustomPanel = mountCustomPanel;
  ai.init = function (ui) {
    U = ui;
    const A = ui.actions;
    A['ai-settings'] = () => openSettings();
    A['ai-materials'] = (el) => openMaterials({ key: el.dataset.key });
    A['ai-materials-note'] = () => openMaterials({ fromNote: true });
    A['ai-diagram'] = () => {
      const ta = U.taEl(), n = U.curNote();
      if (!ta || !n) return;
      const s = ta.selectionStart, e = ta.selectionEnd;
      const selText = ta.value.slice(s, e).trim();
      const context = (selText || ta.value).replace(/!\[[^\]]*\]\(img:[a-z0-9]+\)/g, '').trim().slice(0, 30000);
      openDiagram({
        context: context || '', contextLabel: selText ? '選択中の文章' : 'このノートの本文', insertLabel: 'ノートに挿入',
        onInsert: (mdText) => U.insertText(ta, '\n' + mdText + '\n', s, e),
      });
    };
    A['ai-diagram-unit'] = (el) => {
      const g = U.unitFromKey(el.dataset.key);
      if (!g || !g.unit) { U.toast('単元に入っているノートで使えます'); return; }
      const context = (g.unit.summary.trim() || scopeText({ notes: g.notes })).slice(0, 30000);
      openDiagram({
        context, contextLabel: g.unit.summary.trim() ? 'この単元のまとめ' : 'この単元のノート', insertLabel: '単元まとめに挿入',
        onInsert: (mdText) => {
          g.unit.summary = g.unit.summary.replace(/\s+$/, '') + (g.unit.summary.trim() ? '\n\n' : '') + mdText;
          LN.save();
          const t = document.querySelector('[data-usum="' + g.unit.id + '"]');
          if (t) { t.value = g.unit.summary; const pv = document.querySelector('[data-uprev="' + g.unit.id + '"]'); if (pv) pv.innerHTML = U.unitPreviewHtml(g); }
          U.updateProgress();
        },
      });
    };
    if (D) refreshStatus();
  };
})(window);
