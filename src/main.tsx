import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

declare const __CITY_OPS_BUILD_COMMIT__: string

// Always-on (not DEV-gated) — the one line that answers "is production
// actually running the commit I just pushed?" directly from the browser
// console, instead of inferring it from unrelated log text. Not sensitive:
// just the short git SHA this bundle was built from (see vite.config.ts).
console.info('[CITY-OPS-DIAG] build', { commit: __CITY_OPS_BUILD_COMMIT__ })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
