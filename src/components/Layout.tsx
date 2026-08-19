import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'

export function Layout() {
  const { user, signOutNow } = useAuth()

  return (
    <div className="app">
      <header className="app-header">
        <span className="wordmark small">remimbers</span>
        <button
          className="avatar"
          onClick={signOutNow}
          title={`${user?.email} — click to sign out`}
        >
          {user?.email?.[0]?.toUpperCase() ?? '?'}
        </button>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      {/* Bottom nav, not top: this is a one-handed phone app. */}
      <nav className="app-nav">
        <NavLink to="/" end>
          <Icon d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11a7 7 0 0 0 14 0M12 18v3" />
          <span>Capture</span>
        </NavLink>
        <NavLink to="/review">
          <Icon d="M4 5h16v11H4zM8 20h8M12 16v4" />
          <span>Review</span>
        </NavLink>
        <NavLink to="/library">
          <Icon d="M5 4h4v16H5zM11 4h3v16h-3zM16 5l4 15" />
          <span>Library</span>
        </NavLink>
      </nav>
    </div>
  )
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
