# GhostBranch (The Plain-English Guide)

> **Think of GhostBranch as a video game quick-save and "Ctrl+Z" button for AI coding agents.**

If you build apps using tools like **Claude Code, Cursor, Aider, or ChatGPT**, you already know the sinking feeling: you ask the AI to make a small change, and five minutes later your site won't start, your files are scrambled, and your API keys are gone.

You don't need to be a terminal wizard or a Git expert to use GhostBranch. This guide explains what it does, why it exists, and how to use it in plain language.

---

## 🛑 The Problem: AIs Are Messy Roommates

When an AI writes code on your computer, it doesn't just edit text files. It can run commands in your terminal. 

Sometimes, the AI:
1. **Accidentally deletes your `.env` file** — where you keep your private OpenAI keys, Stripe passwords, and database links. (Because Git ignores `.env` files by default, once deleted, regular Git can never bring it back).
2. **Goes down a hallucination spiral** — changing 20 files at once until nothing compiles, leaving you with no idea what it touched.
3. **Runs dangerous terminal commands** — like `rm -rf` or overwriting important folders.

If you don't know advanced Git commands like `git reflog`, `git reset --hard`, or `git checkout -b`, trying to recover your work is terrifying. One wrong command and your code is gone for good.

---

## 🛡️ What GhostBranch Does

GhostBranch acts like an **uncrashable black box flight recorder** running silently in the background while your AI works.

```
       AI makes a change (3:01 PM)  ───► GhostBranch automatically saves a checkpoint
       AI makes a change (3:02 PM)  ───► GhostBranch automatically saves a checkpoint
       AI deletes your .env (3:03 PM) ───► 💥 DISASTER!
                                                │
                                    Type: ghostbranch undo 1
                                                ▼
       Everything restored to 3:02 PM in 12 milliseconds! ✨
```

* **Instant Undo:** Type `ghostbranch undo 1` and your whole project jumps back to before the AI made its mistake.
* **Saves What Git Forgets:** It automatically protects your `.env` files, local settings, and SQLite databases using industry-standard Zstandard compression.
* **Persistent & Safe:** GhostBranch stores your recovery checkpoints safely in your computer's persistent Application Support directory—so computer cleanup tools will never accidentally delete your backups.
* **Visual Time Machine:** Type `ghostbranch ui` to open an interactive timeline, or use the native VSCode extension to see changes directly inside your editor.
* **Zero Fear:** GhostBranch never messes up your real Git history or deletes your branches. It's completely non-destructive.

---

## 🚀 How to Use GhostBranch in 3 Steps

### Step 1: Install
Download the binary for your operating system or install with Cargo:
```bash
cargo install --path .
```

### Step 2: Wrap Your Agent
Instead of running your AI tool directly, put `ghostbranch run` in front of it:
```bash
ghostbranch run claude
ghostbranch run aider
```

### Step 3: Undo If Disaster Strikes
If the AI breaks your code, open a new terminal window in your project folder and type:
```bash
ghostbranch undo 1
```
Boom! Your code and `.env` files are restored to exactly how they looked before the AI made its mistake.

---

## 📄 Summary Comparison

| Feature | Regular Git | GhostBranch |
| :--- | :--- | :--- |
| **Protects `.env` files?** | ❌ No (Git ignores them) | ✅ Yes (Automatic persistent CAS) |
| **Undo without moving HEAD?** | ❌ Difficult | ✅ Instant (`ghostbranch undo 1`) |
| **Survives `rm -rf .git`?** | ❌ Everything is lost | ✅ Fully survives & restores |
| **Works with Claude / Cursor?** | ❌ Manual commits required | ✅ 100% automated |
| **IDE Timeline Integration?** | ❌ Requires git extensions | ✅ Native VSCode Extension |

---

MIT License. Built for high-assurance autonomous coding.
