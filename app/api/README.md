# API

Route handlers live here. They query Drizzle directly — there is no repository or
service layer until a second consumer appears (see `CLAUDE.md` §2).

Every request and response is parsed with the same Zod schema the model output uses.
