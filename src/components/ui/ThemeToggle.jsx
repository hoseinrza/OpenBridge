import { useTheme } from '../../hooks/useTheme.js';

export default function ThemeToggle({ className = '' }) {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      className={`icon-btn ${className}`}
      onClick={toggleTheme}
      title={dark ? 'حالت روشن' : 'حالت تیره'}
      aria-label={dark ? 'تغییر به حالت روشن' : 'تغییر به حالت تیره'}
    >
      <i className={`fas fa-${dark ? 'sun' : 'moon'}`} aria-hidden="true" />
    </button>
  );
}
