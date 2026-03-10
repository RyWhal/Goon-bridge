import { useState } from "react";

interface JsonViewerProps {
  data: unknown;
  label?: string;
}

export function JsonViewer({ data, label = "Raw JSON" }: JsonViewerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-3 border-t border-vibe-border pt-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-vibe-dim hover:text-vibe-accent transition-colors"
      >
        {expanded ? "Hide" : "Show"} {label}
      </button>
      {expanded && (
        <pre className="mt-2 p-3 bg-vibe-bg rounded-md text-xs text-vibe-dim overflow-x-auto max-h-96 overflow-y-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}
