import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function NoteMarkdown({ children }: { children: string }) {
  return (
    <div className="ops-note-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target={/^(https?:)?\/\//i.test(href) ? '_blank' : undefined}
                rel="noopener noreferrer"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          // Notes may contain untrusted source text. Images remain explicit links,
          // so viewing a private note never loads tracking pixels or remote media.
          img: ({ src, alt }) =>
            src ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || 'View image'}
              </a>
            ) : (
              <span>{alt}</span>
            ),
          table: ({ children }) => (
            <div className="ops-note-table" tabIndex={0} role="region" aria-label="Note table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
