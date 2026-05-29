/**
 * Purpose: Provide shared UI utilities for tooltip behavior in the app shell.
 * How: Creates scoped tooltip helpers that infer labels and schedule DOM updates with requestAnimationFrame.
 */

/**
 * Purpose: Build tooltip helper functions bound to one tooltip text dictionary.
 * How: Returns `applyTooltips` and `scheduleTooltipApply` with isolated internal scheduling state.
 */
export function createTooltipManager(tooltipTexts) {
  let tooltipApplyRaf = null;

  /**
   * Purpose: Extract visible label text for a form control.
   * How: Clones the nearest `<label>`, removes interactive children, and normalizes whitespace.
   */
  function extractLabelText(el) {
    const label = el.closest('label');
    if (!label) return '';
    const clone = label.cloneNode(true);
    clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Purpose: Infer the best tooltip text for a UI element.
   * How: Prioritizes aria labels and known dictionaries, then falls back to label text and generic control hints.
   */
  function inferTooltip(el) {
    if (!el || !(el instanceof HTMLElement)) return '';
    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    if (ariaLabel) {
      const key = ariaLabel.toLowerCase();
      if (tooltipTexts.byLabel[key]) return tooltipTexts.byLabel[key];
      return ariaLabel;
    }

    if (el.id === 'session-label' && !el.classList.contains('clickable')) {
      return 'Current session';
    }

    const byId = el.id && tooltipTexts.byId[el.id] ? tooltipTexts.byId[el.id] : '';
    if (byId) return byId;

    const labelText = extractLabelText(el);
    if (labelText) {
      const key = labelText.toLowerCase();
      if (tooltipTexts.byLabel[key]) return tooltipTexts.byLabel[key];
      if (el.tagName === 'SELECT') return `Select ${labelText.toLowerCase()}`;
      if (el.tagName === 'INPUT') return `Set ${labelText.toLowerCase()}`;
      return labelText;
    }

    if (el.matches('.midi-key')) {
      const note = (el.textContent || '').trim();
      return note ? `${tooltipTexts.generic.playMidiNote} ${note}` : tooltipTexts.generic.playMidiNote;
    }

    if (el.tagName === 'BUTTON') {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const key = text.toLowerCase();
      if (tooltipTexts.byButtonText[key]) return tooltipTexts.byButtonText[key];
      return text ? `Activate ${text.toLowerCase()}` : tooltipTexts.generic.activateControl;
    }

    if (el.tagName === 'SELECT') {
      return tooltipTexts.generic.selectOption;
    }

    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'number' || type === 'range') return tooltipTexts.generic.setValue;
      if (type === 'checkbox') return tooltipTexts.generic.toggleOption;
      if (type === 'file') return tooltipTexts.byId['file-input'] || tooltipTexts.generic.enterValue;
      return tooltipTexts.generic.enterValue;
    }

    if (el.tagName === 'TEXTAREA') {
      return tooltipTexts.generic.enterText;
    }

    if (el.getAttribute('role') === 'button') {
      return tooltipTexts.generic.activateControl;
    }

    return '';
  }

  /**
   * Purpose: Apply inferred tooltip attributes to interactive elements in a DOM subtree.
   * How: Scans known selectors, infers per-element text, and writes `title` attributes.
   */
  function applyTooltips(root = document) {
    const selectors = [
      'button',
      'select',
      'input',
      'textarea',
      '[role="button"]',
      '.midi-key',
      '#session-label.clickable'
    ].join(', ');
    root.querySelectorAll(selectors).forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const hint = inferTooltip(el);
      if (hint) el.setAttribute('title', hint);
    });
  }

  /**
   * Purpose: Batch tooltip updates to the next animation frame.
   * How: Coalesces repeated calls with one RAF ticket and applies tooltips once per frame.
   */
  function scheduleTooltipApply(root = document) {
    if (tooltipApplyRaf) return;
    tooltipApplyRaf = requestAnimationFrame(() => {
      tooltipApplyRaf = null;
      applyTooltips(root);
    });
  }

  return { applyTooltips, scheduleTooltipApply };
}
