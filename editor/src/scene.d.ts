// Ambient type for the JS-only editor scene module so TypeScript stops
// complaining when main.ts imports it. The editor's own tsconfig sets
// allowJs, but the root tsconfig doesn't — so we hand it a typed shim.
export function createEditorScene(container: HTMLElement): void;
