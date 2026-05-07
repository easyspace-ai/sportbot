import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Toaster } from './components/ui/toaster';
import { Markets } from './pages/Markets';
import { History } from './pages/History';
import { Settings } from './pages/Settings';
import { Accounts } from './pages/Accounts';
import { RiskControl } from './pages/RiskControl';

const isPublic = import.meta.env.VITE_PUBLIC_MODE === 'true';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Markets />} />
          {!isPublic && <Route path="history" element={<History />} />}
          <Route path="risk" element={<RiskControl />} />
          <Route path="coverage" element={<Navigate to="/risk" replace />} />
          {!isPublic && <Route path="settings" element={<Settings />} />}
          {!isPublic && <Route path="accounts" element={<Accounts />} />}
        </Route>
      </Routes>
      <Toaster />
    </BrowserRouter>
  );
}
