import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import './index.css'
import { AuthProvider } from './auth.tsx'
import { RequireAuth } from './pages/RequireAuth.tsx'
import { AuthPage } from './pages/AuthPage.tsx'
import { WorkspacesPage } from './pages/WorkspacesPage.tsx'
import { StatusPage } from './pages/StatusPage.tsx'

// The IDE (and the Monaco bundle it pulls in) loads only when a workspace is opened.
// eslint-disable-next-line react/only-export-components -- entry module, never hot-reloaded as a component
const WorkspacePage = lazy(() => import('./pages/WorkspacePage.tsx'))

const router = createBrowserRouter([
  { path: '/login', element: <AuthPage mode="login" /> },
  { path: '/register', element: <AuthPage mode="register" /> },
  { path: '/status', element: <StatusPage /> },
  {
    element: <RequireAuth />,
    children: [
      { path: '/', element: <WorkspacesPage /> },
      {
        path: '/w/:workspaceId',
        element: (
          <Suspense fallback={<div className="center muted">Loading workspace…</div>}>
            <WorkspacePage />
          </Suspense>
        ),
      },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
)
