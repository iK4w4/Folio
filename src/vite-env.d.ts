/// <reference types="vite/client" />

// Build-time app version, injected by vite.config.ts `define` from
// package.json (single source of truth). Shown in the About modal so a bug
// report can always name the exact build that is running.
declare const __APP_VERSION__: string;
