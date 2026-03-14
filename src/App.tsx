import { useEffect, useState } from "react";
import { HealthCheck } from "./components/HealthCheck";
import { MemberSearch } from "./components/MemberSearch";
import { BillSearch } from "./components/BillSearch";
import { FecSearch } from "./components/FecSearch";
import { CorporationSearch } from "./components/CorporationSearch";
import { ContextLookup } from "./components/ContextLookup";
import { CorrelationExplorer } from "./components/CorrelationExplorer";
import { StockTradeExplorer } from "./components/StockTradeExplorer";

const MAIN_TABS = [
  { id: "members", label: "Members" },
  { id: "bills", label: "Bills & Votes" },
  { id: "money", label: "Campaign Money" },
  { id: "corporations", label: "Corporations" },
] as const;

const EXPERIMENTAL_TABS = [
  { id: "correlations", label: "Correlations" },
  { id: "trades", label: "Stock Trades" },
] as const;

type MainTabId = (typeof MAIN_TABS)[number]["id"] | "context";
type ExperimentalTabId = (typeof EXPERIMENTAL_TABS)[number]["id"];
type Theme = "dark" | "light";
type RouteState =
  | { page: "main"; tab: MainTabId }
  | { page: "experimental"; tab: ExperimentalTabId };

const THEME_STORAGE_KEY = "goon-bridge-theme";

function getRouteState(pathname: string): RouteState {
  if (pathname === "/experimental/trades") {
    return { page: "experimental", tab: "trades" };
  }

  if (pathname === "/experimental" || pathname === "/experimental/correlations") {
    return { page: "experimental", tab: "correlations" };
  }

  return { page: "main", tab: "members" };
}

function getPathForRoute(route: RouteState): string {
  if (route.page === "experimental") {
    return route.tab === "trades" ? "/experimental/trades" : "/experimental/correlations";
  }

  return "/";
}

export default function App() {
  const [route, setRoute] = useState<RouteState>(() => {
    if (typeof window === "undefined") {
      return { page: "main", tab: "members" };
    }

    return getRouteState(window.location.pathname);
  });
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof window === "undefined") {
      return "light";
    }

    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "dark" ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return undefined;
    }

    const handlePopState = () => {
      setRoute(getRouteState(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigateTo = (nextRoute: RouteState) => {
    const nextPath = getPathForRoute(nextRoute);
    if (typeof window !== "undefined" && window.location.pathname !== nextPath) {
      window.history.pushState({}, "", nextPath);
    }
    setRoute(nextRoute);
  };

  const isExperimental = route.page === "experimental";

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b border-vibe-border sticky top-0 z-50 bg-vibe-bg/95 backdrop-blur">
        <div className="max-w-6xl mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-bold tracking-tight">
                <span className="text-vibe-accent">CONGRESS</span>{" "}
                <span className="text-vibe-dim">VIBE CHECK</span>
              </h1>
              <span className="badge bg-vibe-accent/20 text-vibe-accent text-[10px] uppercase tracking-widest">
                Phase 2
              </span>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={isExperimental ? "/" : "/experimental/correlations"}
                onClick={(event) => {
                  event.preventDefault();
                  navigateTo(
                    isExperimental ? { page: "main", tab: "members" } : { page: "experimental", tab: "correlations" },
                  );
                }}
                className="rounded-full border border-vibe-border bg-vibe-surface/80 px-3 py-1 text-[11px] uppercase tracking-[0.22em] text-vibe-dim transition-colors hover:text-vibe-text"
              >
                {isExperimental ? "Main Site" : "Experimental"}
              </a>
              <label className="inline-flex items-center gap-2 rounded-full border border-vibe-border bg-vibe-surface/80 px-2 py-1 text-[11px] uppercase tracking-[0.22em] text-vibe-dim">
                <span className={theme === "light" ? "text-vibe-accent" : ""}>Light</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={theme === "light"}
                  aria-label="Toggle light theme"
                  onClick={() => setTheme((currentTheme) => (currentTheme === "light" ? "dark" : "light"))}
                  className={`relative h-5 w-9 rounded-full border transition-colors ${
                    theme === "light"
                      ? "border-vibe-accent/40 bg-vibe-accent/90"
                      : "border-vibe-border bg-vibe-bg"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                      theme === "light" ? "translate-x-[18px]" : "translate-x-0.5"
                    }`}
                  />
                </button>
              </label>
              <HealthCheck />
            </div>
          </div>
        </div>
      </header>

      {/* Tab navigation */}
      <nav className="border-b border-vibe-border bg-vibe-surface/50">
        <div className="max-w-6xl mx-auto px-4">
          <div className="flex gap-1 overflow-x-auto">
            {(isExperimental ? EXPERIMENTAL_TABS : MAIN_TABS).map((tab) => (
              <button
                key={tab.id}
                onClick={() =>
                  navigateTo(
                    isExperimental
                      ? { page: "experimental", tab: tab.id as ExperimentalTabId }
                      : { page: "main", tab: tab.id as MainTabId },
                  )
                }
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                  route.tab === tab.id
                    ? "border-vibe-accent text-vibe-accent"
                    : "border-transparent text-vibe-dim hover:text-vibe-text"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {route.page === "experimental" && (
          <div className="mb-6 rounded-2xl border border-vibe-accent/25 bg-vibe-accent/8 px-4 py-3 text-sm text-vibe-dim">
            Experimental features may be incomplete and the underlying data may be partial, delayed, or incorrect.
          </div>
        )}
        {route.page === "main" && route.tab === "members" && <MemberSearch />}
        {route.page === "main" && route.tab === "bills" && <BillSearch />}
        {route.page === "main" && route.tab === "money" && <FecSearch />}
        {route.page === "main" && route.tab === "corporations" && <CorporationSearch />}
        {route.page === "main" && route.tab === "context" && <ContextLookup />}
        {route.page === "experimental" && route.tab === "correlations" && <CorrelationExplorer />}
        {route.page === "experimental" && route.tab === "trades" && <StockTradeExplorer />}
      </main>

      {/* Footer */}
      <footer className="border-t border-vibe-border mt-auto">
        <div className="max-w-6xl mx-auto px-4 py-4 text-center text-xs text-vibe-dim">
          Correlation does not equal causation. Probably.
        </div>
      </footer>
    </div>
  );
}
