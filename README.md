# Receipts Tower

[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

A tower of AI-run companies for [quest #17999](https://github.com/pollinations/pollinations/issues/17999). Every floor is one small (fictional) company. Three Pollinations agents, a researcher, a writer and a reviewer, do a job for it and hand the owner one decision. Every job comes with a **receipt** of what it cost in Pollen.

## What you can do

- Turn the 3D tower, pick a floor (or use the keyboard list) and read what the company does.
- **Without signing in:** play a *recorded run*. The outputs are real replies from the three agents, saved on 2026-11-02 and labelled as recordings.
- **Connect your Pollen** (device-flow sign-in) and run the same job live on your own balance. The key stays in this tab's `sessionStorage`.
- Decide as the owner: **Approve**, **Hold**, or **Request revision** with a note. A revision re-runs the writer and the reviewer with your note, as a second set of steps on the receipt.
- Apply to rent Floor 6: the application is kept in the browser and downloaded as a JSON file; nothing is uploaded.

## How the agents are used

`data/agents.json` holds the three role agents (`tower-researcher`, `tower-writer`, `tower-reviewer`): prompt agents on `openai/gpt-5.4-mini`, created with `POST /account/agents`. The app calls them as `community/<owner>/<name>` through `POST https://gen.pollinations.ai/v1/chat/completions` with the visitor's key (`lib/pollen.js`). Sign-in is the device flow at `https://enter.pollinations.ai/api/device/code`; the live rates come from `GET https://gen.pollinations.ai/v1/models`.

If an agent is not in the visitor's model list (for example before it has been published), the app calls the base model with the same role prompt and marks the step **stand-in model** on the receipt, so it never pretends.

## The receipt

Each step shows the model called, input and output tokens, and an estimate in Pollen: `tokens × the live per-token rates from /v1/models`, not a price list. For live runs the app also reads your balance before and after and shows the measured difference when your key may read it.

## Run it

Static files, no build step.

```bash
python -m http.server 8765
```

Open http://localhost:8765. Tests (Node 24): `npm test`.

`tools/record.mjs` creates the three private agents and records one job per floor with the owner's key (it reads the key from the `POLLINATIONS_API_KEY` environment variable and never prints it).

## Agent feedback

Things hit while building are filed as separate issues and linked from the quest.
