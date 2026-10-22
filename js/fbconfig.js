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
  };
})(window);
