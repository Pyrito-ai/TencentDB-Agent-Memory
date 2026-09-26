import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion';
import {
  Sun,
  Columns3,
  FolderOpen,
  Repeat2,
  SquareTerminal,
  BookOpen,
  Brain,
  Ellipsis,
  CalendarDays,
  Layers3,
  Clock3,
  Code2,
  WandSparkles,
  Users,
  Bot,
  KeyRound,
  ChartNoAxesCombined,
  ArrowUpRight,
} from 'lucide-react';
import type { PageId } from '@/constants/menu';
import { DOCK_PAGES, MORE_GROUPS, NAV_LABELS, PAGE_PATHS } from '@/constants/navigation';
import './dock-navigation.css';

const icons: Record<PageId, ReactNode> = {
  today: <Sun />,
  workbench_board: <Columns3 />,
  projects: <FolderOpen />,
  loops: <Repeat2 />,
  orca_workbench: <SquareTerminal />,
  wiki: <BookOpen />,
  chat_memory: <Brain />,
  upcoming: <CalendarDays />,
  areas: <Layers3 />,
  timesheets: <Clock3 />,
  code: <Code2 />,
  skills: <WandSparkles />,
  team_members: <Users />,
  team_agents: <Bot />,
  api_keys: <KeyRound />,
  analytics: <ChartNoAxesCombined />,
};

function DockItem({
  id,
  mouseX,
  animate,
  active,
}: {
  id: PageId;
  mouseX: MotionValue<number>;
  animate: boolean;
  active: boolean;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  const distance = useTransform(mouseX, (x) => {
    const bounds = ref.current?.getBoundingClientRect();
    return bounds ? x - bounds.left - bounds.width / 2 : Infinity;
  });
  const target = useTransform(distance, [-150, 0, 150], [48, 68, 48]);
  const size = useSpring(target, { mass: 0.1, stiffness: 180, damping: 18 });
  return (
    <motion.div className="baren-dock-item" style={animate ? { width: size } : undefined}>
      <Link
        ref={ref}
        to={PAGE_PATHS[id]}
        aria-label={NAV_LABELS[id]}
        aria-current={active ? 'page' : undefined}
        data-guide={id === 'wiki' ? 'tab-wiki' : undefined}
        className={`baren-dock-link${active ? ' is-active' : ''}`}
        data-page={id}
      >
        <span className="baren-dock-tooltip" aria-hidden="true">
          {NAV_LABELS[id]}
        </span>
        <span className="baren-dock-tile">{icons[id]}</span>
        <span className="baren-dock-indicator" />
      </Link>
    </motion.div>
  );
}

export function DockNavigation({
  activePage,
  allowedPages,
}: {
  activePage: PageId | null;
  allowedPages: PageId[];
}) {
  const location = useLocation();
  const reduced = useReducedMotion();
  const [finePointer, setFinePointer] = useState(false);
  const [compact, setCompact] = useState(false);
  const [menuHeight, setMenuHeight] = useState(400);
  const [moreOpen, setMoreOpen] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const mouseX = useMotionValue(Infinity);
  const groups = MORE_GROUPS.map((group) => ({
    ...group,
    pages: group.pages.filter((id) => allowedPages.includes(id)),
  })).filter((group) => group.pages.length);
  const moreActive = !!activePage && groups.some((group) => group.pages.includes(activePage));
  useEffect(() => {
    const area = layer.current?.parentElement;
    if (!area) return;
    const update = () => {
      const { width, height } = area.getBoundingClientRect();
      const narrow = width < 640;
      setCompact(narrow);
      setMenuHeight(Math.max(80, Math.min(650, height - (narrow ? 110 : 144))));
    };
    const observer = new ResizeObserver(update);
    observer.observe(area);
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 640px)');
    const update = () => setFinePointer(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    setMoreOpen(false);
    mouseX.set(Infinity);
  }, [location.pathname, mouseX]);
  useEffect(() => {
    if (!moreOpen) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!layer.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [moreOpen]);
  const close = () => {
    setMoreOpen(false);
    more.current?.focus();
  };
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      // Restore a stable tab-order anchor before React unmounts the menu.
      close();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }
  return (
    <div className={`baren-dock-layer${compact ? ' is-compact' : ''}`} ref={layer}>
      {moreOpen && (
        <div
          className="baren-more-menu"
          style={{ maxHeight: menuHeight }}
          id="baren-more-menu"
          role="menu"
          aria-label="More pages"
          ref={menu}
          onKeyDown={menuKey}
        >
          {groups.map((group) => (
            <div role="group" aria-label={group.label} key={group.label}>
              <p role="presentation">{group.label}</p>
              {group.pages.map((id) => (
                <Link
                  role="menuitem"
                  key={id}
                  to={PAGE_PATHS[id]}
                  aria-current={activePage === id ? 'page' : undefined}
                  onClick={() => setMoreOpen(false)}
                >
                  {icons[id]}
                  <span>{NAV_LABELS[id]}</span>
                  <ArrowUpRight className="baren-more-arrow" />
                </Link>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="baren-dock-scroll">
        <nav
          aria-label="Main navigation"
          className="baren-dock"
          onPointerMove={(event) => {
            if (finePointer && !compact && !reduced && !moreOpen) mouseX.set(event.clientX);
          }}
          onPointerLeave={() => mouseX.set(Infinity)}
        >
          {DOCK_PAGES.filter((id) => allowedPages.includes(id)).map((id) => (
            <DockItem
              key={id}
              id={id}
              active={id === activePage}
              mouseX={mouseX}
              animate={finePointer && !compact && !reduced && !moreOpen}
            />
          ))}
          <span className="baren-dock-separator" aria-hidden="true" />
          <div className="baren-dock-item baren-dock-more">
            <button
              ref={more}
              type="button"
              className={`baren-dock-link${moreActive || moreOpen ? ' is-active' : ''}`}
              aria-label="More pages"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-controls={moreOpen ? 'baren-more-menu' : undefined}
              onClick={() => {
                mouseX.set(Infinity);
                setMoreOpen(!moreOpen);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMoreOpen(true);
                }
              }}
            >
              <span className="baren-dock-tooltip" aria-hidden="true">
                {moreActive && activePage ? `More · ${NAV_LABELS[activePage]}` : 'More'}
              </span>
              <span className="baren-dock-tile">
                <Ellipsis />
              </span>
              <span className="baren-dock-indicator" />
            </button>
          </div>
        </nav>
      </div>
    </div>
  );
}
