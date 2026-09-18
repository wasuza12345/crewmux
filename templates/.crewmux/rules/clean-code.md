# Clean code — default rules

Generic rules for any project. A project can add its own rules file in `roles.yaml` → `clean-code.rules`.

1. **Match the surrounding code.** Naming, idioms, comment density and file layout follow what already exists.
2. **One responsibility per unit.** A function does one thing; a file holds one concept. Split when a name needs "and".
3. **No duplication of knowledge.** A type, schema, constant or rule is defined in exactly one place and imported everywhere else.
4. **Validate at the boundary, trust inside.** Parse external input (files, network, user, LLM output) once at the edge; inner code uses typed values.
5. **Separate decisions from IO.** Logic that decides (what to run, whether to allow) is pure and testable; IO lives at the edges.
6. **Errors are never swallowed.** Either handle with a concrete fallback or propagate with context (what failed, which id).
7. **No secrets** in code, config, logs, fixtures or error messages.
8. **Names say what, comments say why.** Delete comments that restate the code; keep ones that explain a non-obvious reason.
9. **Small diffs.** No drive-by refactors, reformatting or dead code in a change.
10. **New behavior has a test** that fails without the change.
