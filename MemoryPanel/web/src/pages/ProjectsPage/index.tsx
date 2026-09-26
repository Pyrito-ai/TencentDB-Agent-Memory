import { Navigate, useLocation } from 'react-router-dom';
import { legacyProjectsLocation } from '@/constants/navigation';

/** Preserve shared links and bookmarks after combining Projects with Task board. */
export function ProjectsPage() {
  const { search } = useLocation();
  return <Navigate to={legacyProjectsLocation(search)} replace />;
}
