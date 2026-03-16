export type Env = {
  Bindings: {
    CONGRESS_API_KEY: string;
    OPENFEC_API_KEY: string;
    FINNHUB_API_KEY: string;
    SUPABASE_URL: string;
    SUPABASE_SERVICE_KEY: string;
    ADMIN_API_KEY?: string;  // bearer token for admin/mutation endpoints
    ALLOWED_ORIGINS: string; // comma-separated list, e.g. "https://congressional-vibes.rjpw.space"
    ENVIRONMENT: string;     // "production" | "staging" | "development"
    CF_VERSION_METADATA?: {
      id: string;
      tag?: string;
      timestamp: string;
    };
  };
};
