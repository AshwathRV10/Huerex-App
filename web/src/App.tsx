import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { AppShell } from './components/AppShell';
import { Empty } from './components/ui';
import { Icon } from './components/Icons';

import { Login, ForcePasswordChange } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { OrdersPage, OrderDetailPage } from './pages/Orders';
import { CostingPage } from './pages/Costing';
import { CostSheetPage } from './pages/CostSheet';
import { RatesPage } from './pages/Rates';
import { FabricPage } from './pages/Fabric';
import {
  CuttingPage, FusingPage, JobWorkPage, SewingPage, CheckingPage,
  PackingPage, InspectionPage, ShipmentPage, TrimsPage, ApprovalsPage, WaiversPage,
} from './pages/floor';
import {
  WipPage, ReconciliationPage, TimelinePage, AlertsPage,
  DataAuditPage, CapacityPage, BuyerSummaryPage, BuyerDetailPage,
} from './pages/reports';
import { UsersPage, AuditPage, SettingsPage, MastersPage, BuyersPage, AccountPage } from './pages/admin';

/** A screen the person's role does not include. Says so plainly. */
function NoAccess() {
  const location = useLocation();
  return (
    <Empty
      icon={<Icon.Lock size={20} />}
      title="This screen is not part of your role"
      body={
        <>
          Access to <b>{location.pathname}</b> is restricted. If you need it, an administrator can
          add it to your role — the change takes effect the next time you sign in.
        </>
      }
    />
  );
}

function Guard({ perm, children }: { perm: string; children: React.ReactNode }) {
  const { can } = useSession();
  return can(perm) ? <>{children}</> : <NoAccess />;
}

/** Send people to the first screen their role actually includes. */
function Home() {
  const { can } = useSession();
  if (can('dashboard.view')) return <Dashboard />;
  const first = [
    ['orders.view', '/orders'], ['cutting.view', '/cutting'], ['fabric.view', '/fabric'],
    ['costing.view', '/costing'], ['checking.view', '/checking'], ['users.view', '/users'],
  ].find(([p]) => can(p));
  return first ? <Navigate to={first[1]} replace /> : <NoAccess />;
}

export function App() {
  const { user, loading, refresh } = useSession();

  if (loading) {
    return (
      <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <div className="col" style={{ alignItems: 'center', gap: 'var(--s-3)' }}>
          <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 11, fontSize: 15 }}>HX</span>
          <span className="spinner" />
        </div>
      </div>
    );
  }

  if (!user) return <Login />;
  if (user.must_change_password) return <ForcePasswordChange onDone={() => void refresh()} />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Home />} />

        <Route path="/orders" element={<Guard perm="orders.view"><OrdersPage /></Guard>} />
        <Route path="/orders/:orderNo" element={<Guard perm="orders.view"><OrderDetailPage /></Guard>} />

        <Route path="/costing" element={<Guard perm="costing.view"><CostingPage /></Guard>} />
        <Route path="/costing/:orderNo" element={<Guard perm="costing.view"><CostSheetPage /></Guard>} />
        <Route path="/rates" element={<Guard perm="rates.view"><RatesPage /></Guard>} />

        <Route path="/fabric" element={<Guard perm="fabric.view"><FabricPage /></Guard>} />
        <Route path="/trims" element={<Guard perm="trims.view"><TrimsPage /></Guard>} />

        <Route path="/cutting" element={<Guard perm="cutting.view"><CuttingPage /></Guard>} />
        <Route path="/fusing" element={<Guard perm="fusing.view"><FusingPage /></Guard>} />
        <Route path="/jobwork" element={<Guard perm="jobwork.view"><JobWorkPage /></Guard>} />
        <Route path="/sewing" element={<Guard perm="sewing.view"><SewingPage /></Guard>} />
        <Route path="/checking" element={<Guard perm="checking.view"><CheckingPage /></Guard>} />
        <Route path="/packing" element={<Guard perm="packing.view"><PackingPage /></Guard>} />
        <Route path="/inspection" element={<Guard perm="inspection.view"><InspectionPage /></Guard>} />
        <Route path="/shipment" element={<Guard perm="shipment.view"><ShipmentPage /></Guard>} />
        <Route path="/approvals" element={<Guard perm="approvals.view"><ApprovalsPage /></Guard>} />
        <Route path="/waivers" element={<Guard perm="waivers.view"><WaiversPage /></Guard>} />

        <Route path="/wip" element={<Guard perm="wip.view"><WipPage /></Guard>} />
        <Route path="/reconciliation" element={<Guard perm="reconciliation.view"><ReconciliationPage /></Guard>} />
        <Route path="/timeline" element={<Guard perm="timeline.view"><TimelinePage /></Guard>} />
        <Route path="/alerts" element={<Guard perm="alerts.view"><AlertsPage /></Guard>} />
        <Route path="/data-audit" element={<Guard perm="dataaudit.view"><DataAuditPage /></Guard>} />
        <Route path="/capacity" element={<Guard perm="capacity.view"><CapacityPage /></Guard>} />
        <Route path="/buyer-summary" element={<Guard perm="buyersummary.view"><BuyerSummaryPage /></Guard>} />
        <Route path="/buyer-summary/:buyer" element={<Guard perm="buyersummary.view"><BuyerDetailPage /></Guard>} />

        <Route path="/masters" element={<Guard perm="masters.view"><MastersPage /></Guard>} />
        <Route path="/buyers" element={<Guard perm="buyers.view"><BuyersPage /></Guard>} />
        <Route path="/users" element={<Guard perm="users.view"><UsersPage /></Guard>} />
        <Route path="/audit" element={<Guard perm="audit.view"><AuditPage /></Guard>} />
        <Route path="/settings" element={<Guard perm="settings.view"><SettingsPage /></Guard>} />
        <Route path="/account" element={<AccountPage />} />

        <Route path="*" element={
          <Empty icon={<Icon.Search size={20} />} title="That page does not exist"
            body="Use the search box at the top, or pick a screen from the menu." />
        } />
      </Routes>
    </AppShell>
  );
}
