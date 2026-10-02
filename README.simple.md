# AgentVault (The Plain-English Guide)

> **Think of AgentVault as a video game quick-save and "Ctrl+Z" button for AI coding agents.**

If you build apps using tools like **Claude Code, Cursor, Aider, or ChatGPT**, you already know the sinking feeling: you ask the AI to make a small change, and five minutes later your site won't start, your files are scrambled, and your API keys are gone.

You don't need to be a terminal wizard or a Git expert to use AgentVault. This guide explains what it does, why it exists, and how to use it in plain language.

---

## 🛑 The Problem: AIs Are Messy Roommates

When an AI writes code on your computer, it doesn't just edit text files. It can run commands in your terminal. 

Sometimes, the AI:
1. **Accidentally deletes your `.env` file** — where you keep your private OpenAI keys, Stripe passwords, and database links. (Because Git ignores `.env` files by default, once deleted, regular Git can never bring it back).
2. **Goes down a hallucination spiral** — changing 20 files at once until nothing compiles, leaving you with no idea what it touched.
3. **Runs dangerous terminal commands** — like `rm -rf` or overwriting important folders.

If you don't know advanced Git commands like `git reflog`, `git reset --hard`, or `git checkout -b`, trying to recover your work is terrifying. One wrong command and your code is gone for good.

---

## 🛡️ What AgentVault Does

AgentVault acts like an **uncrashable black box flight recorder** running silently in the background while your AI works.

```
       AI makes a change (3:01 PM)  ───► AgentVault automatically saves a checkpoint
       AI makes a change (3:02 PM)  ───► AgentVault automatically saves a checkpoint
       AI deletes your .env (3:03 PM) ───► 💥 DISASTER!
                                                │
                                    Type: agentvault undo 1
                                                ▼
       Everything restored to 3:02 PM in 12 milliseconds! ✨
```

* **Instant Undo:** Type `agentvault undo 1` and your whole project jumps back to before the AI made its mistake.
* **Saves What Git Forgets:** It automatically protects your `.env` files, local settings, and SQLite databases using industry-standard Zstandard streaming compression.
* **Persistent & Safe:** AgentVault stores your recovery checkpoints safely in your computer's persistent Application Support directory—so computer cleanup tools will never accidentally delete your backups.
* **Visual Time Machine:** Type `agentvault ui` to open an interactive timeline, or use the native VSCode extension to see changes directly inside your editor.
* **Zero Fear:** AgentVault never messes up your real Git history or deletes your branches. It's completely non-destructive.

---

## 🚀 How to Use AgentVault in 3 Steps

### Step 1: Install
Download the binary for your operating system or install with Cargo:
```bash
cargo install --path .
```

### Step 2: Wrap Your Agent
Instead of running your AI tool directly, put `agentvault run` in front of it:
```bash
agentvault run claude
agentvault run aider
```

AgentVault starts immediately, opens a protected terminal, and begins flight recording.

### Step 3: Undo When Things Go Wrong
If the AI makes a mess:
```bash
agentvault undo 1
```

Want to jump back 3 steps?
```bash
agentvault undo 3
```

Or open the timeline inside VSCode, right-click any checkpoint, and click **Restore**.

---

## 🔒 What Makes AgentVault Different?

| Normal Git | AgentVault |
|---|---|
| Forgets `.env` files completely | Backs up `.env` files in encrypted/compressed storage |
| Moves your active branch (`HEAD`) | Never touches your active branch |
| Confusing `git reflog` commands | One command: `agentvault undo 1` |
| Disposable `/tmp` or `.cache` storage | Rock-solid persistent Application Support storage |
| Manual commits | Zero-overhead, 15ms background flight recording |
