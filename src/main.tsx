import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

declare const __CITY_OPS_BUILD_SHA__: string
declare const __CITY_OPS_BUILD_TIME__: string

// Always-on (not DEV-gated), emitted before anything else in the app runs —
// the one line that answers "is production actually running the commit I
// just pushed?" directly from the browser console, instead of inferring it
// from unrelated log text. Deliberately loud (a visual separator plus two
// primitive-only lines) so it can't be missed or mistaken for a collapsed
// object in a screenshot. Not sensitive: just the git SHA and ISO build
// timestamp this bundle was built from (see vite.config.ts).
console.log('[CITY-OPS-DIAG] ================================================')
console.log('[CITY-OPS-DIAG] BUILD_SHA=' + __CITY_OPS_BUILD_SHA__)
console.log('[CITY-OPS-DIAG] BUILD_TIME=' + __CITY_OPS_BUILD_TIME__)
console.log('[CITY-OPS-DIAG] ================================================')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
