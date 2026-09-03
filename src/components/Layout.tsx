import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { QUEUE_LIMIT, subscribeToDueCount } from '../lib/review'

export function Layout() {
  const { user, isOwner } = useAuth()
  const due = useDueCount()

  return (
    <div className="app">
      <header className="app-header">
        {isOwner && (
          <NavLink to="/admin" className="admin-link">
            Admin
          </NavLink>
        )}
        {/* Was an immediate sign-out. Now it opens Settings, which is where
            sign-out lives - one mis-tap should not end your session, and
            Settings needed a door anyway. The bottom nav stays at three: it is
            thumb-reachable space for the things you do daily. */}
        <NavLink className="avatar" to="/settings" title={user?.email ?? 'Settings'}>
          {user?.email?.[0]?.toUpperCase() ?? '?'}
        </NavLink>
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
          <span className="nav-icon">
            <Icon d="M4 5h16v11H4zM8 20h8M12 16v4" />
            {due > 0 && (
              <span className="nav-badge">
                {due > QUEUE_LIMIT ? `${QUEUE_LIMIT}+` : due}
              </span>
            )}
          </span>
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

/**
 * The due count on the Review tab.
 *
 * Until Phase 4's push notification exists this is the entire daily-open
 * mechanism: a number on a tab you already look at. One capped listener for
 * the life of the session, which is cheap enough to justify that.
 *
 * The query pins "now" at subscribe time and a listener never re-evaluates it
 * as the clock moves, so it is re-issued whenever you change screens. Not
 * precision - but it makes the count right at the moments you could act on it.
 */
function useDueCount(): number {
  const { user } = useAuth()
  const { pathname } = useLocation()
  const [due, setDue] = useState(0)

  // `pathname` is in the dependency list purely to re-issue the query with a
  // current "now" when you move between screens. It is not used in the body.
  useEffect(() => {
    if (!user) return
    return subscribeToDueCount(user.uid, new Date(), QUEUE_LIMIT, setDue)
  }, [user, pathname])

  return due
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}
