/**
 * Purpose: Define the Tasks view that displays a Faust task graph from DOT data.
 * How: Delegates rendering/dispose behavior to the shared DOT graph view engine with Tasks-specific options.
 */
import { disposeDotGraphView, renderDotGraphView } from './shared/dot-view.js';

/**
 * Purpose: Expose the label used by the global view selector.
 * How: Returns the static display name for this module.
 */
export function getName() {
  return 'Tasks';
}

/**
 * Purpose: Render the Tasks view for the current session.
 * How: Invokes the shared DOT renderer with Tasks endpoint, labels, and CSS class prefix.
 */
export async function render(container, { sha, sessionFilename, onError, onClearError, onDownload }) {
  await renderDotGraphView(container, {
    sha,
    sessionFilename,
    dotFile: 'tasks.dot',
    notAvailableMessage: 'Tasks graph not available',
    title: 'TASK GRAPH',
    classPrefix: 'tasks',
    zoomAriaLabel: 'Task graph zoom',
    onError,
    onClearError,
    onDownload
  });
}

/**
 * Purpose: Release Tasks view resources on teardown.
 * How: Delegates disposal to the shared DOT graph view no-op hook.
 */
export function dispose() {
  disposeDotGraphView();
}
