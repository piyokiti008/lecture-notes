/* 投稿を開く画面の部品（段階3。shelf.html）。DOM を作る道具 h は、ui.js から受け取る（利用者が決めた文字は、必ず textContent で入れる）。
 *  - PDF・Word・Excel・PowerPoint：Google のプレビュー枠（drive.google.com/file/d/ID/preview）をその場で見せる。ファイルは、端末に保存しない。
 *    ログインなしで見られる（投稿者のドライブで「リンクを知る人は閲覧可」になっているため）。
 *  - プレビューが出ない・崩れるときの保険として、「ダウンロード」と「ドライブで開く」を並べる。
 *  - 表示の前に、ドライブの実際のファイル情報（種類・大きさ）が、目次の登録と合うかを確かめる（合わなければ、プレビュー枠を出さない）。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const S = (LN.shelf = LN.shelf || {});
  const M = S.model, D = S.drive;
  const V = (S.view = {});

  /** 一覧の1行の説明：「PDF　1.2 MB　2026/10/22　投稿者」 */
  V.meta = (e, noKind) => [noKind ? '' : M.kindLabel(e.kind), M.fmtSize(e.size), M.fmtDay(e.created), e.authorNick || ''].filter(Boolean).join('　');

  /** ドライブの確認結果（state）に対する、利用者向けの説明。ok のときは空 */
  V.problem = function (state) {
    return ({
      gone: 'このファイルは、いま見られません。投稿者が取り下げたか、公開が止まっている可能性があります。',
      mime: 'ファイルの種類が、投稿の登録と合わないため、表示しません。',
      size: 'ファイルの大きさが、決まりを超えているため、表示しません。',
      error: 'ファイルの状態を確かめられませんでした（通信の失敗）。',
      read: 'ノートを読み込めませんでした（通信の失敗）。',
    })[state] || '';
  };

  /** Google のプレビュー枠。sandbox で、枠の中から外のページを書き換えられないようにする */
  V.previewFrame = function (h, e) {
    return h('iframe', {
      id: 'shPreview', class: 'sh-preview', src: D.previewUrl(e.driveId), title: e.name + '（プレビュー）',
      referrerpolicy: 'no-referrer', loading: 'lazy', sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    });
  };

  /** ダウンロードと、ドライブで開くリンク（新しいタブで開く） */
  V.links = function (h, e) {
    return h('div', { class: 'sh-row' },
      h('a', { id: 'shDownload', class: 'sh-btn primary', href: D.downloadUrl(e.driveId), target: '_blank', rel: 'noopener noreferrer', text: 'ダウンロード' }),
      h('a', { id: 'shOpenDrive', class: 'sh-btn', href: D.openUrl(e.driveId), target: '_blank', rel: 'noopener noreferrer', text: 'ドライブで開く' }));
  };

  /** 編集の扱いの案内 */
  V.editNotice = function (h, e) {
    return e.edit === 'ok'
      ? h('p', { id: 'shEditNote', class: 'sh-note ok', text: '投稿者は「編集OK」にしています。' })
      : h('p', { id: 'shEditNote', class: 'sh-note warn', text: '投稿者は「編集しないでほしい」を選んでいます。個人利用にとどめてください。違反は管理者が対応します。' });
  };
})(window);
