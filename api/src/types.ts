export type Env = {
  Bindings: {
    CONGRESS_API_KEY: string;
    OPENFEC_API_KEY: string;
    ALLOWED_ORIGINS: string; // comma-separated list, e.g. "https://congressional-vibes.rjpw.space"
    ENVIRONMENT: string;     // "production" | "staging" | "development"
  };
};
