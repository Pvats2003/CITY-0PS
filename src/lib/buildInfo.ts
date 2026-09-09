// Stamped at build time by vite.config.ts's `define`. Importable (unlike a
// bare console.log in main.tsx) so any component — the FO diagnostic panel
// in particular — can render the exact build this page is running as
// visible page text, not just a console line.
declare const __CITY_OPS_BUILD_SHA__: string;
declare const __CITY_OPS_BUILD_TIME__: string;

export const BUILD_SHA = __CITY_OPS_BUILD_SHA__;
export const BUILD_TIME = __CITY_OPS_BUILD_TIME__;
