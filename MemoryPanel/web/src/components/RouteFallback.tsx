import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { EmptyState } from '@/components/baren';

/** Unknown routes render inside the console shell so navigation stays available. */
export function NotFoundPage() {
  return (
    <EmptyState title="Page not found">
      <p>This page doesn’t exist or has moved.</p>
      <p>
        <Link to="/">Go to the board</Link>
      </p>
    </EmptyState>
  );
}

/** Render errors stay contained: inside the shell for pages, full page only if the shell fails. */
export function RouteErrorPage() {
  const error = useRouteError();
  if (isRouteErrorResponse(error) && error.status === 404) return <NotFoundPage />;
  console.error(error);
  return (
    <div role="alert">
      <EmptyState title="Something went wrong">
        <p>This page hit an unexpected error. Your saved work is unaffected.</p>
        <p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>{' '}
          <a href="#/">Go to the board</a>
        </p>
      </EmptyState>
    </div>
  );
}
