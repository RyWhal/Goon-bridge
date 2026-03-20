export const MAIN_TABS = [
  { id: "members", label: "Members" },
  { id: "bills", label: "Bills & Votes" },
  { id: "money", label: "Campaign Money" },
  { id: "corporations", label: "Corporations" },
  { id: "trades", label: "Stock Trades" },
] as const;

export const EXPERIMENTAL_TABS = [
  { id: "correlations", label: "Correlations" },
  { id: "policy-maps", label: "Policy Maps" },
] as const;

export type MainTabId = (typeof MAIN_TABS)[number]["id"];
export type ExperimentalTabId = (typeof EXPERIMENTAL_TABS)[number]["id"];

export type RouteState =
  | { page: "main"; tab: MainTabId }
  | { page: "experimental"; tab: ExperimentalTabId }
  | { page: "admin" };

export function getRouteState(pathname: string): RouteState {
  if (pathname === "/admin") {
    return { page: "admin" };
  }

  if (pathname === "/experimental" || pathname === "/experimental/correlations") {
    return { page: "experimental", tab: "correlations" };
  }

  if (pathname === "/experimental/policy-maps") {
    return { page: "experimental", tab: "policy-maps" };
  }

  return { page: "main", tab: "members" };
}

export function getPathForRoute(route: RouteState): string {
  if (route.page === "admin") {
    return "/admin";
  }

  if (route.page === "experimental") {
    if (route.tab === "policy-maps") {
      return "/experimental/policy-maps";
    }

    return "/experimental/correlations";
  }

  return "/";
}
