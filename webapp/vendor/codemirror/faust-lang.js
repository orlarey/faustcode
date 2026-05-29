// faust-lang.js — minimal Faust language support for CodeMirror 6.
//
// Provides :
//   - A StreamLanguage tokeniser for keywords, builtin functions,
//     numbers, strings and comments.
//   - A HighlightStyle that maps those tokens to Faust colours that
//     match the existing public/style.css palette (.faust-keyword
//     etc.).
//
// Exported as a single `faustLanguage` extension array that can be
// added to an EditorView's extensions list.

import { StreamLanguage, HighlightStyle, syntaxHighlighting, tags } from './cm6.js';

const KEYWORDS = new Set([
  'import', 'declare', 'process', 'with', 'letrec', 'where',
  'library', 'component', 'environment', 'inputs', 'outputs',
  'ffunction', 'fvariable', 'fconstant', 'int', 'float',
  'case', 'seq', 'par', 'sum', 'prod',
]);

const FUNCTIONS = new Set([
  'button', 'checkbox', 'hslider', 'vslider', 'nentry',
  'hgroup', 'vgroup', 'tgroup', 'hbargraph', 'vbargraph',
  'attach', 'mem', 'prefix', 'rdtable', 'rwtable',
  'select2', 'select3', 'fmod', 'remainder',
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'exp', 'log', 'log10', 'pow', 'sqrt', 'abs',
  'min', 'max', 'floor', 'ceil', 'rint',
]);

const faustStreamLanguage = StreamLanguage.define({
  name: 'faust',

  startState() {
    return { inBlockComment: false };
  },

  token(stream, state) {
    // Block comments /* ... */
    if (state.inBlockComment) {
      while (!stream.eol()) {
        if (stream.match('*/')) {
          state.inBlockComment = false;
          return 'comment';
        }
        stream.next();
      }
      return 'comment';
    }
    if (stream.match('/*')) {
      state.inBlockComment = true;
      return 'comment';
    }

    // Line comments
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }

    // Strings
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
      return 'string';
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*$/)) {
      // Unterminated string (e.g. EOL inside string) — still colour it.
      return 'string';
    }

    // Numbers — optional sign, mandatory digits, optional fraction and
    // exponent. The negative-sign case is left to the operator branch
    // to avoid eating unary minus as a separate token.
    if (stream.match(/^\d+\.?\d*(?:e[+-]?\d+)?/i)) {
      return 'number';
    }

    // Identifiers / keywords / builtins
    if (stream.match(/^[A-Za-z_][A-Za-z_0-9]*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return 'keyword';
      if (FUNCTIONS.has(word)) return 'builtin';
      return null;
    }

    // Faust operators we want to colour distinctly.
    if (stream.match(/^(?:<:|:>|~|<<|>>|->)/)) {
      return 'operator';
    }
    if (stream.match(/^[:+\-*/%&|^<>=!?~]/)) {
      return 'operator';
    }

    // Skip whitespace / punctuation we don't tag.
    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
    closeBrackets: { brackets: ['(', '[', '{', '"'] },
  },
});

// Map our token tags to colours. The colours match the .faust-keyword,
// .faust-string, .faust-number, .faust-function, .faust-comment classes
// already defined in public/style.css so the editor blends in.
const faustHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword,      color: '#80c8ff', fontWeight: '600' },
  { tag: tags.string,       color: '#a8e6a3' },
  { tag: tags.number,       color: '#ffd479' },
  { tag: tags.comment,      color: '#7a8a99', fontStyle: 'italic' },
  { tag: tags.operator,     color: '#d0d0d8' },
  // StreamLanguage maps 'builtin' to tags.standard(tags.variableName).
  // Style the builtin variable highlight via the standard hierarchy.
  { tag: tags.variableName, color: '#e0e0e8' },
  { tag: tags.standard(tags.variableName), color: '#ffb86c', fontWeight: '500' },
]);

export const faustLanguage = [
  faustStreamLanguage,
  syntaxHighlighting(faustHighlightStyle),
];
