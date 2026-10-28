import { emailOTPClient, oneTapClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Browser auth client. Email OTP is always enabled; Google One Tap is enabled when a Google client ID is configured.

export function createSiteAuthClient(options: { googleClientId?: string | null } = {}) {
  return createAuthClient({
    plugins: [
      emailOTPClient(),
      ...(options.googleClientId
        ? [oneTapClient({ clientId: options.googleClientId, promptOptions: { maxAttempts: 1 } })]
        : []),
    ],
  });
}

export type SiteAuthClient = ReturnType<typeof createSiteAuthClient>;
