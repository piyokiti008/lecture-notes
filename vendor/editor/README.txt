ノートのエディタ部品。CodeMirror 6（MIT ライセンス、LICENSE を参照）を、tools/editor/build.js で1つのファイル（cm.js）にまとめたもの。
含まれる部品: @codemirror/state 6.7.6 ・ @codemirror/view 6.43.13 ・ @codemirror/commands 6.11.1（と、その依存の部品）
作り直し方: tools/editor で  npm install  →  node build.js
