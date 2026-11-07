---
name: html-review-doc
description: Build a single-file HTML document for review and sign-off in Obsidian, with tabs, per-item comments and approvals stored in a neighbouring <name>.comments.json that is committed to git. Use for "сделай документ как html", "html-документ для обсуждения", "документ со сверкой и комментариями", contracts, specs and API registries that people review item by item.
---

# HTML review document

The result is two files that are committed together:

- `<name>.html`: the document. One file, no build, nothing external.
- `<name>.comments.json`: comments, approvals and the last reviewed state of each item.

The HTML holds the content and the JSON holds the discussion, so a git diff shows what changed in the document separately from what people said about it.

## Structured data: run the generator

For JSON, JSONL, YAML, TOML, CSV, TSV or SQL (CREATE TABLE statements, or a list of `name type` lines), never write the page by hand. Run the generator from this skill's folder:

```sh
node .claude/skills/html-review-doc/build-review.cjs <file> --lang ru
```

It writes `<name>.review.html` next to the file. The same input always gives the same bytes, and rebuilding keeps the comments in `<name>.review.comments.json`; fields that changed are marked as changed. The result is the page with colour-coded keys and field passports described below.

To add what the data cannot say (classes, titles, statuses, owners), write `<name>.fields.yaml` next to the file and rebuild:

```yaml
title: Order response
fields:
  result.total: { class: model, title: Predicted total, status: partly, owner: Data science }
  orders:id: { class: static, title: Order number }
```

Keys are paths, or `table:column` for SQL. The file may also set `groups`, `classes`, `statuses`, `statusLabel` and `attributes`. Fill it in only with what the conversation or the user's sources establish.

In Obsidian the same generator runs from the file menu: **Build review page**.

## Other documents: use the template

1. Ask what the document is and who reviews it, unless the conversation already says. Write it in the language of the conversation.
2. Copy `template.html` from this skill's folder to `<name>.html`. Replace `__DOC_NAME__` with `<name>` and `__TITLE__` with the title.
3. Replace the sample tabs and items with the real content, set `<html lang>`, and translate `LABELS` in the script to the document's language.
4. Check the result: every `data-item` id is unique, and `DOC` matches the file name.
5. Tell the user to open the file in Obsidian. Do not create `<name>.comments.json`: the page writes it on the first comment.

## Content rules

- Each `<section data-tab="Name">` is a tab.
- Each thing to review is one `<article data-item="stable.id">`. Keep it small enough for one person to approve: a field, a rule, a decision.
- Ids are the join with the JSON. Never rename an id when only the text changes, or its comments and approval are orphaned. A new id means a new item.
- Keep generated text stable. Reformatting an item marks it as changed, because the page compares its text with the last reviewed version.
- Do not edit `<name>.comments.json` by hand or from a script unless the user asks: it records what people decided.

## JSON with field passports

For an API contract or any other JSON, put `<div data-json="key">` in a tab and the JSON under `documents.key` in the `contract` script. The page shows the JSON with each key as a chip in the colour of its class, a row of counts per class, **Copy JSON**, and a dot after the value for its status. A click highlights the line and opens the field's passport on the right, with its registry number, title, class, status, attributes and note, and below them the review: comments and approval.

- `classes` are the colours. Unless the user names others, use where the value comes from: data science models, static contract values, dictionaries. Each class has a `group` and may set `color` and `background`.
- `groups` frame the legend, for example what changes on every run, what is static, and the technical layer.
- `statuses` are the dots, each with a `tone` of `ok`, `part` or `no`. `statusLabel` names them, for example "Available now".
- `attributes` are the rows of the passport, for example table, storage, owner.
- `fields`, keyed by path (`result.total`, `items[].id`) or `document:path`, holds what is known: `title`, `class`, `status`, `note`, `number`, `type` and attribute values.

A bare JSON is enough: the page builds a passport for every field from the JSON itself, with its number, path, type and example. Whatever `fields` does not say becomes an empty input or list in the passport, and what people enter is saved in `<name>.comments.json`. So fill in `fields` only with what the conversation or the user's sources establish. Leave the rest empty instead of guessing a class or a title.

Changing a field's type or its `fields` entry marks it as changed. Example values and filled-in passports do not.

## Item states

| State | Meaning |
|---|---|
| new | never reviewed |
| open | reviewed, not approved |
| changed | the text differs from the last reviewed version |
| approved | approved, and the text is the approved version |

**Accept change** on a changed item records the new text as reviewed and clears its approval.

## Hosts

In Obsidian with Claude IDE Bridge, the page reads and saves `<name>.comments.json` over `postMessage` on the `comments` channel, with the operations `ping`, `read` and `write`. Only that one file is reachable. Elsewhere the page falls back to reading the file over HTTP, and **Save** downloads it. **Load** replaces the discussion with a chosen file; in Obsidian that also rewrites the neighbour file.

The day and night switch is kept by the plugin in Obsidian's local storage, so it never reaches git. Outside Obsidian it lasts until the page closes.
