import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist/wght.css'
import '@fontsource-variable/geist-mono/wght.css'
import { CommandBar } from './CommandBar'
import { OggyApp } from './OggyApp'
import { Setup } from './Setup'
import { Show } from './Show'
import './theme.css'
import './styles.css'

// One renderer bundle, four windows: #/bar is the Ctrl+Space input, #/show is the on-screen
// show mode overlay, #/setup is the first-run setup, anything else is the dashboard.
const hash = window.location.hash
const route = hash.startsWith('#/bar') ? 'bar' : hash.startsWith('#/show') ? 'show' : hash.startsWith('#/setup') ? 'setup' : 'dashboard'
document.body.classList.add(`is-${route}`)

createRoot(document.getElementById('root')!).render(
  <StrictMode>{route === 'bar' ? <CommandBar /> : route === 'show' ? <Show /> : route === 'setup' ? <Setup /> : <OggyApp />}</StrictMode>
)
