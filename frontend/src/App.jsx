import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import LoginPage from './pages/LoginPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import ImportPage from './pages/ImportPage.jsx';
import ReconOpdPage from './pages/ReconOpdPage.jsx';
import MappingsPage from './pages/MappingsPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import AccountPage from './pages/AccountPage.jsx';
import FundReconPage from './pages/FundReconPage.jsx';
import FundSettingsPage from './pages/FundSettingsPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="account" element={<AccountPage />} />
          {/* หน้าที่มีข้อมูลรายคนไข้: ผู้บริหารเข้าไม่ได้ */}
          <Route element={<ProtectedRoute roles={['admin', 'user']} />}>
            <Route path="import" element={<ImportPage />} />
            <Route path="recon/opd" element={<ReconOpdPage />} />
            <Route path="recon/funds" element={<FundReconPage />} />
            <Route path="reports" element={<ReportsPage />} />
          </Route>
          <Route element={<ProtectedRoute roles={['admin']} />}>
            <Route path="mappings" element={<MappingsPage />} />
            <Route path="funds/settings" element={<FundSettingsPage />} />
            <Route path="users" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
