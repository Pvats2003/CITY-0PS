import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { BUILD_SHA, BUILD_TIME } from './lib/buildInfo'

// Always-on (not DEV-gated), emitted before anything else in the app runs —
// the one line that answers "is production actually running the commit I
// just pushed?" directly from the browser console, instead of inferring it
// from unrelated log text. Deliberately loud (a visual separator plus two
// primitive-only lines) so it can't be missed or mistaken for a collapsed
// object in a screenshot. Not sensitive: just the git SHA and ISO build
// timestamp this bundle was built from (see vite.config.ts). Also rendered
// as page text (not just logged) on the FO diagnostic panel — see
// src/components/FoDiagnosticPanel.tsx — since console output alone has
// proven unreliable to capture from production.
console.log('[CITY-OPS-DIAG] ================================================')
console.log('[CITY-OPS-DIAG] BUILD_SHA=' + BUILD_SHA)
console.log('[CITY-OPS-DIAG] BUILD_TIME=' + BUILD_TIME)
console.log('[CITY-OPS-DIAG] ================================================')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
