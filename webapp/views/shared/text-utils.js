/**
 * Purpose: Provide shared text rendering helpers for view modules.
 * How: Exports small pure utilities used by multiple code and DOT views.
 */

/**
 * Purpose: Sanitize plain text before HTML insertion.
 * How: Replaces reserved characters with HTML entities.
 */
export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Purpose: Build a line-number gutter as a newline-separated string.
 * How: Generates numbers from 1..N and joins them in display order.
 */
export function generateLineNumbers(lineCount) {
  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(i);
  }
  return lines.join('\n');
}

/**
 * Purpose: Apply placeholder-safe syntax highlighting rules on plain text.
 * How: Escapes HTML once, runs ordered regex replacement rules through protected placeholders, then restores highlighted fragments.
 */
export function highlightWithRules(text, rules, tokenPrefix = '__TOKEN_') {
  const tokens = [];
  let tokenId = 0;

  /**
   * Purpose: Protect highlighted fragments from later regex passes.
   * How: Stores highlighted HTML in a token table and returns a unique marker placeholder.
   */
  function placeholder(html) {
    const id = `${tokenPrefix}${tokenId++}__`;
    tokens.push({ id, html });
    return id;
  }

  let result = escapeHtml(String(text || ''));
  for (const rule of rules || []) {
    if (!rule || !rule.pattern) continue;
    if (rule.replacer) {
      result = result.replace(rule.pattern, (match, ...rest) => {
        const html = rule.replacer(match, ...rest);
        return placeholder(html);
      });
      continue;
    }
    if (rule.className) {
      result = result.replace(rule.pattern, (match) => {
        return placeholder(`<span class="${rule.className}">${match}</span>`);
      });
    }
  }

  for (const token of tokens) {
    result = result.replace(token.id, token.html);
  }
  return result;
}
