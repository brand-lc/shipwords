import { proxyRybbit } from '@shipwords/core/analytics';

// Only /stats/* reaches this Worker (run_worker_first); every other path is served straight from static assets.
// RYBBIT_UPSTREAM is a Worker secret, so the collector URL stays out of this public repo.
export default {
  async fetch(request, env) {
    return (await proxyRybbit(request, env.RYBBIT_UPSTREAM)) ?? env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<{ ASSETS: Fetcher; RYBBIT_UPSTREAM?: string }>;
