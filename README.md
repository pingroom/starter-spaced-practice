# PingRoom spaced practice

Turn a small learning deck into phone quizzes for one named participant. Each run asks one due card or checks the existing Question. Code compares the answer with the deck's fixed answer key and schedules the next review.

A correct answer schedules review in three days, then seven days for consecutive correct answers. A wrong answer resets the interval to one day. These are editable example rules, not a claim of an optimal learning schedule. The starter executes no runbooks and issues no certifications.

## Try it offline

Requires Node.js 22 or newer on macOS or Linux, with persistent private local storage. Choose **Use this template**, clone your repository, then:

```sh
npm ci
npm test
npm run demo
```

The demo uses the real SDK through an in-memory HTTP transport. It grades a correct answer, advances a fixed clock, then grades an incorrect answer. It needs no credentials, makes no network requests, and deletes its temporary state. Installation needs npm access.

## Connect a participant

```sh
cp examples/deck.json deck.json
cp config.example.json config.json
cp .env.example .env
npm run connect
npm run inspect
```

Install [PingRoom](https://pingroom.io/i), approve the printed pairing link, and select a **standard private room** containing the participant. The participant can be you or another room member. The connection needs `pingroom:questions:ask`, `pingroom:rooms:read`, and that room's grant. Sending permissions and account quotas still apply.

`inspect` reads the selected room's member UUIDs. Verify the intended person in the app and put their exact UUID and a local label in `config.json`. A label is not an identity check.

```json
{
  "participant": {
    "id": "11111111-1111-4111-8111-111111111111",
    "label": "Learner"
  }
}
```

Replace the sample UUID. Pairing credentials stay in ignored `.pingroom/credentials.json`. Interrupted pairing reuses its saved link; an existing connection is not overwritten. After a saved link expires, confirm it is unusable before removing only `.pingroom/pairing.json` and reconnecting.

For an existing connection or unattended run, supply both `PINGROOM_TOKEN` and `PINGROOM_ROOM` in `.env` or the process environment. A complete pair overrides saved credentials; blank or partial overrides fail. Shell values take precedence over `.env`. All files resolve relative to this project, even when launched from another directory.

## Practice and read results

```sh
npm start
# Answer the Question in PingRoom, then check it:
npm start
npm run status
```

The first command returns `pending` after sending. The next command reads that same Question and returns `graded`, its correct/incorrect result, the expected answer label, and its next review time. Feedback appears in the terminal; no separate feedback ping is sent. `status` reads local progress without credentials or network requests.

One invocation handles one attempt. When nothing is active, it selects the earliest due card, breaking ties by card ID. All cards are initially due. Only one Question may be active across the deck, so repeated runs while it is pending send nothing else. The next invocation after grading may ask another due card. There is no automatic catch-up loop or installed scheduler.

Questions remain open for 15 minutes. Poll from your own scheduler while practice is active, or rerun after answering. Each command exits after bounded API requests; it does not wait for the person. An expired, cancelled, invalid, or identity-redacted response is **ungraded**, never incorrect. That card pauses until you explicitly enable another attempt:

```sh
npm run retry -- ATTEMPT_UUID
npm start
```

Use the attempt ID shown by `status` or the result. `retry` only updates local state; the following `start` may send a new Question. Other due cards can be practiced while one is paused.

Intervals are measured from the server's answer timestamp in UTC. The original asker, participant, request, Question ID, creation time, and expiry must match. Answer and resolution timestamps must agree and fall within the Question lifetime. Observed creation and resolution times may be at most 60 seconds ahead of the local clock; synchronize your clock if validation fails. Local time never invents an answer or remote expiration.

Exit codes: `0` graded, not due, local status, or retry ready; `2` expired/cancelled/invalid answer; `3` pending or interrupted; `4` uncertain creation; `1` setup, validation, storage, or API failure. A scheduler should treat `3` as work awaiting a human.

## Recover an uncertain send

The exact request, TTL, correlation ID, participant, and idempotency key are saved before creation. A lost response, failed save, or interrupted creation leaves an unresolved attempt. Reruns do not automatically send it again.

```sh
npm run status
npm run find-id
npm run recover -- QUESTION_UUID
```

`find-id` reads a bounded recent window and prints only candidates matching the saved request. An empty list does not prove that no Question exists. `recover` reads the explicit ID and validates its full request and provenance before attaching it. It may then grade a valid answer or resume pending work. It never creates a Question. Preserve the state while investigating; deleting it can duplicate practice requests.

## Adapt the deck

`examples/deck.json` shows the schema. `deck.json` accepts 1–20 cards, each with a stable ID, a prompt, 2–4 distinct options, and one known correct option value. IDs use lowercase letters, digits, `_`, or `-` and start with a letter, up to 40 characters. Prompts use 1–400 printable ASCII characters; option labels use 1–32. All strings must avoid leading or trailing whitespace. The answer key stays local and is not sent in the Question payload.

Change the sample content before starting. State binds the complete deck, its version, the participant configuration, room, and credential. To change any of them, first resolve active or uncertain attempts, archive the whole private `.practice/` directory, then start a new history with a new deck version. The new history makes every card due; it does not migrate prior learning progress. Keep archived evidence and credentials private.

The deterministic grading and schedule rules are in `src/model.js`; `src/practice.js` handles one durable create/read cycle. Adapt those functions for your learning workflow. Deck content is data, never commands, URLs to fetch, or instructions for an AI model. No AI provider is required.

## Storage and checks

`.practice/state.json` contains requests, outcomes, human IDs, and review history. Updates use a private temporary file, file sync, rename, and directory sync. A lock excludes concurrent commands. After a crash, inspect `.practice/.lock/owner.json`, confirm that process has stopped, and remove only the lock if necessary. Restore corrupt state from a valid backup. This is local file persistence, without a distributed exactly-once guarantee or permanent server idempotency retention.

The starter caps history at 200 attempts, deck input at 64 KiB, configuration at 16 KiB, state at 1 MiB, and HTTP responses at 512 KiB. It reserves response space before sending. Requests have a five-second deadline. POSIX directories use `0700`; files use `0600`. Credentials, active deck/configuration, and practice history are ignored by Git.

SDK **0.6.0** is pinned with a lockfile and a 14-day minimum release age. GitHub Actions checks Node 22 and 24. Tests cover grading, scheduling, pending/terminal outcomes, recovery, request matching, response identity, timestamps, failed writes, bounds, locks, and transport cancellation. All automated checks use mocks; live phone delivery was not tested.

Unlike [data completion](https://github.com/pingroom/starter-data-completion), which asks for missing business information, this starter tests known answers and schedules later retrieval practice.

[Official SDK](https://github.com/pingroom/sdk) · [MIT license](LICENSE)
