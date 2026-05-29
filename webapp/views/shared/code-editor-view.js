/**
 * Purpose: Provide shared interaction logic for source-code editor views.
 * How: Encapsulates synchronized scrolling, top-line persistence, zoom handling, and deferred scroll restoration.
 */

/**
 * Purpose: Attach shared scroll/zoom behavior to a code editor pair.
 * How: Synchronizes gutter scroll, tracks top line, restores saved position, and applies zoom while preserving viewport.
 */
export function setupCodeEditorInteractions(options) {
  const {
    lineNumbersEl,
    codeContentEl,
    zoomSelectEl,
    lineCount,
    scrollState,
    onScrollChange,
    minZoom = 50,
    maxZoom = 200,
    defaultZoom = 100
  } = options || {};

  if (!lineNumbersEl || !codeContentEl) {
    return {
      getTopLine: () => 1
    };
  }

  const baseLineNumbersFontSize = parseFloat(getComputedStyle(lineNumbersEl).fontSize) || 14;
  const baseCodeFontSize = parseFloat(getComputedStyle(codeContentEl).fontSize) || 14;

  let lineHeight =
    (lineNumbersEl.scrollHeight && lineCount
      ? lineNumbersEl.scrollHeight / lineCount
      : parseFloat(getComputedStyle(codeContentEl).lineHeight)) || 16;
  let restoring = true;

  /**
   * Purpose: Mirror code scrolling into the line-number gutter.
   * How: Copies the code panel `scrollTop` to the gutter.
   */
  function syncScroll() {
    lineNumbersEl.scrollTop = codeContentEl.scrollTop;
  }

  /**
   * Purpose: Compute which source line is currently at the top of the viewport.
   * How: Converts `scrollTop` to a 1-based line index using measured line height.
   */
  function getTopLine() {
    return Math.floor(codeContentEl.scrollTop / lineHeight) + 1;
  }

  /**
   * Purpose: Persist user scroll position to parent state.
   * How: Emits current top line through `onScrollChange` when not restoring prior state.
   */
  function capture() {
    if (restoring) return;
    if (typeof onScrollChange === 'function') {
      onScrollChange(getTopLine());
    }
  }

  codeContentEl.addEventListener('scroll', () => {
    syncScroll();
    capture();
  });

  /**
   * Purpose: Restore the code view so a given line appears at the top.
   * How: Computes target scroll offset and applies bounded corrective passes across animation frames.
   */
  function applyTopLine(line) {
    if (typeof line !== 'number') return;
    const maxScroll = codeContentEl.scrollHeight - codeContentEl.clientHeight;
    const target = Math.max(0, Math.min(maxScroll, (line - 1) * lineHeight));

    /**
     * Purpose: Correct residual top-line drift after layout updates.
     * How: Re-reads visible line index and adjusts `scrollTop` for a few bounded attempts.
     */
    function applyWithCorrection(attempt = 0) {
      codeContentEl.scrollTop = target;
      syncScroll();
      requestAnimationFrame(() => {
        const currentTop = getTopLine();
        const diff = line - currentTop;
        if (diff !== 0 && attempt < 3) {
          const corrected = Math.max(
            0,
            Math.min(maxScroll, codeContentEl.scrollTop + diff * lineHeight)
          );
          codeContentEl.scrollTop = corrected;
          syncScroll();
          requestAnimationFrame(() => applyWithCorrection(attempt + 1));
        }
      });
    }

    applyWithCorrection();
  }

  /**
   * Purpose: Refresh the measured line height used for scroll calculations.
   * How: Derives from rendered gutter metrics and falls back to computed styles.
   */
  function refreshLineHeight() {
    lineHeight =
      (lineNumbersEl.scrollHeight && lineCount
        ? lineNumbersEl.scrollHeight / lineCount
        : parseFloat(getComputedStyle(codeContentEl).lineHeight)) || lineHeight || 16;
  }

  /**
   * Purpose: Apply editor zoom while preserving reading position.
   * How: Scales font sizes, recomputes line height, then restores prior top line.
   */
  function applyZoom(zoom) {
    const factor = Math.max(minZoom, Math.min(maxZoom, Number(zoom) || defaultZoom)) / 100;
    const topLine = getTopLine();
    lineNumbersEl.style.fontSize = `${(baseLineNumbersFontSize * factor).toFixed(2)}px`;
    codeContentEl.style.fontSize = `${(baseCodeFontSize * factor).toFixed(2)}px`;
    refreshLineHeight();
    applyTopLine(topLine);
  }

  if (zoomSelectEl) {
    zoomSelectEl.addEventListener('change', () => applyZoom(parseInt(zoomSelectEl.value, 10)));
  }
  applyZoom(defaultZoom);

  if (scrollState && typeof scrollState.line === 'number') {
    let attempts = 0;

    /**
     * Purpose: Wait until layout is stable before restoring saved scroll.
     * How: Retries on animation frames until content becomes scrollable or a max attempt threshold is reached.
     */
    function settle() {
      attempts += 1;
      if (codeContentEl.scrollHeight > codeContentEl.clientHeight || attempts >= 5) {
        applyTopLine(scrollState.line);
        requestAnimationFrame(() => {
          restoring = false;
        });
        return;
      }
      requestAnimationFrame(settle);
    }
    requestAnimationFrame(settle);
  } else {
    restoring = false;
  }

  return {
    getTopLine,
    applyTopLine,
    applyZoom
  };
}
