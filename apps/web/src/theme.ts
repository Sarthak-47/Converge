// Light, dark or the system's choice. The choice is a per-browser convenience: it lives in localStorage, and
// everything still renders correctly (following the system) when storage is unavailable.
export type ThemeChoice = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'converge.theme'
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<(theme: Theme) => void>()

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

let choice: ThemeChoice = stored()

export function themeChoice(): ThemeChoice {
  return choice
}

export function currentTheme(): Theme {
  if (choice !== 'system') return choice
  return darkScheme.matches ? 'dark' : 'light'
}

function apply() {
  const root = document.documentElement
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
  const theme = currentTheme()
  root.style.colorScheme = theme
  for (const listener of listeners) listener(theme)
}

export function setThemeChoice(next: ThemeChoice) {
  choice = next
  try {
    if (next === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, next)
  } catch {
    // Storage blocked: the choice still holds for this page.
  }
  apply()
}

/** Calls `listener` whenever the effective theme changes; returns the unsubscribe function. */
export function onThemeChange(listener: (theme: Theme) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

darkScheme.addEventListener('change', () => {
  if (choice === 'system') apply()
})
apply()
