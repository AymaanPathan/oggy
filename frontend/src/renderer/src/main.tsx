import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import { CommandBar } from './CommandBar'
import { OggyApp } from './OggyApp'
import { Show } from './Show'
import './theme.css'
import './styles.css'

// One renderer bundle, three windows: #/bar is the Ctrl+Space input, #/show is the on-screen
// show mode overlay, anything else is the dashboard.
const route = window.location.hash.startsWith('#/bar') ? 'bar' : window.location.hash.startsWith('#/show') ? 'show' : 'dashboard'
document.body.classList.add(`is-${route}`)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{route === 'bar' ? <CommandBar /> : route === 'show' ? <Show /> : <OggyApp />}</StrictMode>
)
