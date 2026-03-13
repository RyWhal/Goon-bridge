import { useEffect, useState } from "react";
import { HealthCheck } from "./components/HealthCheck";
import { MemberSearch } from "./components/MemberSearch";
import { BillSearch } from "./components/BillSearch";
import { FecSearch } from "./components/FecSearch";
import { CorporationSearch } from "./components/CorporationSearch";
import { ContextLookup } from "./components/ContextLookup";

const TABS = [
  { id: "members", label: "Members" },
  { id: "bills", label: "Bills & Votes" },
  { id: "money", label: "Campaign Money" },
  { id: "corporations", label: "Corporations" },
] as const;

type TabId = (typeof TABS)[number]["id"] | "context";
type Theme = "dark" | "light";

const THEME_STORAGE_KEY = "goon-bridge-theme";

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("members");
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
                Phase 1
              </span>
            </div>
            <div className="flex items-center gap-3">
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
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
                  activeTab === tab.id
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
        {activeTab === "members" && <MemberSearch />}
        {activeTab === "bills" && <BillSearch />}
        {activeTab === "money" && <FecSearch />}
        {activeTab === "corporations" && <CorporationSearch />}
        {activeTab === "context" && <ContextLookup />}
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
