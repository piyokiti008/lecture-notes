/* Firebase プロジェクト p-notes-4ed2b の、公開されても問題ない識別子（秘密ではない）。
 * アプリ本体（cloud.js・roster.js）と、運営の管理画面（admin.html）が、同じ値を使う。 */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  LN.fbConfig = {
    clientId: '473111156744-0s1sg9m5i452mnr0edcdg0a6uk12s697.apps.googleusercontent.com',
    apiKey: 'AIzaSyCNVYjLftIeUTu0H5OQ6Tsk5tyE9PXUwGE',
    project: 'p-notes-4ed2b',
    // ニックネーム名簿（Firestore のコレクション members。文書名＝利用者の「番号」）
    roster: 'https://firestore.googleapis.com/v1/projects/p-notes-4ed2b/databases/(default)/documents/members',
    // 棚（コミュニティ）：Firestore の文書の根っこ（js/shelf/api.js）
    docs: 'https://firestore.googleapis.com/v1/projects/p-notes-4ed2b/databases/(default)/documents',
    // 棚：投稿ファイルを、ログインなしで読むための Drive 専用キー（Drive API だけを許可。2026-10-22 に作成。段階3で使う）
    driveKey: 'AIzaSyDlYEjbWU_7YvWHeediRhS9pHh8e_am9_4',
    // 棚の荒らし対策（App Check）：reCAPTCHA v3 のサイトキーと、Firebase のウェブアプリの ID。両方が入ると有効になる（空のあいだは、使わない）。手順は docs/運営の設定手順（棚）.md
    appCheckSiteKey: '',
    appId: '',
  };
})(window);
