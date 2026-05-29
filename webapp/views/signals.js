/**
 * Purpose: Define the Signals view that displays a Faust signal graph from DOT data.
 * How: Delegates rendering/dispose behavior to the shared DOT graph view engine with Signals-specific options.
 */
import { disposeDotGraphView, renderDotGraphView } from './shared/dot-view.js';

/**
 * Purpose: Expose the label used by the global view selector.
 * How: Returns the static display name for this module.
 */
export function getName() {
  return 'Signals';
}

/**
 * Purpose: Render the Signals view for the current session.
 * How: Invokes the shared DOT renderer with Signals endpoint, labels, and CSS class prefix.
 */
export async function render(container, { sha, sessionFilename, onError, onClearError, onDownload }) {
  await renderDotGraphView(container, {
    sha,
    sessionFilename,
    dotFile: 'signals.dot',
    notAvailableMessage: 'Signals graph not available',
    title: 'SIGNAL GRAPH',
    classPrefix: 'signals',
    zoomAriaLabel: 'Signal graph zoom',
    onError,
    onClearError,
    onDownload
  });
}

/**
 * Purpose: Release Signals view resources on teardown.
 * How: Delegates disposal to the shared DOT graph view no-op hook.
 */
export function dispose() {
  disposeDotGraphView();
}
