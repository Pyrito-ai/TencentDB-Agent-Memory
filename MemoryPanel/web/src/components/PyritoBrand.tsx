import './pyrito-brand.css';

/** Shared identity for the app shell, sign-in, and connection guide. */
export function PyritoBrand({ className = '' }: { className?: string }) {
  return (
    <span className={`pyrito-brand ${className}`} role="img" aria-label="pyrito">
      <img className="pyrito-brand-mark" src="/pyrito-crystal.svg" alt="" aria-hidden="true" />
      <span className="pyrito-brand-wordmark" aria-hidden="true">
        pyrito
      </span>
    </span>
  );
}
