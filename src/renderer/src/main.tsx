import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './shell.css'

// The shell owns the window-level layout (html/body/#root heights, boot screen);
// the call UI brings its own stylesheets (call/index.tsx imports styles/call.css
// and styles/panels.css) and renders inside the space this file defines.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
