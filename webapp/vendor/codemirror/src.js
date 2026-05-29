// vendor/codemirror/src.js — CodeMirror 6 bundle entry point.
//
// Re-exports the minimal API surface the Faust DSP editor needs.
// Bundled into vendor/codemirror/cm6.js by build-cm6.sh.
//
// To rebuild :
//   cd webapp/vendor/codemirror && ./build-cm6.sh

export { EditorState, Compartment } from '@codemirror/state';
export { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
export { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
export {
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  indentOnInput,
} from '@codemirror/language';
export { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
export { tags } from '@lezer/highlight';
export { oneDark } from '@codemirror/theme-one-dark';
