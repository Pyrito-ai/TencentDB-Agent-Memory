import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';

export function PageHeading({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="baren-heading">
      <div>
        {eyebrow && <span className="baren-eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div>{actions}</div>}
    </header>
  );
}
export function SurfacePanel({ className = '', ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`baren-panel ${className}`} {...props} />;
}
export function FilterToolbar({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`baren-toolbar ${className}`} {...props} />;
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="baren-empty-state">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function SummaryStrip({
  items,
  valueFirst = false,
  className = '',
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, 'children'> & {
  items: ReadonlyArray<{ label: string; value: ReactNode; className?: string }>;
  valueFirst?: boolean;
}) {
  return (
    <div className={`work-summary ${className}`} {...props}>
      {items.map(({ label, value, className: itemClassName }) => (
        <article key={label} className={itemClassName}>
          {valueFirst ? (
            <>
              <strong>{value}</strong>
              <span>{label}</span>
            </>
          ) : (
            <>
              <span>{label}</span>
              <strong>{value}</strong>
            </>
          )}
        </article>
      ))}
    </div>
  );
}

export function TaskRow({
  title,
  subtitle,
  meta,
  copyClassName,
  metaClassName,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  copyClassName?: string;
  metaClassName?: string;
}) {
  return (
    <button {...props}>
      <span className={copyClassName}>
        <strong>{title}</strong>
        {subtitle !== undefined && <small>{subtitle}</small>}
      </span>
      {meta !== undefined && <span className={metaClassName}>{meta}</span>}
    </button>
  );
}

export function Badge(props: HTMLAttributes<HTMLSpanElement>) {
  return <span {...props} />;
}
