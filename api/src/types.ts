export type Env = {
  Bindings: {
    CONGRESS_API_KEY: string;
    OPENFEC_API_KEY: string;
    ALLOWED_ORIGINS: string; // comma-separated list, e.g. "https://vibe.rjpw.space"
    ENVIRONMENT: string;     // "production" | "staging" | "development"
  };
};
