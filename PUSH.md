# Getting this on GitHub

The repo is **already committed locally** — 16 files, one commit, 15 passing tests.
Nothing left to write. You just need to choose how to get it up there.

---

## Path A — I push it for you (fastest)

If you'd rather not touch a terminal, paste a GitHub token in the chat and I'll create the
repo and push it. Two things to know first:

1. **A token is a password.** It will be visible in this conversation. Create a **fine-grained
   token** scoped to just this job (see below), and **revoke it the moment the push succeeds** —
   GitHub → Settings → Developer settings → Personal access tokens → revoke.
2. **Never paste a token that has broader access than this needs.** No classic full-scope
   tokens, no org-admin tokens, nothing you use elsewhere.

**What to create:** https://github.com/settings/tokens?type=beta → *Generate new token* →
Repository access: *All repositories* (or just the one) → Permissions:
- **Contents: Read and write** — required to push
- **Administration: Read and write** — only needed for me to create the repo; if you create the
  empty repo yourself first, you can leave this off

Then send me:
- the token
- the repo name (`yourname/insureflow-lead-agent`)
- public or private

I'll run `push-to-github.sh`, verify the remote commit matches local, and tell you when to
revoke. **Revoke it right after** — I don't need it again, and the repo will already be on
GitHub.

---

## Path B — you push it yourself (5 commands)

Run these in the repo folder. **Use the sandbox push script, not your own machine** if you want
the exact commit I built — or clone from wherever you've saved `index.html`.

```bash
cd insureflow-agent

# 1. create an empty repo on GitHub first (no README, no .gitignore — you have both)
#    https://github.com/new  →  name it, set visibility, click Create

# 2. point the local repo at it
git remote set-url origin https://github.com/YOURNAME/insureflow-lead-agent.git

# 3. confirm what you're about to push
git log --oneline
git status

# 4. push
git push -u origin main
```

If GitHub asks for a password, it wants a **token**, not your account password — same token
setup as Path A, or use the [GitHub CLI](https://cli.github.com):

```bash
gh auth login
gh repo create insureflow-lead-agent --private --source=. --push
```

---

## Path C — no git at all (drag and drop)

Works, with one caveat: you lose the commit history and will upload file-by-file.

1. Create an empty repo at https://github.com/new
2. Click **uploading an existing file**
3. Drag in: `index.html`, `agent-instructions.md`, `knowledge-base.md`, `server-example.js`,
   `crm-schema.sql`, `voice-script.md`, `sales-assets.md`, `roadmap-7-day.md`, `README.md`,
   `LICENSE`, `package.json`, `.env.example`
4. Commit

You'll need to create the `tests/` and `.github/workflows/` folders manually (GitHub's web UI
can't upload folders) — or just skip them and add them later. **Do not skip `.gitignore`**; it's
what keeps customer data and API keys out of the repo.

---

## Before you make it public — read this

The build is genuinely useful to show people, but a few things in it are yours, not the world's:

| File | Why it matters | What to do |
|---|---|---|
| `voice-script.md` | Your pricing tiers, objection handling, and positioning. This is your commercial playbook. | **Keep private**, or strip the pricing table before publishing |
| `sales-assets.md` | Prospect tiers and the payback table — an interested competitor could lift it wholesale | Consider private |
| `knowledge-base.md` | Real appetite, carriers, and licensing once you fill in the `[[ ]]` fields | **Never public** with real carrier data filled in |
| `roadmap-7-day.md` | Harmless, but it's your game plan | Your call |
| Code (`index.html`, `server-example.js`, `crm-schema.sql`, `tests/`) | Genuinely worth showing — it's the proof you can build | Public is fine, and a good portfolio piece |

**My recommendation:** start **private**. Turn it public later, after you've removed the pricing
and prospect sections, once you have a customer and something to point at. A public repo with
your exact pricing in it is a negotiating disadvantage on every future call.

---

## What happens after the first push

The CI workflow at `.github/workflows/test.yml` runs on every push. It will:

- run the 15 tests (`node --test tests/`)
- syntax-check the server
- verify the `@agent-core` markers still exist in `index.html` (the tests depend on them)
- **fail the build if `.env` or anything resembling a live API key or webhook URL gets committed**

That last check is the one that matters. You will have a moment — probably around client three —
where you're moving fast and paste a webhook URL into the wrong file. This catches it before it
becomes a breach notification.
