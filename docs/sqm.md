# Software & Technology SQM builder

The builder implements all 42 topics from the supplied curriculum, using Aion's
bundled ECC corpus. It performs local lexical retrieval with title and rarity
weighting, returns full skill bodies and source paths, and explicitly reports
missing matches. It does not fabricate lessons, claim exhaustive topic coverage,
or call a paid model. Review matches before adopting them as a learning plan.

Run from the Aion-Brain directory:

```bash
npm run sqm -- --list-topics
node bin/sqm.mjs --topic OSINT --topic OPSEC -o security_sqm.md
node bin/sqm.mjs --topic GitHub --topic "Linux Administration" --topic DigitalOcean
node bin/sqm.mjs --format json -o sqm.json
python3 sqm_builder.py --topic Python -o python_sqm.md
```

Omitting `--topic` builds all 42 sections. JSON and Markdown use the same
implementation as the backend. The Python entry point invokes that implementation
without shell interpolation; Node.js 18+ is required. It replaces the attachment's
unconnected Python search stub rather than maintaining two separate builders.

Authenticated API endpoints (same `X-AION-Key` as `/api/chat`):

- `GET /api/sqm/topics`: available topic names and queries.
- `POST /api/dev/search`: `{ "query": "Python", "category": "education", "limit": 6 }`.
  Returns `{ retrieval, corpus, count, matches }` with title, summary, body and source.
- `POST /api/sqm`: `{ "topics": ["Python", "GitHub"], "limit": 6, "format": "json" }`.
  Omit topics for the full curriculum; format can also be `markdown`.

Claw's `aion_curriculum` tool calls this API and saves the complete document in its
file panel. The chat receives a summary rather than a truncated curriculum.

The existing corpus loader now reads exact ECC bundle file boundaries, preserving
nested headings and titles that differ from catalog slugs. Tests check all 286
bodies, actual retrieval, validation, exports and authentication of all new routes.
