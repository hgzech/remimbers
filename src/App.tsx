import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { AuthGate } from './auth/AuthGate'
import { Layout } from './components/Layout'
import { Capture } from './routes/Capture'
import { Review } from './routes/Review'
import { Library } from './routes/Library'

// import.meta.env.BASE_URL is '/remimbers/' on GitHub Pages, '/' locally.
// Router basename must match or every route 404s after deploy.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '')

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <BrowserRouter basename={basename}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Capture />} />
              <Route path="/review" element={<Review />} />
              <Route path="/library" element={<Library />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthGate>
    </AuthProvider>
  )
}
