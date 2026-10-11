# Omp transcript fixtures

These are hand-trimmed entry templates from local omp session JSONL files, not copies of complete sessions. Original field names, nesting, numeric metadata, optional fields, and content-block shapes are retained. Free-form strings, paths, titles, model labels, signatures, timestamps, and identifiers are replaced with neutral examples. Message content is intentionally unrelated to its source subject matter. Source sessions are not identified here to avoid exposing private workspace names.

Except for the branching example, entries selected from multiple sessions are stitched into a linear tree with fresh identifiers and matching tool-call references. The session header and title metadata are retained; title metadata has no tree identifiers in the original format.

| File | Exercises | Synthetic parts |
| --- | --- | --- |
| `basic-chat.jsonl` | User text followed by assistant thinking and visible text. | Neutral content, header/model metadata, identifiers, linear links. |
| `tool-roundtrip.jsonl` | Read, bash, edit, and grep calls with matching results, then final assistant text. Edit result includes the original `details.diff` field shape. | Selected real call/result pairs stitched together; neutral arguments, outputs, and example diff. |
| `running-tool.jsonl` | Assistant call followed by `custom` / `tool_execution_start`, without a result. | Neutral bash call and matching start identifier; deliberately unfinished transcript. |
| `image-result.jsonl` | Read result with text and image blocks. | Image data replaced with a valid generated 1×1 RGBA PNG; surrounding descriptive strings replaced. Original numeric result metadata remains illustrative, not a description of the tiny replacement image. |
| `context-events.jsonl` | Compaction, reset boundary, model change, and mode change between messages. | Events stitched from real entries; neutral summaries and provider labels; retained-entry reference rewritten. |
| `branch.jsonl` | Two user-message children sharing one assistant parent. | A real duplicate-parent example was found. Its three-entry topology is preserved, with neutral content and remapped identifiers; preceding header/model entries are stitched in. No duplicate-parent relationship was invented. |
| `big-output.jsonl` | A tool result with 215,040 bytes (210 KiB) of text for truncation behavior. | A short real output-line template is replaced with neutral text and repeated 10,240 times. |
| `torn-tail.jsonl` | Complete entries followed by an incomplete final JSON object with no newline. | Appended truncated assistant-message prefix. |

Run `bun bridge/fixtures/omp/scrub-check.ts` from the repository root. The check scans all fixture JSONL files and this README for prohibited patterns, restricts long encoded payloads to the image fixture, and verifies line counts and JSON validity (allowing only the deliberately torn final line).
