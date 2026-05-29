export type FaustInputWidgetType = 'hslider' | 'vslider' | 'nentry' | 'button' | 'checkbox';
export type FaustPassiveWidgetType = 'hbargraph' | 'vbargraph';
export type FaustWidgetType = FaustInputWidgetType | FaustPassiveWidgetType;
export type FaustGroupType = 'vgroup' | 'hgroup' | 'tgroup';
export type FaustMenuEntry = {
    label: string;
    value: number;
};
export type FaustUIItem = {
    path: string;
    type: FaustWidgetType;
    label: string;
    min: number;
    max: number;
    step: number;
    unit?: string;
    menu?: FaustMenuEntry[];
    menuStyle?: 'menu' | 'radio';
};
export type FaustUiAstGroupNode = {
    kind: 'group';
    type: FaustGroupType;
    label: string;
    children: FaustUiAstNode[];
};
export type FaustUiAstControlNode = {
    kind: 'control';
    item: FaustUIItem;
};
export type FaustUiAstNode = FaustUiAstGroupNode | FaustUiAstControlNode;
export type FaustUiControlSpec = FaustUIItem;
export declare function isFaustWidgetType(type: unknown): type is FaustWidgetType;
export declare function isFaustInputWidgetType(type: unknown): type is FaustInputWidgetType;
export declare function parseFaustUiAstFromUnknown(input: unknown): FaustUiAstNode[];
export declare function flattenFaustUiAstToItems(ast: FaustUiAstNode[]): FaustUIItem[];
export declare function parseFaustUiItemsFromUnknown(input: unknown): FaustUIItem[];
export declare function parseFaustUiControlsFromUnknown(input: unknown): FaustUiControlSpec[];
//# sourceMappingURL=faust-ui-parse.d.ts.map