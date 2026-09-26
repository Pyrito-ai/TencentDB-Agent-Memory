import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import { useTeams } from '@/services';
import { getPanelSession } from '@/lib/panelSession';
import { useCurrentRole } from '@/services/useCurrentRole';
import {
  usePanelAnalyticsEnabled,
  useAnalyticsChConfigured,
} from '@/services/usePanelCapabilities';
import { GlobalCoordinator } from '@/components/GlobalCoordinator';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { DockNavigation } from '@/layouts/DockNavigation';
import { OnboardingGuide, shouldShowOnboarding, resetOnboarding } from '@/layouts/OnboardingGuide';
import { NAV_LABELS, pageForPath, visiblePageIds } from '@/constants/navigation';
import './baren-shell.css';

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

export function ConsoleLayout() {
  const { auth, logout } = useAuthStore();
  const { activeTeamId } = useTeams();
  const coordinatorAvailable = !!activeTeamId && !!getPanelSession();
  const userRole = useCurrentRole();
  const location = useLocation();
  const navigate = useNavigate();
  const activePage = pageForPath(location.pathname);
  const [coordinatorOpen, setCoordinatorOpen] = useState(
    () => window.matchMedia('(min-width: 800px)').matches,
  );
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const currentUserId = auth?.user_id;
  const analyticsSwitchOn = usePanelAnalyticsEnabled();
  const analyticsChConfigured = useAnalyticsChConfigured(analyticsSwitchOn === true);
  const allowedPages = visiblePageIds(
    userRole,
    analyticsSwitchOn === true && analyticsChConfigured !== false,
  );

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) navigate(legacyPath, { replace: true });
    // Legacy links are normalized only once on entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const refresh = () => setRefreshRevision((n) => n + 1);
    window.addEventListener('coordinator-changed', refresh);
    return () => window.removeEventListener('coordinator-changed', refresh);
  }, []);
  useEffect(() => {
    if (currentUserId && shouldShowOnboarding(currentUserId)) setOnboardingVisible(true);
  }, [currentUserId]);
  const replay = useCallback(() => {
    if (!currentUserId) return;
    resetOnboarding(currentUserId);
    setOnboardingVisible(true);
  }, [currentUserId]);
  useEffect(() => {
    window.addEventListener('tdai-replay-onboarding', replay);
    return () => window.removeEventListener('tdai-replay-onboarding', replay);
  }, [replay]);

  return (
    <div className="_memory-app-shell baren-shell">
      <a
        href="#baren-main"
        className="baren-skip-link"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('baren-main')?.focus();
        }}
      >
        Skip to content
      </a>
      <OnboardingGuide
        visible={onboardingVisible}
        userId={currentUserId}
        userRole={userRole}
        onClose={() => setOnboardingVisible(false)}
      />
      <GlobalHeader
        userRole={userRole}
        currentUser={auth?.user ?? ''}
        currentUserId={currentUserId}
        instanceName={auth?.instance_name}
        onLogout={logout}
        pageLabel={activePage ? NAV_LABELS[activePage] : 'Guide'}
        activePage={activePage}
        coordinatorAvailable={coordinatorAvailable}
        coordinatorOpen={coordinatorOpen}
        onToggleCoordinator={() => setCoordinatorOpen((open) => !open)}
      />
      <div
        className={`baren-workspace${coordinatorAvailable && coordinatorOpen ? ' with-coordinator' : ''}`}
      >
        <div className="baren-work-area">
          <div className="baren-page-scroll tea-layout__content-body">
            <main
              id="baren-main"
              tabIndex={-1}
              key={location.pathname + refreshRevision}
              className="_memory-page-frame baren-page-frame"
            >
              <Outlet />
            </main>
          </div>
          <DockNavigation activePage={activePage} allowedPages={allowedPages} />
        </div>
        <GlobalCoordinator open={coordinatorOpen} onClose={() => setCoordinatorOpen(false)} />
      </div>
    </div>
  );
}
