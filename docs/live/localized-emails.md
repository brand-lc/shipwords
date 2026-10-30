# Localized engine emails

Status: in progress. Fold into `docs/architecture.md` §2 (Email) and §6 (Finish email) once it lands.

The engine sends two emails on a site's behalf: the sign-in code (`core/src/auth/server.ts`) and the job finished/failed notice (`jobs/src/notify.ts`). Both were hard-coded English, so a Japanese or Korean site sent `782180 is your AI作曲 code` to its users, which hurts sign-in conversion and trust.

## Interface change

- No new config field. The email language follows `SiteConfig.defaultLocale`, which every site already sets.
- `core/src/email/copy.ts` holds built-in copy for `en`, `ja` and `ko`; `emailCopy(locale)` matches on the language subtag (`ko-KR` gets Korean) and falls back to English for anything else. Existing English sites send exactly the same emails as before.
- `emailOnFinish` now needs `defaultLocale` as well as `name` from the site (`Pick<SiteConfig, 'name' | 'defaultLocale'>`). The workflow already passes the full site config, so no site changes.

## Why not per-site copy

Copy written in each `site.config.ts` would let sites tune wording, but every site would have to write and keep six templates in sync, and a forgotten field would silently ship English again. Built-in copy per language covers today's sites with zero site changes; add a language here when a site needs one. If a site ever needs its own wording, add an optional override then.

## Not covered

- Per-user language on multi-locale sites: emails use the site's default locale, not the visitor's current one.
- Better Auth's own error messages (e.g. rate-limit text) stay English; sites translate what they show.
