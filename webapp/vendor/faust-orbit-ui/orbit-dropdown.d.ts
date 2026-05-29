/**
 * Generic custom dropdown — replaces the native `<select>` popup so we
 * have full theming control. The underlying `<select>` is kept in the
 * DOM as the state holder: setting `select.value` and dispatching a
 * synthetic `change` event lets existing event handlers (FaustOrbitUI's
 * own zoom/random change listeners, OrbitUI's preset change handler)
 * continue to work unchanged.
 *
 * Use `enableCustomDropdown(select)` to swap a native popup for a
 * theme-styled one. Use `openDropdownMenu(opts)` for ad-hoc menus that
 * don't have a matching `<select>`.
 */
export type DropdownItem = {
    kind: 'option';
    value: string;
    label: string;
    disabled?: boolean;
    active?: boolean;
} | {
    kind: 'separator';
};
export type DropdownOptions = {
    /** Anchor under which the menu opens (its bottom-left corner).
     *  Mutually exclusive with `position`. */
    anchor?: HTMLElement;
    /** Open the menu directly at viewport coords — useful for context
     *  menus triggered by `contextmenu` events. Mutually exclusive with
     *  `anchor`. */
    position?: {
        left: number;
        top: number;
    };
    items: ReadonlyArray<DropdownItem>;
    onPick: (value: string) => void;
    /** Where to attach the menu element. Defaults to `document.body`.
     *  Components that render inside a shadow root pass their shadow
     *  here so the menu inherits the shadow's stylesheet. */
    mountRoot?: ParentNode;
};
/** Open a theme-styled popup anchored under `opts.anchor`. Returns a
 *  function that closes the popup. The popup also closes on outside
 *  pointerdown, Esc, scroll, and window resize. */
export declare function openDropdownMenu(opts: DropdownOptions): () => void;
/** Bind a native `<select>` to a custom dropdown. Mousedown / Enter /
 *  ArrowDown on the select open the themed popup; picking sets
 *  `select.value` and dispatches a `change` event so existing listeners
 *  fire. */
export declare function enableCustomDropdown(select: HTMLSelectElement, itemsBuilder?: () => ReadonlyArray<DropdownItem>, mountRoot?: ParentNode): () => void;
//# sourceMappingURL=orbit-dropdown.d.ts.map