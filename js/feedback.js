/* ブラウザ版のフィードバック送信：利用者が「送信」を押したときだけ、開発者の Google フォーム（→スプレッドシート）へ送る。
   ノートの中身は送らない。デスクトップ版は desktop.js が main プロセス経由で同じフォームへ送る */
(function (root) {
  'use strict';
  const LN = (root.LN = root.LN || {});
  const FORM_ACTION = 'https://docs.google.com/forms/d/e/1FAIpQLSeGpU4bFHzpN5mq3cpjlORK9DtTlYCbCDQuakyiRo_joZeXfg/formResponse';
  const ENTRY = { kind: 'entry.1183294978', body: 'entry.1224708145', contact: 'entry.890136828' };
  const fb = (LN.feedback = { available: false, endpoint: FORM_ACTION, init() {}, send: null });
  if (root.lnDesktop) return; // デスクトップ版では何もしない

  fb.available = true;

  /** 送信。Google フォームは CORS に対応しないので no-cors で送る（応答は読めない＝通信に失敗したときだけ失敗扱い） */
  fb.send = async (data) => {
    const form = new URLSearchParams();
    form.set(ENTRY.kind, String((data && data.kind) || 'その他').slice(0, 100));
    // デスクトップ版からの意見と見分けられるよう、先頭に印をつける
    form.set(ENTRY.body, ('[Web版] ' + String((data && data.body) || '')).slice(0, 4000));
    form.set(ENTRY.contact, String((data && data.contact) || '').slice(0, 200));
    try {
      await fetch(fb.endpoint, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  };

  fb.init = function (U) {
    U.actions['feedback'] = async () => {
      const r = await U.ask({
        title: 'フィードバックを送る',
        message: '使ってみての感想・不具合・欲しい機能を、開発者に送ります。送信すると、入力した内容がインターネット経由で送られます（ノートの中身は送られません）。',
        fields: [
          { name: 'kind', label: '種類', type: 'select', options: [['バグ報告', 'バグ報告'], ['使いにくい点', '使いにくい点'], ['要望（欲しい機能）', '要望（欲しい機能）'], ['その他', 'その他']] },
          { name: 'body', label: '内容', type: 'textarea', rows: 6, placeholder: '具体的に書いていただけると助かります', required: true },
          { name: 'contact', label: '連絡先（任意・返信が必要なら）', placeholder: 'メールなど' },
        ],
        ok: '送信',
      });
      if (!r) return;
      if (!r.body) { U.toast('内容を入力してください'); return; }
      const res = await fb.send({ kind: r.kind, body: r.body, contact: r.contact });
      U.toast(res && res.ok ? '送信しました。ありがとうございます' : '送信できませんでした（インターネット接続をご確認ください）');
    };
  };
})(window);
