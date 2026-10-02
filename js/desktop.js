/* デスクトップ版（Electron）専用の機能：PDF 直接保存・自動バックアップ・ショートカット。ブラウザ版では何もしない */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const B = root.lnDesktop;
  const d = (LN.desktop = { available: !!B, info: null, init() {}, backupNote: () => "" });
  if (!B) return;

  const AUTO_MS = 5 * 60 * 1000;
  let lastHash = '';

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function autoBackup() {
    try {
      const json = LN.backupJson();
      const h = await sha256(json);
      if (h === lastHash) return;
      const r = await B.backup.write(json);
      if (r && r.ok) { lastHash = h; LN.state.settings.lastAutoBackup = Date.now(); LN.save(); }
    } catch (e) { /* 次回に再試行 */ }
  }

  // 復元などで「今の状態」を失う前に、変更の有無を問わず一枚残す
  d.snapshotNow = async function () {
    try { await B.backup.write(LN.backupJson()); } catch (e) { /* 失敗しても呼び出し元の処理は続行 */ }
  };

  d.backupNote = function () {
    const i = d.info;
    if (!i) return '';
    return '<div class="ai-note">このパソコンでの保存場所：<br><code>' + LN.md.esc(i.dataDir) + '</code><br>自動バックアップ（変更があるたび・直近40世代）：<br><code>' + LN.md.esc(i.backupDir) + '</code>' +
      '<div style="margin-top:6px"><button type="button" class="btn sm" data-act="open-backup-folder">フォルダを開く</button></div></div>';
  };

  d.init = function (U) {
    document.body.classList.add('is-desktop');
    B.info().then((i) => { d.info = i; });
    const A = U.actions;

    A['sheet-pdf'] = async () => {
      const r = U.currentSheet();
      const title = (r.html.match(/<h1 class="s-title">([^<]*)<\/h1>/) || [])[1] || '講義ノート';
      const name = title.replace(/&amp;/g, '&').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.pdf';
      $('#print-root').innerHTML = r.html;
      $('#page-style').textContent = '@page { size: ' + (U.sheetOpts().paper || 'A4') + '; margin: 14mm; }';
      const res = await B.savePdf(name);
      $('#print-root').innerHTML = '';
      if (res && res.ok) U.toast('PDF を保存しました');
      else if (res && res.error) U.toast('PDF を保存できませんでした：' + res.error);
    };
    A['open-backup-folder'] = () => B.backup.openFolder();

    A['feedback'] = async () => {
      const r = await U.ask({
        title: 'フィードバックを送る',
        message: '使ってみての感想・不具合・欲しい機能を、開発者に送ります。送信すると、入力した内容がインターネット経由で送られます。',
        fields: [
          { name: 'kind', label: '種類', type: 'select', options: [['バグ報告', 'バグ報告'], ['使いにくい点', '使いにくい点'], ['要望（欲しい機能）', '要望（欲しい機能）'], ['その他', 'その他']] },
          { name: 'body', label: '内容', type: 'textarea', rows: 6, placeholder: '具体的に書いていただけると助かります', required: true },
          { name: 'contact', label: '連絡先（任意・返信が必要なら）', placeholder: 'メールなど' },
        ],
        ok: '送信',
      });
      if (!r) return;
      if (!r.body) { U.toast('内容を入力してください'); return; }
      const res = await B.feedback.send({ kind: r.kind, body: r.body, contact: r.contact });
      U.toast(res && res.ok ? '送信しました。ありがとうございます' : '送信できませんでした（インターネット接続をご確認ください）');
    };

    setTimeout(autoBackup, 20000);
    setInterval(autoBackup, AUTO_MS);
    root.addEventListener('pagehide', autoBackup);

    // 初回だけ、デスクトップのショートカットを提案
    const cfg = LN.state.settings.desktop || (LN.state.settings.desktop = {});
    if (!cfg.shortcutAsked) {
      const offer = async () => {
        if (cfg.shortcutAsked) return;
        if (document.getElementById('dlg').open) { setTimeout(offer, 4000); return; } // 他のダイアログを操作中は割り込まない
        cfg.shortcutAsked = true; LN.save();
        if (await U.ask({ title: 'ショートカットの作成', message: 'デスクトップに「講義ノート」のショートカットを作りますか？', ok: '作成する', cancelText: '今はしない' })) {
          const r = await B.createShortcut();
          U.toast(r && r.ok ? 'デスクトップにショートカットを作りました' : 'ショートカットを作成できませんでした');
        }
      };
      setTimeout(offer, 1500);
    }

    // ノートが空の状態で起動したら、直前の自動バックアップを見つけて復元を提案する（一度だけ）
    if (!cfg.emptyRestoreOffered && LN.state.subjects.length === 0 && LN.state.notes.length === 0) {
      const offerRestore = async () => {
        if (cfg.emptyRestoreOffered) return;
        if (document.getElementById('dlg').open) { setTimeout(offerRestore, 4000); return; }
        cfg.emptyRestoreOffered = true; LN.save();
        const list = await B.backup.list().catch(() => []);
        if (!list || !list.length) return;
        const content = await B.backup.read(list[0].file).catch(() => null);
        if (!content) return;
        let data; try { data = JSON.parse(content); } catch (e) { return; }
        const subs = (data.state && data.state.subjects || []).length, notes = (data.state && data.state.notes || []).length;
        if (!subs && !notes) return;
        const when = new Date(list[0].mtime).toLocaleString('ja-JP');
        if (await U.ask({
          title: 'データの復元', ok: '復元する', cancelText: 'このままにする',
          message: '今、ノートが空の状態です。' + when + ' 時点の自動バックアップ（' + subs + '教科・' + notes + 'ノート）が見つかりました。復元しますか？',
        })) {
          await U.restoreFromBackup(content, { skipConfirm: true });
        }
      };
      setTimeout(offerRestore, 2200);
    }
  };

  const $ = (s) => document.querySelector(s);
})(window);
