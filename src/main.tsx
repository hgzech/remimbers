import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { exposeDevHandle } from './lib/functions'
import './index.css'

// Console handle for the Phase 1 prompt evals. See src/lib/functions.ts.
exposeDevHandle()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
