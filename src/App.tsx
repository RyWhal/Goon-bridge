import { useState } from "react";
import { HealthCheck } from "./components/HealthCheck";
import { MemberSearch } from "./components/MemberSearch";
import { VoteSearch } from "./components/VoteSearch";
import { BillSearch } from "./components/BillSearch";
import { FecSearch } from "./components/FecSearch";
import { ContextLookup } from "./components/ContextLookup";

const TABS = [
  { id: "members", label: "Members" },
  { id: "votes", label: "Votes" },
  { id: "bills", label: "Bills" },
  { id: "money", label: "Money" },
  { id: "context", label: "Cosmic Context" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("members");

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
            <HealthCheck />
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
        {activeTab === "votes" && <VoteSearch />}
        {activeTab === "bills" && <BillSearch />}
        {activeTab === "money" && <FecSearch />}
        {activeTab === "context" && <ContextLookup />}
      </main>

      {/* Footer */}
      <footer className="border-t border-vibe-border mt-auto">
        <div className="max-w-6xl mx-auto px-4 py-4 text-center text-xs text-vibe-dim">
          Data sourced from Congress.gov, OpenFEC, Open-Meteo, USGS, and the
          literal moon. Correlation does not equal causation. Probably.
        </div>
      </footer>
    </div>
  );
}
