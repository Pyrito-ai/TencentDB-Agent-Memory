import { useEffect } from 'react';

/** Tea portals keep their own Escape/transition handling. This supplies the
 * accessible name, two-way Tab boundary and return focus missing from Tea's
 * sentinel-only focus handling, including dialogs opened by Modal.confirm. */
export function DialogAccessibility() {
  useEffect(() => {
    const openers = new Map<HTMLElement, HTMLElement | null>();
    let lastOutside: HTMLElement | null = null;
    let restoring = 0;
    const dialogs = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('.tea-dialog[role="dialog"], .tea-drawer'),
      ).filter((dialog) => dialog.getClientRects().length > 0);
    const focusable = (dialog: HTMLElement) =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, a[href], input, textarea, select, [tabindex]',
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled, [aria-hidden="true"]') &&
          element.getClientRects().length > 0,
      );
    const sync = () => {
      const visible = dialogs();
      for (const dialog of visible) {
        if (openers.has(dialog)) continue;
        openers.set(dialog, lastOutside);
        dialog.setAttribute('role', 'dialog');
        // Drawers without a mask remain non-modal; keyboard users can leave them.
        dialog.setAttribute('aria-modal', String(dialog.classList.contains('tea-dialog')));
        if (!dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby')) {
          const heading = dialog.querySelector('.tea-dialog__headertitle, .tea-drawer__header h3');
          if (heading?.textContent) dialog.setAttribute('aria-label', heading.textContent);
        }
      }
      for (const [dialog, opener] of openers) {
        if (visible.includes(dialog)) continue;
        openers.delete(dialog);
        if (opener?.isConnected && (!visible.length || visible.at(-1)?.contains(opener))) {
          cancelAnimationFrame(restoring);
          restoring = requestAnimationFrame(() => {
            const top = dialogs().at(-1);
            if (!top || top.contains(opener)) opener.focus({ preventScroll: true });
          });
        }
      }
    };
    const remember = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (!target.closest('.tea-dialog-parent, .tea-drawer-open') && target !== document.body) {
        lastOutside = target.closest<HTMLElement>(
          'button, a[href], input, textarea, select, [tabindex]',
        );
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const dialog = dialogs().at(-1);
      if (!dialog || dialog.getAttribute('aria-modal') !== 'true') return;
      const items = focusable(dialog);
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (!dialog.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('focusin', remember, true);
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('keydown', keydown, true);
    sync();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(restoring);
      document.removeEventListener('focusin', remember, true);
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, []);
  return null;
}
