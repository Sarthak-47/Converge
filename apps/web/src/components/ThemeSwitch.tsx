import { useState } from 'react'
import { setThemeChoice, themeChoice, type ThemeChoice } from '../theme.ts'
import { Icon, type IconName } from './Icon.tsx'

const OPTIONS: { value: ThemeChoice; icon: IconName; label: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light theme' },
  { value: 'system', icon: 'monitor', label: 'Match the system theme' },
  { value: 'dark', icon: 'moon', label: 'Dark theme' },
]

export function ThemeSwitch() {
  const [choice, setChoice] = useState(themeChoice)
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={choice === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => {
            setThemeChoice(o.value)
            setChoice(o.value)
          }}
        >
          <Icon name={o.icon} size={14} />
        </button>
      ))}
    </div>
  )
}
